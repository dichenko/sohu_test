CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  telegram_id bigint PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('user', 'admin')),
  balance_micros bigint NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS autocharging_subscriptions (
  id bigserial PRIMARY KEY,
  user_telegram_id bigint NOT NULL UNIQUE REFERENCES app_users(telegram_id),
  tron_address text NOT NULL UNIQUE,
  tariff text NOT NULL DEFAULT 'pro' CHECK (tariff IN ('pro')),
  souhu_channel text NOT NULL DEFAULT 'high_frequency',
  status text NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'disabled', 'low_balance', 'error')),
  souhu_status text,
  souhu_credit_micros bigint,
  deposit_micros bigint NOT NULL,
  deposit_status text NOT NULL DEFAULT 'held' CHECK (deposit_status IN ('held', 'returned', 'unknown', 'possibly_forfeited')),
  cycle_started_at timestamptz NOT NULL DEFAULT now(),
  cycle_ends_at timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  cycle_energy_used bigint NOT NULL DEFAULT 0,
  minimum_energy_72h bigint NOT NULL,
  last_souhu_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  price_65k_micros bigint NOT NULL,
  price_131k_micros bigint NOT NULL,
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_snapshots_channel_fetched_idx ON price_snapshots(channel, fetched_at DESC);

CREATE TABLE IF NOT EXISTS autocharging_cycles (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES autocharging_subscriptions(id),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  minimum_energy bigint NOT NULL,
  used_energy bigint NOT NULL DEFAULT 0,
  deposit_micros bigint NOT NULL,
  deposit_status text NOT NULL,
  closed_at timestamptz,
  raw_provider_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id, started_at)
);

CREATE TABLE IF NOT EXISTS provider_usage_events (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES autocharging_subscriptions(id),
  provider_key text NOT NULL UNIQUE,
  used_tx_id text,
  delegate_tx_id text,
  undelegate_tx_id text,
  energy_type text,
  allocated_energy bigint,
  used_energy bigint,
  souhu_cost_micros bigint,
  charged_micros bigint NOT NULL DEFAULT 0,
  refunded_micros bigint NOT NULL DEFAULT 0,
  fee_micros bigint NOT NULL DEFAULT 0,
  provider_status text,
  source_created_at timestamptz,
  processed_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_usage_used_tx_unique ON provider_usage_events(used_tx_id) WHERE used_tx_id IS NOT NULL AND used_tx_id <> '';

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  user_telegram_id bigint NOT NULL REFERENCES app_users(telegram_id),
  subscription_id bigint REFERENCES autocharging_subscriptions(id),
  usage_event_id bigint REFERENCES provider_usage_events(id),
  kind text NOT NULL CHECK (kind IN ('initial_credit', 'deposit_charge', 'deposit_refund', 'energy_charge', 'unused_energy_refund', 'manual_adjustment')),
  amount_micros bigint NOT NULL,
  balance_after_micros bigint NOT NULL CHECK (balance_after_micros >= 0),
  idempotency_key text NOT NULL UNIQUE,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_created_idx ON ledger_entries(user_telegram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_http_logs (
  id bigserial PRIMARY KEY,
  correlation_id uuid NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_query jsonb,
  request_body jsonb,
  response_status integer,
  response_body jsonb,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_http_created_idx ON provider_http_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_event_logs (
  id bigserial PRIMARY KEY,
  update_id bigint,
  telegram_user_id bigint,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_telegram_id bigint,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at DESC);
