import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { transaction } from './db.js';
import { KeyedLock } from './locks.js';
import type { Logger } from './logger.js';
import { calculateProviderCreditPlan, calculateSettlement, microsToTrx, trxToMicros } from './money.js';
import {
  applyLedgerEntry, createPendingSubscription, enqueueNotification, finishProviderTopUp,
  getActiveSubscriptions, getLatestPrices, getRecentProviderTopUp, getSubscription, getUnresolvedTopUp,
  logAudit, savePriceSnapshot, setSubscriptionStatus, startProviderTopUp, updateProviderSnapshot
} from './repository.js';
import { SohuApiError, SohuClient } from './sohu.js';
import { isValidTronAddress } from './tron.js';
import type { Prices, SmartOrder, Subscription } from './types.js';

export type UserNotification = {text: string;subscriptionId: string};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class AutochargingService {
  private syncRunning = false;
  private deliveryRunning = false;
  private readonly locks = new KeyedLock();

  constructor(private readonly db: Db, private readonly sohu: SohuClient, private readonly config: Config, private readonly logger: Logger) {}

  async currentPrices(): Promise<Prices> {
    const envelope = await this.sohu.getSmartPrice();
    const channel = envelope.data?.high_frequency as Record<string, unknown> | undefined;
    // Do not accidentally bill Pro using the ordinary tariff at the top level.
    const p65 = channel?.['65k_price'] ?? channel?.['65K_price'];
    const p131 = channel?.['131k_price'] ?? channel?.['131K_price'];
    if (p65 == null || p131 == null) throw new Error('Sohu не вернул цены high_frequency; см. provider_http_logs');
    const prices = {price65Micros:trxToMicros(String(p65)),price131Micros:trxToMicros(String(p131))};
    if (prices.price65Micros <= 0n || prices.price131Micros < prices.price65Micros) throw new Error('Некорректные цены Sohu Pro');
    await savePriceSnapshot(this.db, {...prices,raw:envelope});
    return prices;
  }

  private authorize(userId: bigint): void {
    if (userId !== this.config.ALLOWED_USER_ID) throw new Error('Изменять адреса может только владелец');
  }

  private async requireAddress(userId: bigint, id: string): Promise<Subscription> {
    this.authorize(userId);
    const row = await getSubscription(this.db,userId,id);
    if (!row) throw new Error('Адрес удалён или не найден');
    return row;
  }

  async connect(userId: bigint, address: string, initialReserve: bigint, key: string): Promise<Subscription> {
    this.authorize(userId);
    if (!isValidTronAddress(address)) throw new Error('Некорректный TRON-адрес');
    if (initialReserve < 0n) throw new Error('Резерв не может быть отрицательным');
    return this.locks.run('connect:'+address, async () => {
      if ((await this.db.query('SELECT 1 FROM autocharging_subscriptions WHERE tron_address=$1 AND (deleted_at IS NULL OR provider_stop_pending)',[address])).rowCount) {
        throw new Error('Этот адрес уже добавлен или ожидает подтверждения остановки');
      }
      // Fetch prices before creating a new address; a failed price fetch has no provider side effects.
      const prices = await this.currentPrices();
      let row = await createPendingSubscription(this.db,{userId,address,initialReserve,minimumEnergy:this.config.PRO_MIN_ENERGY_72H,key});
      await logAudit(this.db,{actorId:userId,eventType:'subscription.created',entityType:'subscription',entityId:row.id,payload:{address,initial_reserve_micros:initialReserve.toString()}});
      if (initialReserve >= this.nextCharge(prices)) {
        await this.activate(row,prices);
      } else {
        await setSubscriptionStatus(this.db,row.id,'low_balance',null,'Пополните резерв и нажмите «Включить»');
        await enqueueNotification(this.db,row.id,'created:'+row.id,`➕ Адрес добавлен\n${address}\nРезерв: ${microsToTrx(initialReserve)} TRX.\nДля включения нужен резерв хотя бы ${microsToTrx(this.nextCharge(prices))} TRX.`);
      }
      row = (await getSubscription(this.db,userId,row.id))!;
      await this.warnLowReserve(row,prices);
      return row;
    });
  }

  private nextCharge(prices: Prices): bigint {
    return prices.price131Micros + trxToMicros(this.config.SERVICE_FEE_TRX);
  }

  private async activate(row: Subscription, prices: Prices): Promise<void> {
    const balance = BigInt(row.reserve_balance_micros);
    const available = balance - trxToMicros(this.config.SERVICE_FEE_TRX);
    const target = trxToMicros(this.config.SOHU_INITIAL_CREDIT_TRX);
    const configured = target < prices.price131Micros ? prices.price131Micros : target;
    const credit = configured < available ? configured : available;
    if (credit < prices.price131Micros) throw new Error('Пополните резерв для первой выдачи энергии');
    try {
      await this.captureBaseline(row);
      const response = await this.sohu.delegateEnergy({address:row.tron_address,balanceTrx:microsToTrx(credit)});
      if (response.data.address !== row.tron_address) throw new Error('Sohu вернул другой адрес');
      await updateProviderSnapshot(this.db,row.id,trxToMicros(response.data.balance),response.data.status);
      await this.db.query('UPDATE autocharging_subscriptions SET provider_connected=true WHERE id=$1',[row.id]);
      await setSubscriptionStatus(this.db,row.id,response.data.status==='start'?'active':'paused',response.data.status);
      await enqueueNotification(this.db,row.id,'connected:'+row.id,`✅ Автозаряд Pro подключён\n${row.tron_address}\nРезерв адреса: ${microsToTrx(balance)} TRX.\nЗалог Sohu: 0 TRX.`);
    } catch (error) {
      await setSubscriptionStatus(this.db,row.id,'error',row.souhu_status,errorText(error));
      await logAudit(this.db,{eventType:'subscription.connect.failed',entityType:'subscription',entityId:row.id,payload:{error:errorText(error)}});
      await enqueueNotification(this.db,row.id,'connect-error:'+row.id,`❌ Подключение адреса не подтверждено\n${row.tron_address}\n${errorText(error)}\nРезерв сохранён. Перед повторным подключением нужна сверка с Sohu.`);
      throw new Error('Sohu не подтвердил подключение. Адрес и резерв сохранены; требуется сверка по журналу.');
    }
  }

  async addReserve(userId: bigint, id: string, amount: bigint, key: string): Promise<void> {
    this.authorize(userId);
    if (amount <= 0n) throw new Error('Введите сумму больше нуля');
    await this.locks.run(id, async () => {
      const row = await this.requireAddress(userId,id);
      await transaction(this.db,async (client) => {
        const current = await getSubscription(client,userId,id,true);
        if (!current) throw new Error('Адрес удалён');
        const result = await applyLedgerEntry(client,{userId,subscriptionId:id,kind:'reserve_topup',amountMicros:amount,idempotencyKey:key,description:'Пополнение виртуального резерва'});
        if (result.applied) {
          await enqueueNotification(client,id,key+':notification',`💰 Резерв пополнен\n${row.tron_address}\nДобавлено: ${microsToTrx(amount)} TRX.\nОстаток: ${microsToTrx(result.balanceAfterMicros)} TRX.${row.status==='active'?'':'\nДля запуска нажмите «Включить» в карточке адреса.'}`);
          await logAudit(client,{actorId:userId,eventType:'reserve.topup',entityType:'subscription',entityId:id,payload:{amount_micros:amount.toString()}});
        }
      });
      const prices = await getLatestPrices(this.db);
      if (prices) await this.warnLowReserve((await getSubscription(this.db,userId,id))!,prices);
    });
  }

  async changeState(userId: bigint, id: string, action: 'pause'|'resume'|'disable'): Promise<void> {
    this.authorize(userId);
    await this.locks.run(id,async () => {
      let row = await this.requireAddress(userId,id);
      if (action==='resume') {
        if (row.status==='active') return;
        if (row.status==='pending'||row.status==='error') throw new Error('Результат подключения требует сверки по журналу Sohu');
        if (await getUnresolvedTopUp(this.db,id)) throw new Error('Есть неподтверждённое пополнение Sohu; сначала нужна сверка');
        const prices = await this.currentPrices();
        if (BigInt(row.reserve_balance_micros) < this.nextCharge(prices)) throw new Error(`Для включения нужно хотя бы ${microsToTrx(this.nextCharge(prices))} TRX`);
        if (!row.provider_connected) {
          await this.activate(row,prices);
          return;
        }
        const snapshot = await this.sohu.queryEnergy(row.tron_address);
        await updateProviderSnapshot(this.db,id,trxToMicros(snapshot.data.balance),snapshot.data.status);
        row = (await getSubscription(this.db,userId,id))!;
        if (!await this.ensureProviderCredit(row,trxToMicros(snapshot.data.balance),prices)) throw new Error('Кредит Sohu не готов; причина указана в уведомлении');
        // Funding can itself start Sohu. Avoid an already-started 409 on resume.
        const latest = await this.sohu.queryEnergy(row.tron_address);
        const response = latest.data.status==='start' ? latest : await this.sohu.updateEnergy(row.tron_address,'start');
        if (response.data.status!=='start') throw new Error('Sohu не подтвердил запуск');
        await updateProviderSnapshot(this.db,id,trxToMicros(response.data.balance),'start');
        await setSubscriptionStatus(this.db,id,'active','start');
      } else {
        if (row.provider_connected || row.status==='error' || row.status==='pending') await this.stopProvider(row);
        await setSubscriptionStatus(this.db,id,action==='pause'?'paused':'disabled','stop');
      }
      await logAudit(this.db,{actorId:userId,eventType:'subscription.'+action,entityType:'subscription',entityId:id});
      await enqueueNotification(this.db,id,randomUUID(),`${action==='resume'?'▶️':action==='pause'?'⏸':'⛔'} Автозаряд ${action==='resume'?'включён':action==='pause'?'на паузе':'отключён'}\n${row.tron_address}`);
    });
  }

  async remove(userId: bigint, id: string): Promise<void> {
    this.authorize(userId);
    await this.locks.run(id,async () => {
      const row = await this.requireAddress(userId,id);
      if (row.provider_connected || row.status==='error'||row.status==='pending') await this.stopProvider(row);
      await transaction(this.db,async (client) => {
        await client.query("UPDATE autocharging_subscriptions SET deleted_at=now(),status='disabled',souhu_status='stop',provider_stop_pending=false,updated_at=now() WHERE id=$1",[id]);
        await logAudit(client,{actorId:userId,eventType:'subscription.deleted_from_list',entityType:'subscription',entityId:id});
        await enqueueNotification(client,id,'deleted:'+id,`🗑 Адрес удалён из списка\n${row.tron_address}`);
      });
    });
  }

  private async stopProvider(row: Subscription): Promise<void> {
    try {
      const snapshot = await this.sohu.queryEnergy(row.tron_address);
      if (snapshot.data.address!==row.tron_address) throw new Error('Sohu вернул другой адрес');
      await updateProviderSnapshot(this.db,row.id,trxToMicros(snapshot.data.balance),snapshot.data.status);
      await this.db.query('UPDATE autocharging_subscriptions SET provider_connected=true WHERE id=$1',[row.id]);
      if (snapshot.data.status!=='stop') {
        const response = await this.sohu.updateEnergy(row.tron_address,'stop');
        if (response.data.status!=='stop') throw new Error('Sohu не подтвердил остановку');
      }
    } catch (error) {
      if (!(error instanceof SohuApiError && error.status===404)) throw error;
      await this.db.query('UPDATE autocharging_subscriptions SET provider_connected=false WHERE id=$1',[row.id]);
    }
  }

  private async captureBaseline(row: Subscription): Promise<void> {
    let page=1,pages=1;
    do {
      let response;
      try { response=await this.sohu.queryEnergy(row.tron_address,page); }
      catch (error) { if (error instanceof SohuApiError && error.status===404) return; throw error; }
      if (!Array.isArray(response.data.orders)) throw new Error('Sohu не вернул историю для начальной сверки');
      pages=Math.max(1,Math.ceil(response.data.order_count/Math.max(1,response.data.page_size)));
      if (!Number.isSafeInteger(pages)||pages>10000) throw new Error('Некорректная пагинация Sohu');
      const keys=response.data.orders.flatMap(order=>[
        ...(order.used_tx_id?['used:'+order.used_tx_id]:[]),
        ...(order.delegate_tx_id?['delegate:'+order.delegate_tx_id]:[])
      ]);
      await this.db.query('INSERT INTO provider_order_baselines(subscription_id,provider_key) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',[row.id,keys]);
      page++;
    } while(page<=pages);
  }

  async syncAll(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning=true;
    try {
      await this.retireLegacyAddresses();
      try {
        const account=await this.sohu.getUserInfo();
        await logAudit(this.db,{eventType:'provider.account.snapshot',entityType:'provider_account',payload:account});
      } catch (error) { this.logger.warn({err:error},'Could not read Sohu account'); }
      let prices: Prices;
      try { prices=await this.currentPrices(); }
      catch (error) {
        const cached=await getLatestPrices(this.db);
        if (!cached) {
          await logAudit(this.db,{eventType:'provider.price.unavailable',payload:{error:errorText(error)}});
          return;
        }
        prices=cached;
        this.logger.warn({err:error},'Using cached Pro prices');
      }
      for (const row of await getActiveSubscriptions(this.db)) {
        await this.locks.run(row.id,async () => {
          try {
            const current=(await this.db.query<Subscription>('SELECT * FROM autocharging_subscriptions WHERE id=$1',[row.id])).rows[0];
            if (current) await this.syncSubscription(current,prices);
          } catch (error) {
            this.logger.error({err:error,subscriptionId:row.id},'Address sync failed');
            await logAudit(this.db,{eventType:'subscription.sync.failed',entityType:'subscription',entityId:row.id,payload:{error:errorText(error)}});
          }
        });
      }
    } catch (error) { this.logger.error({err:error},'Sohu synchronization failed'); }
    finally { this.syncRunning=false; }
  }

  private async retireLegacyAddresses(): Promise<void> {
    const rows=(await this.db.query<Subscription>('SELECT * FROM autocharging_subscriptions WHERE accounting_version=1 AND provider_stop_pending')).rows;
    for (const row of rows) {
      try {
        await this.stopProvider(row);
        await setSubscriptionStatus(this.db,row.id,'disabled','stop');
        await logAudit(this.db,{eventType:'subscription.legacy.retired',entityType:'subscription',entityId:row.id});
      } catch (error) { this.logger.error({err:error,subscriptionId:row.id},'Old provider address could not be stopped'); }
    }
  }

  private async syncSubscription(row: Subscription,prices: Prices): Promise<void> {
    if (row.provider_stop_pending) {
      try {
        await this.stopProvider(row);
        await setSubscriptionStatus(this.db,row.id,row.deleted_at?'disabled':'paused','stop',row.last_error);
        row.provider_stop_pending=false;
      } catch (error) { this.logger.error({err:error,subscriptionId:row.id},'Provider stop retry failed'); }
    }
    if (!row.provider_connected) return;
    const orders: SmartOrder[]=[];
    let page=1, pages=1;
    let credit=0n;
    let providerStatus: 'start'|'stop'='stop';
    do {
      const response=await this.sohu.queryEnergy(row.tron_address,page);
      if (!Array.isArray(response.data.orders)) throw new Error('Sohu orders is not an array');
      if (page===1) {
        credit=trxToMicros(response.data.balance);
        providerStatus=response.data.status;
        pages=Math.max(1,Math.ceil(response.data.order_count / Math.max(1,response.data.page_size)));
        if (!Number.isSafeInteger(pages)||pages>10000) throw new Error('Некорректная пагинация Sohu');
      }
      orders.push(...response.data.orders);
      page++;
    } while(page<=pages);
    // Save connectivity independently of accounting, including when a later record is malformed.
    await updateProviderSnapshot(this.db,row.id,credit,providerStatus);
    orders.sort((a,b)=>(a.createtime??0)-(b.createtime??0));
    for (const order of orders) await this.processOrder(row,order,prices);
    const current=(await this.db.query<Subscription>('SELECT * FROM autocharging_subscriptions WHERE id=$1',[row.id])).rows[0]!;
    if (!current.deleted_at) await this.warnLowReserve(current,prices);
    if (current.deleted_at || current.status!=='active') return;
    if (await getUnresolvedTopUp(this.db,row.id)) {
      await this.pauseForReason(current,'Не подтверждено предыдущее пополнение Sohu; требуется сверка');
      return;
    }
    if (BigInt(current.reserve_balance_micros)<this.nextCharge(prices)) {
      await this.pauseForReason(current,`Резерв ${microsToTrx(BigInt(current.reserve_balance_micros))} TRX меньше следующего списания ${microsToTrx(this.nextCharge(prices))} TRX`);
      return;
    }
    await this.ensureProviderCredit(current,credit,prices);
    try {
      await this.sohu.getStatistics(row.tron_address);
    } catch (error) { this.logger.warn({err:error,subscriptionId:row.id},'Could not read provider statistics'); }
  }

  private async warnLowReserve(row: Subscription,prices: Prices): Promise<void> {
    const configured=trxToMicros(this.config.LOW_RESERVE_WARNING_TRX);
    const byOrders=this.nextCharge(prices)*BigInt(this.config.LOW_RESERVE_WARNING_ORDERS);
    const threshold=configured>byOrders?configured:byOrders;
    await transaction(this.db,async (client) => {
      const current=await getSubscription(client,BigInt(row.user_telegram_id),row.id,true);
      if (!current) return;
      const low=BigInt(current.reserve_balance_micros)<=threshold;
      if (low && !current.low_balance_notified) {
        await client.query('UPDATE autocharging_subscriptions SET low_balance_notified=true WHERE id=$1',[row.id]);
        await enqueueNotification(client,row.id,randomUUID(),`⚠️ Заканчивается резерв адреса\n${row.tron_address}\nОстаток: ${microsToTrx(BigInt(current.reserve_balance_micros))} TRX.\nПополните депозит в карточке этого адреса. Предупреждение срабатывает при ${microsToTrx(threshold)} TRX.`);
      } else if (!low && current.low_balance_notified) {
        await client.query('UPDATE autocharging_subscriptions SET low_balance_notified=false WHERE id=$1',[row.id]);
      }
    });
  }

  private async ensureProviderCredit(row: Subscription,credit: bigint,prices: Prices): Promise<boolean> {
    const balance=BigInt(row.reserve_balance_micros);
    const affordable=balance/this.nextCharge(prices);
    const count=affordable<BigInt(this.config.SOHU_CREDIT_RESERVE_ORDERS)?Number(affordable):this.config.SOHU_CREDIT_RESERVE_ORDERS;
    const plan=calculateProviderCreditPlan({currentCreditMicros:credit,userBalanceMicros:balance,price131Micros:prices.price131Micros,
      feeMicros:trxToMicros(this.config.SERVICE_FEE_TRX),reserveOrders:Math.max(1,count),configuredTopUpMicros:trxToMicros(this.config.SOHU_CREDIT_TOPUP_TRX)});
    if (!plan.needsTopUp) return true;
    if (!plan.canTopUp) {
      await this.pauseForReason(row,'Резерв адреса не покрывает пополнение технического кредита Sohu');
      return false;
    }
    if (await getUnresolvedTopUp(this.db,row.id)) {
      await this.pauseForReason(row,'Предыдущее пополнение Sohu не подтверждено; повтор заблокирован');
      return false;
    }
    if (await getRecentProviderTopUp(this.db,row.id,this.config.SOHU_CREDIT_TOPUP_COOLDOWN_SECONDS)) {
      if (credit>=prices.price131Micros) return true;
      await this.pauseForReason(row,'Кредит Sohu исчерпан вскоре после пополнения; повтор заблокирован до сверки');
      return false;
    }
    const key=randomUUID();
    await startProviderTopUp(this.db,{subscriptionId:row.id,operationKey:key,requestedMicros:plan.requestedTopUpMicros,balanceBeforeMicros:credit});
    try {
      const response=await this.sohu.topUpEnergy(row.tron_address,microsToTrx(plan.requestedTopUpMicros));
      if (response.data.address!==row.tron_address) throw new Error('Sohu вернул другой адрес');
      const after=trxToMicros(response.data.balance);
      await finishProviderTopUp(this.db,{operationKey:key,status:'succeeded',balanceAfterMicros:after,response});
      await updateProviderSnapshot(this.db,row.id,after,response.data.status);
      await logAudit(this.db,{eventType:'provider.credit.topup.succeeded',entityType:'subscription',entityId:row.id,payload:{operationKey:key,amount_micros:plan.requestedTopUpMicros.toString()}});
      return true;
    } catch (error) {
      let observed: bigint|undefined;
      let response: unknown=null;
      try {
        const snapshot=await this.sohu.queryEnergy(row.tron_address);
        response=snapshot;
        observed=trxToMicros(snapshot.data.balance);
        await updateProviderSnapshot(this.db,row.id,observed,snapshot.data.status);
      } catch (queryError) { this.logger.error({err:queryError},'Top-up reconciliation failed'); }
      // An unchanged/reduced credit cannot prove rejection: usage may have consumed a successful credit.
      if (observed!==undefined && observed>=credit+plan.requestedTopUpMicros) {
        await finishProviderTopUp(this.db,{operationKey:key,status:'reconciled',balanceAfterMicros:observed,response,error:errorText(error)});
        return true;
      }
      await finishProviderTopUp(this.db,{operationKey:key,status:'uncertain',balanceAfterMicros:observed,response,error:errorText(error)});
      await this.pauseForReason(row,'Результат пополнения Sohu не подтверждён. Повтор заблокирован; требуется сверка');
      return false;
    }
  }

  private async pauseForReason(row: Subscription,reason: string): Promise<void> {
    let confirmed=!row.provider_connected;
    if (!confirmed) {
      try { await this.stopProvider(row); confirmed=true; }
      catch (error) { this.logger.error({err:error,subscriptionId:row.id},'Provider stop not confirmed'); }
    }
    await transaction(this.db,async (client) => {
      await setSubscriptionStatus(client,row.id,'paused',confirmed?'stop':row.souhu_status,reason,!confirmed);
      await enqueueNotification(client,row.id,randomUUID(),`⏸ Автозаряд приостановлен\n${row.tron_address}\n${reason}.${confirmed?'':'\nОстановка на стороне Sohu пока не подтверждена.'}`);
      await logAudit(client,{eventType:'subscription.paused.automatically',entityType:'subscription',entityId:row.id,payload:{reason,providerStopConfirmed:confirmed}});
    });
  }

  private async processOrder(row: Subscription,order: SmartOrder,prices: Prices): Promise<void> {
    if (!order.used_tx_id || order.used_energy==null || order.used_energy<=0 || order.status!=='un_delegate_success') return;
    if (!Number.isSafeInteger(order.used_energy) || !order.createtime || !Number.isFinite(order.createtime)) return;
    const sourceDate=new Date(order.createtime*1000);
    if (sourceDate<new Date(row.billing_started_at) || (row.deleted_at && sourceDate>=new Date(row.deleted_at))) return;
    const baselineKeys=['used:'+order.used_tx_id,...(order.delegate_tx_id?['delegate:'+order.delegate_tx_id]:[])];
    if ((await this.db.query('SELECT 1 FROM provider_order_baselines WHERE subscription_id=$1 AND provider_key=ANY($2::text[]) LIMIT 1',[row.id,baselineKeys])).rowCount) return;
    if (order.currency && order.currency.toLowerCase()!=='trx') {
      await logAudit(this.db,{eventType:'provider.order.unsupported_currency',entityType:'subscription',entityId:row.id,payload:order});
      return;
    }
    const settlement=calculateSettlement({energyType:order.energy_type,delegateCount:order.delegate_count,usedEnergy:order.used_energy,...prices,feeMicros:trxToMicros(this.config.SERVICE_FEE_TRX)});
    const key=`address:${row.id}:used:${order.used_tx_id}`;
    const gross=settlement.baseChargeMicros+settlement.feeMicros;
    await transaction(this.db,async (client) => {
      // Row locking precedes the event insert, so duplicate polls cannot race the ledger.
      await client.query('SELECT id FROM autocharging_subscriptions WHERE id=$1 FOR UPDATE',[row.id]);
      const inserted=(await client.query<{id:string}>(
        `INSERT INTO provider_usage_events(subscription_id,provider_key,used_tx_id,delegate_tx_id,undelegate_tx_id,energy_type,allocated_energy,used_energy,souhu_cost_micros,charged_micros,refunded_micros,fee_micros,provider_status,source_created_at,raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id,key,order.used_tx_id,order.delegate_tx_id??null,order.un_delegate_tx_id??null,order.energy_type??null,settlement.allocatedEnergy,settlement.usedEnergy,order.amount==null?null:trxToMicros(order.amount).toString(),gross.toString(),settlement.refundMicros.toString(),settlement.feeMicros.toString(),order.status,sourceDate,JSON.stringify(order)]
      )).rows[0];
      if (!inserted) return;
      const base={userId:BigInt(row.user_telegram_id),subscriptionId:row.id,usageEventId:inserted.id};
      const charge=await applyLedgerEntry(client,{...base,kind:'energy_charge',amountMicros:-gross,idempotencyKey:key+':charge',description:`Выделено ${settlement.allocatedEnergy} энергии; комиссия ${microsToTrx(settlement.feeMicros)} TRX`,metadata:{used_tx_id:order.used_tx_id}});
      let balance=charge.balanceAfterMicros;
      if (settlement.refundMicros>0n) {
        balance=(await applyLedgerEntry(client,{...base,kind:'unused_energy_refund',amountMicros:settlement.refundMicros,idempotencyKey:key+':refund',description:`Возврат за неиспользованную часть; потрачено ${settlement.usedEnergy} энергии`})).balanceAfterMicros;
      }
      const text=[
        '⚡ Автозаряд Pro',row.tron_address,
        `Выделено: ${settlement.allocatedEnergy}; использовано: ${settlement.usedEnergy} энергии.`,
        `Списано: ${microsToTrx(gross)} TRX, комиссия: ${microsToTrx(settlement.feeMicros)} TRX.`,
        `Возврат: ${microsToTrx(settlement.refundMicros)} TRX. Итого: −${microsToTrx(settlement.netDebitMicros)} TRX.`,
        `Остаток резерва: ${microsToTrx(balance)} TRX.`,
        `https://tronscan.org/#/transaction/${order.used_tx_id}`
      ].join('\n');
      await enqueueNotification(client,row.id,key+':notification',text);
    });
  }

  async deliverNotifications(notify:(notification:UserNotification,recipient:'user'|'admin')=>Promise<boolean>): Promise<void> {
    if (this.deliveryRunning) return;
    this.deliveryRunning=true;
    try {
      for (const recipient of ['user','admin'] as const) {
        const column=recipient==='user'?'user_delivered_at':'admin_delivered_at';
        const pending=(await this.db.query<{id:string;text:string;subscription_id:string}>(`SELECT id,text,subscription_id FROM notification_outbox WHERE ${column} IS NULL ORDER BY id LIMIT 100`)).rows;
        for (const item of pending) {
          await this.db.query('UPDATE notification_outbox SET attempts=attempts+1 WHERE id=$1',[item.id]);
          if (!await notify({text:item.text,subscriptionId:item.subscription_id},recipient)) break;
          await this.db.query(`UPDATE notification_outbox SET ${column}=now() WHERE id=$1`,[item.id]);
        }
      }
      await this.db.query('UPDATE notification_outbox SET delivered_at=now() WHERE delivered_at IS NULL AND user_delivered_at IS NOT NULL AND admin_delivered_at IS NOT NULL');
    } finally { this.deliveryRunning=false; }
  }
}
