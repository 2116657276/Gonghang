ALTER TABLE manual_tasks
  ALTER COLUMN plan_id DROP NOT NULL,
  ALTER COLUMN merchant_id DROP NOT NULL,
  ADD COLUMN budget_period_id UUID,
  ADD COLUMN responsible_provider TEXT,
  ADD CONSTRAINT manual_tasks_consumer_period_owner_fkey
    FOREIGN KEY (budget_period_id) REFERENCES budget_periods(id),
  ADD CONSTRAINT manual_tasks_legacy_or_consumer_scope_check
    CHECK ((plan_id IS NOT NULL AND merchant_id IS NOT NULL
        AND budget_period_id IS NULL AND responsible_provider IS NULL)
      OR (plan_id IS NULL AND merchant_id IS NULL
        AND budget_period_id IS NOT NULL
        AND responsible_provider IS NOT NULL
        AND length(btrim(responsible_provider)) > 0));

CREATE INDEX manual_tasks_consumer_period_idx
  ON manual_tasks(budget_period_id, state, next_review_at)
  WHERE budget_period_id IS NOT NULL;
