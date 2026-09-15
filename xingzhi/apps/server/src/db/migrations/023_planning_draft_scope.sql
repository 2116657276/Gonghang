-- A requirement draft can exist before the consumer selects an account and
-- monthly budget. Budget-linked drafts keep all three basis fields together.
ALTER TABLE planning_drafts
  ALTER COLUMN period_id DROP NOT NULL,
  ALTER COLUMN basis_financial_version DROP NOT NULL,
  ALTER COLUMN basis_period_version DROP NOT NULL,
  ADD CONSTRAINT planning_drafts_owner_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id),
  ADD CONSTRAINT planning_drafts_basis_scope_check CHECK (
    (period_id IS NULL
      AND basis_financial_version IS NULL
      AND basis_period_version IS NULL)
    OR
    (period_id IS NOT NULL
      AND basis_financial_version IS NOT NULL
      AND basis_period_version IS NOT NULL)
  );
