ALTER TABLE consumer_demo_scenarios
  ALTER COLUMN period_id DROP NOT NULL,
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'complete'
    CHECK (mode IN ('complete', 'account-only'));
