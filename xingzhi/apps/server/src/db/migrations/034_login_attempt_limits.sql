CREATE TABLE login_attempt_limits (
  identity_digest TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempt_limits_updated_idx ON login_attempt_limits(updated_at);

ALTER TABLE agent_runs ADD COLUMN ledger_month DATE;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_ledger_month_first_day
  CHECK (ledger_month IS NULL OR EXTRACT(DAY FROM ledger_month)=1);
