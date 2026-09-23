import type { Db, DbClient } from "./db.js";
import { transaction } from "./db.js";
import { microsToTrx } from "./money.js";
import type { Subscription } from "./types.js";

export async function bootstrapUsers(db: Db, userId: bigint, adminId: bigint, initialBalanceMicros: bigint): Promise<void> {
  await transaction(db, async (client) => {
    const inserted = await client.query(
      "INSERT INTO app_users(telegram_id, role, balance_micros) VALUES ($1, 'user', 0) ON CONFLICT (telegram_id) DO NOTHING RETURNING telegram_id",
      [userId.toString()]
    );
    await client.query(
      "INSERT INTO app_users(telegram_id, role, balance_micros) VALUES ($1, 'admin', 0) ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin'",
      [adminId.toString()]
    );
    if (inserted.rowCount) {
      await applyLedgerEntry(client, {
        userId,
        kind: "initial_credit",
        amountMicros: initialBalanceMicros,
        idempotencyKey: `initial-credit:${userId}`,
        description: `Начальный тестовый баланс ${microsToTrx(initialBalanceMicros)} TRX`,
        metadata: { source: "environment" }
      });
    }
  });
}

export async function getUserBalance(db: Db, userId: bigint): Promise<bigint> {
  const result = await db.query<{ balance_micros: string }>("SELECT balance_micros FROM app_users WHERE telegram_id = $1", [userId.toString()]);
  if (!result.rows[0]) throw new Error("User not found");
  return BigInt(result.rows[0].balance_micros);
}

export async function getSubscription(db: Db, userId: bigint): Promise<Subscription | null> {
  const result = await db.query<Subscription>("SELECT * FROM autocharging_subscriptions WHERE user_telegram_id = $1", [userId.toString()]);
  return result.rows[0] ?? null;
}

export async function createPendingSubscription(db: Db, input: {
  userId: bigint;
  address: string;
  depositMicros: bigint;
  minimumEnergy: number;
}): Promise<Subscription> {
  const result = await db.query<Subscription>(
    `INSERT INTO autocharging_subscriptions
      (user_telegram_id, tron_address, status, deposit_micros, deposit_status, minimum_energy_72h)
     VALUES ($1, $2, 'pending', $3, 'unknown', $4)
     ON CONFLICT (user_telegram_id) DO NOTHING
     RETURNING *`,
    [input.userId.toString(), input.address, input.depositMicros.toString(), input.minimumEnergy]
  );
  if (!result.rows[0]) throw new Error("A subscription already exists for this user");
  return result.rows[0];
}

export async function activateSubscription(db: Db, subscriptionId: string, userId: bigint, providerBalanceMicros: bigint, depositMicros: bigint): Promise<void> {
  await transaction(db, async (client) => {
    await applyLedgerEntry(client, {
      userId,
      subscriptionId,
      kind: "deposit_charge",
      amountMicros: -depositMicros,
      idempotencyKey: `deposit:${subscriptionId}`,
      description: `Залог Автозаряд Pro: ${microsToTrx(depositMicros)} TRX`,
      metadata: { refundable_under_provider_rules: true }
    });
    await client.query(
      `UPDATE autocharging_subscriptions
       SET status = 'active', souhu_status = 'start', souhu_credit_micros = $2,
           deposit_status = 'held', last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [subscriptionId, providerBalanceMicros.toString()]
    );
  });
}

export async function markSubscriptionError(db: Db, subscriptionId: string, error: string): Promise<void> {
  await db.query(
    "UPDATE autocharging_subscriptions SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1",
    [subscriptionId, error.slice(0, 2000)]
  );
}

export async function setSubscriptionStatus(db: Db, subscriptionId: string, status: "active" | "paused" | "disabled" | "low_balance", souhuStatus: "start" | "stop"): Promise<void> {
  await db.query(
    "UPDATE autocharging_subscriptions SET status = $2, souhu_status = $3, last_error = NULL, updated_at = now() WHERE id = $1",
    [subscriptionId, status, souhuStatus]
  );
}

export async function pauseSubscriptionWithReason(db: Db, subscriptionId: string, reason: string, providerStopConfirmed: boolean): Promise<void> {
  await db.query(
    `UPDATE autocharging_subscriptions
     SET status = 'paused', souhu_status = CASE WHEN $3 THEN 'stop' ELSE souhu_status END,
         last_error = $2, updated_at = now()
     WHERE id = $1`,
    [subscriptionId, reason.slice(0, 2000), providerStopConfirmed]
  );
}

export async function startProviderTopUp(db: Db, input: {
  subscriptionId: string;
  operationKey: string;
  requestedMicros: bigint;
  balanceBeforeMicros: bigint;
}): Promise<void> {
  await db.query(
    `INSERT INTO provider_credit_topups
      (subscription_id, operation_key, requested_micros, balance_before_micros, status)
     VALUES ($1, $2, $3, $4, 'started')`,
    [input.subscriptionId, input.operationKey, input.requestedMicros.toString(), input.balanceBeforeMicros.toString()]
  );
}

export async function finishProviderTopUp(db: Db, input: {
  operationKey: string;
  status: "succeeded" | "reconciled" | "failed" | "uncertain";
  balanceAfterMicros?: bigint;
  response?: unknown;
  error?: string;
}): Promise<void> {
  await db.query(
    `UPDATE provider_credit_topups
     SET status = $2, balance_after_micros = $3, provider_response = $4::jsonb,
         error = $5, completed_at = now()
     WHERE operation_key = $1`,
    [
      input.operationKey,
      input.status,
      input.balanceAfterMicros?.toString() ?? null,
      JSON.stringify(input.response ?? null),
      input.error?.slice(0, 2000) ?? null
    ]
  );
}

export async function savePriceSnapshot(db: Db, input: { channel: string; price65Micros: bigint; price131Micros: bigint; raw: unknown }): Promise<void> {
  await db.query(
    "INSERT INTO price_snapshots(channel, price_65k_micros, price_131k_micros, raw_payload) VALUES ($1, $2, $3, $4::jsonb)",
    [input.channel, input.price65Micros.toString(), input.price131Micros.toString(), JSON.stringify(input.raw)]
  );
}

export async function getLatestPrices(db: Db, channel = "high_frequency"): Promise<{ price65Micros: bigint; price131Micros: bigint } | null> {
  const result = await db.query<{ price_65k_micros: string; price_131k_micros: string }>(
    "SELECT price_65k_micros, price_131k_micros FROM price_snapshots WHERE channel = $1 ORDER BY fetched_at DESC LIMIT 1",
    [channel]
  );
  const row = result.rows[0];
  return row ? { price65Micros: BigInt(row.price_65k_micros), price131Micros: BigInt(row.price_131k_micros) } : null;
}

export async function getActiveSubscriptions(db: Db): Promise<Subscription[]> {
  const result = await db.query<Subscription>(
    "SELECT * FROM autocharging_subscriptions WHERE status IN ('active', 'paused', 'low_balance') ORDER BY id"
  );
  return result.rows;
}

export async function updateProviderSnapshot(db: Db, subscriptionId: string, providerBalanceMicros: bigint, souhuStatus: string): Promise<void> {
  await db.query(
    `UPDATE autocharging_subscriptions
     SET souhu_credit_micros = $2, souhu_status = $3, last_souhu_sync_at = now(), updated_at = now()
     WHERE id = $1`,
    [subscriptionId, providerBalanceMicros.toString(), souhuStatus]
  );
}

export async function recentLedger(db: Db, userId: bigint, limit = 10) {
  const result = await db.query<{
    kind: string; amount_micros: string; balance_after_micros: string; description: string; created_at: Date;
  }>(
    "SELECT kind, amount_micros, balance_after_micros, description, created_at FROM ledger_entries WHERE user_telegram_id = $1 ORDER BY id DESC LIMIT $2",
    [userId.toString(), limit]
  );
  return result.rows;
}

export async function logAudit(db: Db, input: { actorId?: bigint; eventType: string; entityType?: string; entityId?: string; payload?: unknown }): Promise<void> {
  await db.query(
    "INSERT INTO audit_events(actor_telegram_id, event_type, entity_type, entity_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [input.actorId?.toString() ?? null, input.eventType, input.entityType ?? null, input.entityId ?? null, JSON.stringify(input.payload ?? {})]
  );
}

export async function logTelegramEvent(db: Db, input: { updateId?: number; userId?: bigint; direction: "in" | "out"; eventType: string; payload: unknown }): Promise<void> {
  await db.query(
    "INSERT INTO telegram_event_logs(update_id, telegram_user_id, direction, event_type, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [input.updateId ?? null, input.userId?.toString() ?? null, input.direction, input.eventType, JSON.stringify(input.payload)]
  );
}

export async function applyLedgerEntry(client: DbClient, input: {
  userId: bigint;
  subscriptionId?: string;
  usageEventId?: string;
  kind: string;
  amountMicros: bigint;
  idempotencyKey: string;
  description: string;
  metadata?: unknown;
}): Promise<{ applied: boolean; balanceAfterMicros: bigint }> {
  const existing = await client.query<{ balance_after_micros: string }>(
    "SELECT balance_after_micros FROM ledger_entries WHERE idempotency_key = $1",
    [input.idempotencyKey]
  );
  if (existing.rows[0]) return { applied: false, balanceAfterMicros: BigInt(existing.rows[0].balance_after_micros) };

  const user = await client.query<{ balance_micros: string }>(
    "SELECT balance_micros FROM app_users WHERE telegram_id = $1 FOR UPDATE",
    [input.userId.toString()]
  );
  if (!user.rows[0]) throw new Error("Ledger user not found");
  const next = BigInt(user.rows[0].balance_micros) + input.amountMicros;
  if (next < 0n) throw new Error(`Insufficient balance: would become ${microsToTrx(next)} TRX`);
  await client.query("UPDATE app_users SET balance_micros = $2, updated_at = now() WHERE telegram_id = $1", [input.userId.toString(), next.toString()]);
  await client.query(
    `INSERT INTO ledger_entries
      (user_telegram_id, subscription_id, usage_event_id, kind, amount_micros, balance_after_micros, idempotency_key, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [input.userId.toString(), input.subscriptionId ?? null, input.usageEventId ?? null, input.kind, input.amountMicros.toString(), next.toString(), input.idempotencyKey, input.description, JSON.stringify(input.metadata ?? {})]
  );
  return { applied: true, balanceAfterMicros: next };
}
