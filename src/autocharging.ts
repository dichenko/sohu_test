import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { transaction } from "./db.js";
import type { Logger } from "./logger.js";
import { calculateProviderCreditPlan, calculateSettlement, microsToTrx, trxToMicros } from "./money.js";
import {
  activateSubscription,
  applyLedgerEntry,
  createPendingSubscription,
  getActiveSubscriptions,
  getLatestPrices,
  getSubscription,
  getUserBalance,
  finishProviderTopUp,
  getRecentProviderTopUp,
  logAudit,
  markSubscriptionError,
  pauseSubscriptionWithReason,
  savePriceSnapshot,
  setSubscriptionStatus,
  startProviderTopUp,
  updateProviderSnapshot
} from "./repository.js";
import { SohuApiError, SohuClient } from "./sohu.js";
import type { SmartOrder, Subscription } from "./types.js";

export type UserNotification = { text: string; parseMode?: "HTML" };

export class AutochargingService {
  private syncRunning = false;

  constructor(
    private readonly db: Db,
    private readonly sohu: SohuClient,
    private readonly config: Config,
    private readonly logger: Logger
  ) {}

  async currentPrices(): Promise<{ price65Micros: bigint; price131Micros: bigint }> {
    const envelope = await this.sohu.getSmartPrice();
    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const channel = data.high_frequency as Record<string, unknown> | undefined;
    // Swagger declares top-level 65K_price/131K_price, while some responses
    // return the Pro values under high_frequency. Accept both shapes and keep
    // the raw response in price_snapshots for later comparison.
    const raw65 = channel?.["65k_price"] ?? channel?.["65K_price"] ?? data["65K_price"] ?? data["65k_price"];
    const raw131 = channel?.["131k_price"] ?? channel?.["131K_price"] ?? data["131K_price"] ?? data["131k_price"];
    if (raw65 == null || raw131 == null) throw new Error("Sohu response has no high_frequency 65k/131k prices");
    const prices = { price65Micros: trxToMicros(String(raw65)), price131Micros: trxToMicros(String(raw131)) };
    await savePriceSnapshot(this.db, { channel: "high_frequency", ...prices, raw: envelope });
    return prices;
  }

  async connect(userId: bigint, address: string): Promise<void> {
    if (await getSubscription(this.db, userId)) throw new Error("К этому аккаунту уже привязан адрес");
    const depositMicros = trxToMicros(this.config.PRO_DEPOSIT_TRX);
    const balance = await getUserBalance(this.db, userId);
    if (balance < depositMicros) throw new Error("Недостаточно средств для залога 15 TRX");
    const subscription = await createPendingSubscription(this.db, {
      userId,
      address,
      depositMicros,
      minimumEnergy: this.config.PRO_MIN_ENERGY_72H
    });
    await logAudit(this.db, { actorId: userId, eventType: "subscription.connect.started", entityType: "subscription", entityId: subscription.id, payload: { address } });
    try {
      const response = await this.sohu.delegateEnergy({
        address,
        balanceTrx: String(this.config.SOHU_INITIAL_CREDIT_TRX),
        depositTrx: String(this.config.PRO_DEPOSIT_TRX)
      });
      const providerBalanceMicros = trxToMicros(response.data.balance);
      await activateSubscription(this.db, subscription.id, userId, providerBalanceMicros, depositMicros);
      await this.db.query(
        `INSERT INTO autocharging_cycles
          (subscription_id, started_at, ends_at, minimum_energy, used_energy, deposit_micros, deposit_status, raw_provider_state)
         SELECT id, cycle_started_at, cycle_ends_at, minimum_energy_72h, 0, deposit_micros, 'held', $2::jsonb
         FROM autocharging_subscriptions WHERE id = $1 ON CONFLICT DO NOTHING`,
        [subscription.id, JSON.stringify(response)]
      );
      await logAudit(this.db, { actorId: userId, eventType: "subscription.connect.succeeded", entityType: "subscription", entityId: subscription.id, payload: response });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markSubscriptionError(this.db, subscription.id, message);
      await logAudit(this.db, { actorId: userId, eventType: "subscription.connect.failed", entityType: "subscription", entityId: subscription.id, payload: { error: message } });
      throw new Error(`Sohu не подтвердил подключение: ${message}`);
    }
  }

  async changeState(userId: bigint, action: "pause" | "resume" | "disable"): Promise<void> {
    const subscription = await getSubscription(this.db, userId);
    if (!subscription) throw new Error("Автозаряд ещё не подключён");
    if (subscription.status === "error") throw new Error("Подписка в состоянии ошибки; проверьте журнал перед повтором запроса");
    if (action === "resume") {
      let prices = await getLatestPrices(this.db);
      if (!prices) prices = await this.currentPrices();
      const required = prices.price131Micros + trxToMicros(this.config.SERVICE_FEE_TRX);
      const balance = await getUserBalance(this.db, userId);
      if (balance < required) {
        throw new Error(`Для возобновления нужен резерв ${microsToTrx(required)} TRX; сейчас ${microsToTrx(balance)} TRX`);
      }
    }
    const providerStatus = action === "resume" ? "start" : "stop";
    await this.sohu.updateEnergy(subscription.tron_address, providerStatus);
    const localStatus = action === "resume" ? "active" : action === "pause" ? "paused" : "disabled";
    await setSubscriptionStatus(this.db, subscription.id, localStatus, providerStatus);
    await logAudit(this.db, { actorId: userId, eventType: `subscription.${action}`, entityType: "subscription", entityId: subscription.id });
  }

  async syncAll(notify: (notification: UserNotification) => Promise<void>): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      let prices: { price65Micros: bigint; price131Micros: bigint };
      try {
        const providerAccount = await this.sohu.getUserInfo();
        await logAudit(this.db, { eventType: "provider.account.snapshot", entityType: "provider_account", payload: providerAccount });
      } catch (error) {
        this.logger.warn({ err: error }, "Could not read Sohu provider account");
      }
      try {
        prices = await this.currentPrices();
      } catch (error) {
        const cached = await getLatestPrices(this.db);
        if (!cached) {
          // A malformed/changed price response must not terminate Telegram
          // polling. The raw provider response and error are already in
          // provider_http_logs; retry on the next scheduled sync.
          this.logger.error({ err: error }, "Sohu prices unavailable; skipping this sync cycle");
          await logAudit(this.db, {
            eventType: "provider.price.unavailable",
            entityType: "provider_account",
            payload: { error: error instanceof Error ? error.message : String(error) }
          });
          return;
        }
        prices = cached;
        this.logger.warn({ err: error }, "Using cached Sohu prices");
      }
      for (const subscription of await getActiveSubscriptions(this.db)) {
        try {
          await this.syncSubscription(subscription, prices, notify);
        } catch (error) {
          this.logger.error({ err: error, subscriptionId: subscription.id }, "Subscription sync failed");
          await logAudit(this.db, { eventType: "subscription.sync.failed", entityType: "subscription", entityId: subscription.id, payload: { error: error instanceof Error ? error.message : String(error) } });
        }
      }
    } finally {
      this.syncRunning = false;
    }
  }

  private async syncSubscription(
    subscription: Subscription,
    prices: { price65Micros: bigint; price131Micros: bigint },
    notify: (notification: UserNotification) => Promise<void>
  ): Promise<void> {
    let page = 1;
    let totalPages = 1;
    const orders: SmartOrder[] = [];
    let latestProviderBalance = subscription.souhu_credit_micros ? BigInt(subscription.souhu_credit_micros) : 0n;
    let latestProviderStatus = subscription.souhu_status ?? "unknown";
    do {
      const response = await this.sohu.queryEnergy(subscription.tron_address, page);
      latestProviderBalance = trxToMicros(response.data.balance);
      latestProviderStatus = response.data.status;
      totalPages = Math.min(20, Math.max(1, Math.ceil(response.data.order_count / Math.max(1, response.data.page_size))));
      orders.push(...response.data.orders);
      page += 1;
    } while (page <= totalPages);
    orders.sort((a, b) => (a.createtime ?? 0) - (b.createtime ?? 0));
    for (const order of orders) {
      const result = await this.processOrder(subscription, order, prices);
      if (result) await notify({ text: result });
    }
    await updateProviderSnapshot(this.db, subscription.id, latestProviderBalance, latestProviderStatus);
    try {
      const statistics = await this.sohu.getStatistics(subscription.tron_address);
      await logAudit(this.db, { eventType: "provider.statistics.snapshot", entityType: "subscription", entityId: subscription.id, payload: statistics });
    } catch (error) {
      this.logger.warn({ err: error, subscriptionId: subscription.id }, "Could not read Sohu statistics");
    }

    const balance = await getUserBalance(this.db, BigInt(subscription.user_telegram_id));
    const nextReserve = prices.price131Micros + trxToMicros(this.config.SERVICE_FEE_TRX);
    if (subscription.status === "active" && balance < nextReserve) {
      await this.pauseForReason(
        subscription,
        `Баланс клиента ${microsToTrx(balance)} TRX меньше резерва следующего списания ${microsToTrx(nextReserve)} TRX`,
        notify
      );
      return;
    }
    if (subscription.status === "active") {
      await this.ensureProviderCredit(subscription, latestProviderBalance, balance, prices, notify);
    }
  }

  private async ensureProviderCredit(
    subscription: Subscription,
    providerBalanceMicros: bigint,
    userBalanceMicros: bigint,
    prices: { price65Micros: bigint; price131Micros: bigint },
    notify: (notification: UserNotification) => Promise<void>
  ): Promise<void> {
    const plan = calculateProviderCreditPlan({
      currentCreditMicros: providerBalanceMicros,
      userBalanceMicros,
      price131Micros: prices.price131Micros,
      feeMicros: trxToMicros(this.config.SERVICE_FEE_TRX),
      reserveOrders: this.config.SOHU_CREDIT_RESERVE_ORDERS,
      configuredTopUpMicros: trxToMicros(this.config.SOHU_CREDIT_TOPUP_TRX)
    });
    if (!plan.needsTopUp) return;
    await logAudit(this.db, {
      eventType: "provider.credit.low",
      entityType: "subscription",
      entityId: subscription.id,
      payload: {
        provider_balance_micros: providerBalanceMicros.toString(),
        threshold_micros: plan.thresholdMicros.toString(),
        requested_topup_micros: plan.requestedTopUpMicros.toString(),
        user_balance_micros: userBalanceMicros.toString()
      }
    });
    if (!plan.canTopUp) {
      await this.pauseForReason(
        subscription,
        `Кредит Sohu ${microsToTrx(providerBalanceMicros)} TRX ниже порога ${microsToTrx(plan.thresholdMicros)} TRX, а клиентский баланс не покрывает безопасное пополнение`,
        notify
      );
      return;
    }

    const recentTopUp = await getRecentProviderTopUp(this.db, subscription.id, this.config.SOHU_CREDIT_TOPUP_COOLDOWN_SECONDS);
    if (recentTopUp) {
      await logAudit(this.db, {
        eventType: "provider.credit.topup.cooldown",
        entityType: "subscription",
        entityId: subscription.id,
        payload: { operationKey: recentTopUp.operation_key, status: recentTopUp.status, createdAt: recentTopUp.created_at }
      });
      return;
    }

    const operationKey = randomUUID();
    await startProviderTopUp(this.db, {
      subscriptionId: subscription.id,
      operationKey,
      requestedMicros: plan.requestedTopUpMicros,
      balanceBeforeMicros: providerBalanceMicros
    });
    try {
      const response = await this.sohu.topUpEnergy(subscription.tron_address, microsToTrx(plan.requestedTopUpMicros));
      const balanceAfter = trxToMicros(response.data.balance);
      await finishProviderTopUp(this.db, {
        operationKey,
        status: "succeeded",
        balanceAfterMicros: balanceAfter,
        response
      });
      await updateProviderSnapshot(this.db, subscription.id, balanceAfter, response.data.status);
      await logAudit(this.db, { eventType: "provider.credit.topup.succeeded", entityType: "subscription", entityId: subscription.id, payload: { operationKey, response } });
      await notify({ text: `🔄 Технический кредит Sohu пополнен на ${microsToTrx(plan.requestedTopUpMicros)} TRX. Новый остаток Sohu: ${microsToTrx(balanceAfter)} TRX. Клиентский баланс сейчас не списывался.` });
    } catch (error) {
      const originalError = error instanceof Error ? error.message : String(error);
      let reconciliation: unknown = null;
      let observedBalance: bigint | undefined;
      try {
        reconciliation = await this.sohu.queryEnergy(subscription.tron_address, 1);
        observedBalance = trxToMicros((reconciliation as Awaited<ReturnType<SohuClient["queryEnergy"]>>).data.balance);
      } catch (reconciliationError) {
        this.logger.error({ err: reconciliationError, operationKey }, "Provider credit reconciliation failed");
      }

      // A concurrent energy issue may consume part of the new credit before reconciliation.
      // Any increase over the pre-request balance confirms that Sohu applied the funding.
      if (observedBalance !== undefined && observedBalance > providerBalanceMicros) {
        await finishProviderTopUp(this.db, {
          operationKey,
          status: "reconciled",
          balanceAfterMicros: observedBalance,
          response: reconciliation,
          error: originalError
        });
        await updateProviderSnapshot(this.db, subscription.id, observedBalance, "start");
        await logAudit(this.db, { eventType: "provider.credit.topup.reconciled", entityType: "subscription", entityId: subscription.id, payload: { operationKey, originalError, observed_balance_micros: observedBalance.toString() } });
        await notify({ text: `🔄 Пополнение кредита Sohu на ${microsToTrx(plan.requestedTopUpMicros)} TRX подтверждено повторной проверкой после ошибки ответа. Повторный платёж не отправлялся.` });
        return;
      }

      const definitelyRejected = error instanceof SohuApiError
        && error.status !== undefined
        && error.status >= 400
        && error.status < 500
        && ![408, 429].includes(error.status);
      const uncertain = observedBalance === undefined || !definitelyRejected;
      await finishProviderTopUp(this.db, {
        operationKey,
        status: uncertain ? "uncertain" : "failed",
        balanceAfterMicros: observedBalance,
        response: reconciliation,
        error: originalError
      });
      await logAudit(this.db, { eventType: uncertain ? "provider.credit.topup.uncertain" : "provider.credit.topup.failed", entityType: "subscription", entityId: subscription.id, payload: { operationKey, originalError, observed_balance_micros: observedBalance?.toString() } });
      await this.pauseForReason(
        subscription,
        uncertain
          ? `Результат пополнения Sohu на ${microsToTrx(plan.requestedTopUpMicros)} TRX не удалось подтвердить; автоматический повтор запрещён`
          : `Sohu не пополнил технический кредит: ${originalError}`,
        notify
      );
    }
  }

  private async pauseForReason(
    subscription: Subscription,
    reason: string,
    notify: (notification: UserNotification) => Promise<void>
  ): Promise<void> {
    let providerStopConfirmed = false;
    let stopError: string | undefined;
    try {
      await this.sohu.updateEnergy(subscription.tron_address, "stop");
      providerStopConfirmed = true;
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, subscriptionId: subscription.id }, "Could not confirm provider stop");
    }
    await pauseSubscriptionWithReason(this.db, subscription.id, reason, providerStopConfirmed);
    await logAudit(this.db, { eventType: "subscription.paused.automatically", entityType: "subscription", entityId: subscription.id, payload: { reason, providerStopConfirmed, stopError } });
    await notify({
      text: `⚠️ Автозаряд поставлен на паузу.\nПричина: ${reason}.${providerStopConfirmed ? "" : "\nОстановку на стороне Sohu подтвердить не удалось — требуется ручная проверка."}`
    });
  }

  private async processOrder(
    subscription: Subscription,
    order: SmartOrder,
    prices: { price65Micros: bigint; price131Micros: bigint }
  ): Promise<string | null> {
    if (!order.used_tx_id || order.used_energy == null) {
      if (order.delegate_tx_id) {
        const fingerprint = createHash("sha256").update(JSON.stringify(order)).digest("hex");
        await logAudit(this.db, { eventType: "provider.order.observed_unbillable", entityType: "subscription", entityId: subscription.id, payload: { fingerprint, order } });
      }
      return null;
    }
    const feeMicros = trxToMicros(this.config.SERVICE_FEE_TRX);
    const settlement = calculateSettlement({
      energyType: order.energy_type,
      delegateCount: order.delegate_count,
      usedEnergy: order.used_energy,
      ...prices,
      feeMicros
    });
    const userId = BigInt(subscription.user_telegram_id);
    const providerKey = `used:${order.used_tx_id}`;
    const result = await transaction(this.db, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO provider_usage_events
          (subscription_id, provider_key, used_tx_id, delegate_tx_id, undelegate_tx_id, energy_type,
           allocated_energy, used_energy, souhu_cost_micros, charged_micros, refunded_micros, fee_micros,
           provider_status, source_created_at, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         ON CONFLICT (provider_key) DO NOTHING RETURNING id`,
        [
          subscription.id, providerKey, order.used_tx_id, order.delegate_tx_id ?? null, order.un_delegate_tx_id ?? null,
          order.energy_type ?? null, settlement.allocatedEnergy, settlement.usedEnergy,
          order.amount == null ? null : trxToMicros(String(order.amount)).toString(),
          (settlement.baseChargeMicros + settlement.feeMicros).toString(), settlement.refundMicros.toString(),
          settlement.feeMicros.toString(), order.status ?? null,
          order.createtime ? new Date(order.createtime * 1000) : null, JSON.stringify(order)
        ]
      );
      const event = inserted.rows[0];
      if (!event) return null;
      const charge = await applyLedgerEntry(client, {
        userId,
        subscriptionId: subscription.id,
        usageEventId: event.id,
        kind: "energy_charge",
        amountMicros: -(settlement.baseChargeMicros + settlement.feeMicros),
        idempotencyKey: `${providerKey}:charge`,
        description: `Автозаряд: выделено ${settlement.allocatedEnergy.toLocaleString("ru-RU")} энергии; комиссия ${microsToTrx(settlement.feeMicros)} TRX`,
        metadata: { used_tx_id: order.used_tx_id, prices_micros: { p65: prices.price65Micros.toString(), p131: prices.price131Micros.toString() } }
      });
      let finalBalance = charge.balanceAfterMicros;
      if (settlement.refundMicros > 0n) {
        const refund = await applyLedgerEntry(client, {
          userId,
          subscriptionId: subscription.id,
          usageEventId: event.id,
          kind: "unused_energy_refund",
          amountMicros: settlement.refundMicros,
          idempotencyKey: `${providerKey}:refund`,
          description: `Возврат за неиспользованную часть: фактически ${settlement.usedEnergy.toLocaleString("ru-RU")} энергии`,
          metadata: { used_tx_id: order.used_tx_id }
        });
        finalBalance = refund.balanceAfterMicros;
      }
      await this.advanceCycle(client, subscription, settlement.usedEnergy, order);
      return { finalBalance };
    });
    if (!result) return null;

    const charge = settlement.baseChargeMicros + settlement.feeMicros;
    const lines = [
      `⚡️ Sohu: выделено ${settlement.allocatedEnergy.toLocaleString("ru-RU")}, использовано ${settlement.usedEnergy.toLocaleString("ru-RU")} энергии.`,
      `Списано: ${microsToTrx(charge)} TRX (включая комиссию ${microsToTrx(settlement.feeMicros)} TRX).`
    ];
    if (settlement.refundMicros > 0n) lines.push(`Возвращено: ${microsToTrx(settlement.refundMicros)} TRX за неиспользованную часть.`);
    lines.push(`Остаток: ${microsToTrx(result.finalBalance)} TRX.`, `Транзакция: https://tronscan.org/#/transaction/${order.used_tx_id}`);
    return lines.join("\n");
  }

  private async advanceCycle(client: import("./db.js").DbClient, subscription: Subscription, usedEnergy: number, raw: unknown): Promise<void> {
    const locked = await client.query<Subscription>("SELECT * FROM autocharging_subscriptions WHERE id = $1 FOR UPDATE", [subscription.id]);
    const current = locked.rows[0];
    if (!current) return;
    const now = new Date();
    if (new Date(current.cycle_ends_at) <= now) {
      await client.query(
        "UPDATE autocharging_cycles SET used_energy = $2, closed_at = now(), raw_provider_state = $3::jsonb WHERE subscription_id = $1 AND started_at = $4",
        [current.id, current.cycle_energy_used, JSON.stringify(raw), current.cycle_started_at]
      );
      const nextEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);
      await client.query(
        `UPDATE autocharging_subscriptions SET cycle_started_at = $2, cycle_ends_at = $3, cycle_energy_used = $4, updated_at = now() WHERE id = $1`,
        [current.id, now, nextEnd, usedEnergy]
      );
      await client.query(
        `INSERT INTO autocharging_cycles
          (subscription_id, started_at, ends_at, minimum_energy, used_energy, deposit_micros, deposit_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [current.id, now, nextEnd, current.minimum_energy_72h, usedEnergy, current.deposit_micros, current.deposit_status]
      );
    } else {
      await client.query("UPDATE autocharging_subscriptions SET cycle_energy_used = cycle_energy_used + $2, updated_at = now() WHERE id = $1", [current.id, usedEnergy]);
      await client.query("UPDATE autocharging_cycles SET used_energy = used_energy + $2 WHERE subscription_id = $1 AND started_at = $3", [current.id, usedEnergy, current.cycle_started_at]);
    }
  }
}
