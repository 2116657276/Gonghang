ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_state_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_state_check
  CHECK (state IN ('RUNNING','WAITING_USER','COMPLETED','FAILED','CANCELLED'));

-- A decision round ends after one draft; its confirmation remains a separate UI action.
CREATE TABLE agent_run_proposals (
  run_id UUID PRIMARY KEY REFERENCES agent_runs(id),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('propose_purchase','propose_change')),
  request_payload JSONB NOT NULL,
  proposal_id UUID NOT NULL UNIQUE REFERENCES proposals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
