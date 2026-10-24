import type { Db, DbClient } from './db.js';
import { transaction } from './db.js';
import type { LedgerEntry, Prices, Subscription, SubscriptionStatus, UsageEvent } from './types.js';

type Queryable = Pick<DbClient, 'query'>;

export async function bootstrapUsers(db: Db, userId: bigint, adminId: bigint): Promise<void> {
  await transaction(db, async (client) => {
    await client.query("INSERT INTO app_users(telegram_id,role) VALUES ($1,'user') ON CONFLICT (telegram_id) DO UPDATE SET role='user'", [userId.toString()]);
    await client.query("INSERT INTO app_users(telegram_id,role) VALUES ($1,'admin') ON CONFLICT (telegram_id) DO UPDATE SET role='admin'", [adminId.toString()]);
  });
}

export async function listSubscriptions(db: Queryable, userId: bigint): Promise<Subscription[]> {
  return (await db.query<Subscription>('SELECT * FROM autocharging_subscriptions WHERE user_telegram_id=$1 AND deleted_at IS NULL ORDER BY id', [userId.toString()])).rows;
}

export async function getSubscription(db: Queryable, userId: bigint, id: string, lock = false): Promise<Subscription | null> {
  const result = await db.query<Subscription>(
    `SELECT * FROM autocharging_subscriptions WHERE id=$1 AND user_telegram_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, userId.toString()]
  );
  return result.rows[0] ?? null;
}

export async function createPendingSubscription(db: Db, input: {userId: bigint; address: string; initialReserve: bigint; minimumEnergy: number; key: string}): Promise<Subscription> {
  return transaction(db, async (client) => {
    const row = (await client.query<Subscription>(
      `INSERT INTO autocharging_subscriptions(user_telegram_id,tron_address,status,deposit_micros,deposit_status,minimum_energy_72h,billing_started_at)
       VALUES ($1,$2,'pending',0,'not_required',$3,date_trunc('second',now())) RETURNING *`,
      [input.userId.toString(), input.address, input.minimumEnergy]
    )).rows[0]!;
    await applyLedgerEntry(client, {
      userId: input.userId, subscriptionId: row.id, kind: 'reserve_topup', amountMicros: input.initialReserve,
      idempotencyKey: input.key, description: 'Начальный виртуальный резерв адреса'
    });
    return { ...row, reserve_balance_micros: input.initialReserve.toString() };
  });
}

export async function setSubscriptionStatus(db: Queryable, id: string, status: SubscriptionStatus, providerStatus: string | null, error: string | null = null, stopPending = false): Promise<void> {
  await db.query('UPDATE autocharging_subscriptions SET status=$2,souhu_status=$3,last_error=$4,provider_stop_pending=$5,updated_at=now() WHERE id=$1', [id,status,providerStatus,error,stopPending]);
}

export async function getActiveSubscriptions(db: Db): Promise<Subscription[]> {
  return (await db.query<Subscription>(
    `SELECT * FROM autocharging_subscriptions WHERE accounting_version=2 AND
      ((deleted_at IS NULL AND status IN ('active','paused','disabled','low_balance'))
       OR (deleted_at>now()-interval '24 hours' AND provider_connected) OR provider_stop_pending) ORDER BY id`
  )).rows;
}

export async function updateProviderSnapshot(db: Queryable, id: string, balance: bigint, status: string): Promise<void> {
  await db.query('UPDATE autocharging_subscriptions SET souhu_credit_micros=$2,souhu_status=$3,last_souhu_sync_at=now(),updated_at=now() WHERE id=$1', [id,balance.toString(),status]);
}

export async function applyLedgerEntry(client: DbClient, input: {
  userId: bigint; subscriptionId: string; usageEventId?: string; kind: string; amountMicros: bigint;
  idempotencyKey: string; description: string; metadata?: unknown;
}): Promise<{applied: boolean; balanceAfterMicros: bigint}> {
  const row = (await client.query<Subscription>('SELECT * FROM autocharging_subscriptions WHERE id=$1 AND user_telegram_id=$2 FOR UPDATE', [input.subscriptionId,input.userId.toString()])).rows[0];
  if (!row) throw new Error('Адрес не найден');
  const existing = (await client.query<{balance_after_micros: string}>('SELECT balance_after_micros FROM ledger_entries WHERE idempotency_key=$1', [input.idempotencyKey])).rows[0];
  if (existing) return {applied:false,balanceAfterMicros:BigInt(existing.balance_after_micros)};
  const next = BigInt(row.reserve_balance_micros) + input.amountMicros;
  if (next >= 10n ** 38n || next <= -(10n ** 38n)) throw new Error('Сумма превышает техническую точность хранения TRX.');
  // A final provider event may arrive after a stop. Account the debt instead of retrying forever.
  await client.query('UPDATE autocharging_subscriptions SET reserve_balance_micros=$2,updated_at=now() WHERE id=$1', [row.id,next.toString()]);
  await client.query(
    `INSERT INTO ledger_entries(user_telegram_id,subscription_id,usage_event_id,kind,amount_micros,balance_after_micros,idempotency_key,description,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [input.userId.toString(),row.id,input.usageEventId ?? null,input.kind,input.amountMicros.toString(),next.toString(),input.idempotencyKey,input.description,JSON.stringify(input.metadata ?? {})]
  );
  return {applied:true,balanceAfterMicros:next};
}

export async function enqueueNotification(db: Queryable, subscriptionId: string, key: string, text: string): Promise<void> {
  await db.query('INSERT INTO notification_outbox(subscription_id,idempotency_key,text) VALUES ($1,$2,$3) ON CONFLICT (idempotency_key) DO NOTHING', [subscriptionId,key,text]);
}

export async function getUsage(db: Queryable, subscriptionId: string, limit?: number): Promise<UsageEvent[]> {
  return (await db.query<UsageEvent>(
    `SELECT e.*, (SELECT l.balance_after_micros FROM ledger_entries l WHERE l.usage_event_id=e.id ORDER BY l.id DESC LIMIT 1) AS balance_after_micros
     FROM provider_usage_events e WHERE e.subscription_id=$1 ORDER BY e.source_created_at DESC NULLS LAST,e.id DESC${limit === undefined ? '' : ' LIMIT $2'}`,
    limit === undefined ? [subscriptionId] : [subscriptionId,limit]
  )).rows;
}

export async function getLedger(db: Queryable, subscriptionId: string): Promise<LedgerEntry[]> {
  return (await db.query<LedgerEntry>('SELECT id,kind,amount_micros,balance_after_micros,description,created_at FROM ledger_entries WHERE subscription_id=$1 ORDER BY id', [subscriptionId])).rows;
}

export async function savePriceSnapshot(db: Db, input: Prices & {raw: unknown}): Promise<void> {
  await db.query("INSERT INTO price_snapshots(channel,price_65k_micros,price_131k_micros,raw_payload) VALUES ('high_frequency',$1,$2,$3::jsonb)", [input.price65Micros.toString(),input.price131Micros.toString(),JSON.stringify(input.raw)]);
}

export async function getLatestPrices(db: Queryable): Promise<Prices | null> {
  const row = (await db.query<{price_65k_micros:string;price_131k_micros:string}>("SELECT price_65k_micros,price_131k_micros FROM price_snapshots WHERE channel='high_frequency' ORDER BY fetched_at DESC LIMIT 1")).rows[0];
  return row ? {price65Micros:BigInt(row.price_65k_micros),price131Micros:BigInt(row.price_131k_micros)} : null;
}

export async function logAudit(db: Queryable, input: {actorId?: bigint;eventType: string;entityType?: string;entityId?: string;payload?: unknown}): Promise<void> {
  await db.query('INSERT INTO audit_events(actor_telegram_id,event_type,entity_type,entity_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)', [input.actorId?.toString() ?? null,input.eventType,input.entityType ?? null,input.entityId ?? null,JSON.stringify(input.payload ?? {})]);
}

export async function logTelegramEvent(db: Db, input: {updateId?: number;userId?: bigint;direction:'in'|'out';eventType: string;payload: unknown}): Promise<void> {
  await db.query('INSERT INTO telegram_event_logs(update_id,telegram_user_id,direction,event_type,payload) VALUES ($1,$2,$3,$4,$5::jsonb)', [input.updateId ?? null,input.userId?.toString() ?? null,input.direction,input.eventType,JSON.stringify(input.payload)]);
}

export async function getUnresolvedTopUp(db: Queryable, subscriptionId: string): Promise<boolean> {
  return Boolean((await db.query("SELECT 1 FROM provider_credit_topups WHERE subscription_id=$1 AND status IN ('started','uncertain') LIMIT 1", [subscriptionId])).rowCount);
}

export async function getRecentProviderTopUp(db: Queryable, subscriptionId: string, seconds: number): Promise<boolean> {
  return Boolean((await db.query("SELECT 1 FROM provider_credit_topups WHERE subscription_id=$1 AND status IN ('succeeded','reconciled') AND created_at>now()-($2 * interval '1 second') LIMIT 1", [subscriptionId,seconds])).rowCount);
}

export async function startProviderTopUp(db: Db, input: {subscriptionId:string;operationKey:string;requestedMicros:bigint;balanceBeforeMicros:bigint}): Promise<void> {
  await db.query("INSERT INTO provider_credit_topups(subscription_id,operation_key,requested_micros,balance_before_micros,status) VALUES ($1,$2,$3,$4,'started')", [input.subscriptionId,input.operationKey,input.requestedMicros.toString(),input.balanceBeforeMicros.toString()]);
}

export async function finishProviderTopUp(db: Db, input: {operationKey:string;status:'succeeded'|'reconciled'|'failed'|'uncertain';balanceAfterMicros?:bigint;response?:unknown;error?:string}): Promise<void> {
  await db.query('UPDATE provider_credit_topups SET status=$2,balance_after_micros=$3,provider_response=$4::jsonb,error=$5,completed_at=now() WHERE operation_key=$1', [input.operationKey,input.status,input.balanceAfterMicros?.toString() ?? null,JSON.stringify(input.response ?? null),input.error?.slice(0,2000) ?? null]);
}
