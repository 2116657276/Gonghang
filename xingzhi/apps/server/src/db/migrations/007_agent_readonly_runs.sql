CREATE TABLE agent_runs (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  trigger_key TEXT NOT NULL,
  input TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RUNNING','COMPLETED','FAILED','CANCELLED')),
  output TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline TIMESTAMPTZ NOT NULL DEFAULT now() + interval '120 seconds',
  finished_at TIMESTAMPTZ,
  UNIQUE (plan_id, trigger_key)
);
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs(plan_id) WHERE state='RUNNING';
CREATE TABLE agent_rate_limits (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  tokens DOUBLE PRECISION NOT NULL CHECK (tokens >= 0 AND tokens <= 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
