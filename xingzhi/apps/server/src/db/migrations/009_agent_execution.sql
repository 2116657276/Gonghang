ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_state_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_state_check
  CHECK (state IN ('RUNNING','WAITING_USER','WAITING_EXTERNAL','COMPLETED','FAILED','CANCELLED'));
ALTER TABLE agent_runs ADD COLUMN parent_run_id UUID REFERENCES agent_runs(id);
ALTER TABLE agent_runs ADD COLUMN trigger_event_id BIGINT REFERENCES events(id);

CREATE TABLE agent_tool_calls (
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('create_order','request_payment','pause_purchases','submit_change')),
  request_payload JSONB NOT NULL,
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,tool_call_id)
);
CREATE TABLE agent_run_operations (
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  operation_id UUID NOT NULL REFERENCES operations(id),
  PRIMARY KEY(run_id,operation_id)
);
CREATE TABLE agent_order_watches (
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('purchase','change')),
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY(run_id,order_id)
);
CREATE TABLE agent_wakeups (
  id BIGSERIAL PRIMARY KEY,
  parent_run_id UUID NOT NULL REFERENCES agent_runs(id),
  event_id BIGINT NOT NULL REFERENCES events(id),
  event_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched','completed','failed')),
  run_id UUID REFERENCES agent_runs(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parent_run_id,event_key)
);
CREATE INDEX agent_wakeups_pending ON agent_wakeups(next_run_at) WHERE state IN ('pending','dispatched');
