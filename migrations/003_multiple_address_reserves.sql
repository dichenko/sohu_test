-- Hide old single-address records while preserving experimental history.
ALTER TABLE autocharging_subscriptions DROP CONSTRAINT autocharging_subscriptions_user_telegram_id_key;
ALTER TABLE autocharging_subscriptions DROP CONSTRAINT autocharging_subscriptions_tron_address_key;
ALTER TABLE autocharging_subscriptions ADD COLUMN reserve_balance_micros numeric(38,0) NOT NULL DEFAULT 0;
ALTER TABLE autocharging_subscriptions ADD COLUMN low_balance_notified boolean NOT NULL DEFAULT false;
ALTER TABLE autocharging_subscriptions ADD COLUMN deleted_at timestamptz;
ALTER TABLE autocharging_subscriptions ADD COLUMN accounting_version smallint NOT NULL DEFAULT 1;
ALTER TABLE autocharging_subscriptions ADD COLUMN provider_stop_pending boolean NOT NULL DEFAULT false;
ALTER TABLE autocharging_subscriptions ADD COLUMN provider_connected boolean NOT NULL DEFAULT false;
ALTER TABLE autocharging_subscriptions ADD COLUMN billing_started_at timestamptz NOT NULL DEFAULT now();
UPDATE autocharging_subscriptions SET deleted_at=now(), provider_stop_pending=(souhu_status IS DISTINCT FROM 'stop'),provider_connected=true;
ALTER TABLE autocharging_subscriptions ALTER COLUMN accounting_version SET DEFAULT 2;
CREATE UNIQUE INDEX subscriptions_visible_address_unique ON autocharging_subscriptions(tron_address) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_owner_visible_idx ON autocharging_subscriptions(user_telegram_id,id) WHERE deleted_at IS NULL;
ALTER TABLE autocharging_subscriptions ALTER COLUMN deposit_micros SET DEFAULT 0;
ALTER TABLE autocharging_subscriptions DROP CONSTRAINT autocharging_subscriptions_deposit_status_check;
ALTER TABLE autocharging_subscriptions ADD CONSTRAINT autocharging_subscriptions_deposit_status_check
CHECK (deposit_status IN ('held','returned','unknown','possibly_forfeited','not_required'));
ALTER TABLE autocharging_subscriptions ALTER COLUMN deposit_status SET DEFAULT 'not_required';
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_balance_after_micros_check;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_kind_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK
(kind IN ('initial_credit','deposit_charge','deposit_refund','energy_charge','unused_energy_refund','manual_adjustment','reserve_topup'));
ALTER TABLE ledger_entries ALTER COLUMN amount_micros TYPE numeric(38,0);
ALTER TABLE ledger_entries ALTER COLUMN balance_after_micros TYPE numeric(38,0);
CREATE INDEX ledger_address_id_idx ON ledger_entries(subscription_id,id);
DROP INDEX provider_usage_used_tx_unique;
CREATE UNIQUE INDEX provider_usage_address_tx_unique ON provider_usage_events(subscription_id,used_tx_id)
WHERE used_tx_id IS NOT NULL AND used_tx_id<>'';
CREATE INDEX usage_address_id_idx ON provider_usage_events(subscription_id,id);
CREATE TABLE provider_order_baselines (
  subscription_id bigint NOT NULL REFERENCES autocharging_subscriptions(id),
  provider_key text NOT NULL,
  PRIMARY KEY(subscription_id,provider_key)
);
CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY,
  subscription_id bigint REFERENCES autocharging_subscriptions(id),
  idempotency_key text NOT NULL UNIQUE,
  text text NOT NULL,
  delivered_at timestamptz,
  user_delivered_at timestamptz,
  admin_delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON notification_outbox(id) WHERE delivered_at IS NULL;
