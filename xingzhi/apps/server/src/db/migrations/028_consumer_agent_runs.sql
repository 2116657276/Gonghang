ALTER TABLE agent_runs
  ALTER COLUMN plan_id DROP NOT NULL,
  ADD COLUMN budget_period_id UUID,
  ADD COLUMN workflow TEXT NOT NULL DEFAULT 'legacy_plan'
    CHECK (workflow IN ('legacy_plan','consumer_planning')),
  ADD CONSTRAINT agent_runs_consumer_period_owner_fkey
    FOREIGN KEY (budget_period_id,owner_id) REFERENCES budget_periods(id,owner_id),
  ADD CONSTRAINT agent_runs_workflow_scope_check CHECK (
    (workflow='legacy_plan' AND plan_id IS NOT NULL AND budget_period_id IS NULL)
    OR (workflow='consumer_planning' AND plan_id IS NULL)
  );

CREATE UNIQUE INDEX agent_runs_consumer_trigger_idx
  ON agent_runs(owner_id,trigger_key) WHERE workflow='consumer_planning';
CREATE UNIQUE INDEX agent_runs_one_active_consumer_idx
  ON agent_runs(owner_id) WHERE workflow='consumer_planning' AND state='RUNNING';
