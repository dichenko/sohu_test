CREATE TABLE IF NOT EXISTS provider_credit_topups (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES autocharging_subscriptions(id),
  operation_key uuid NOT NULL UNIQUE,
  requested_micros bigint NOT NULL CHECK (requested_micros > 0),
  balance_before_micros bigint NOT NULL CHECK (balance_before_micros >= 0),
  balance_after_micros bigint CHECK (balance_after_micros >= 0),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'reconciled', 'failed', 'uncertain')),
  provider_response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS provider_credit_topups_subscription_created_idx
  ON provider_credit_topups(subscription_id, created_at DESC);
