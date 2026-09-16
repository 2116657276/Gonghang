CREATE TABLE finance_ledger_category_overrides (
  entry_id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  display_category TEXT NOT NULL CHECK (display_category IN (
    'food','housing','transport','utilities','health','education','shopping',
    'entertainment','repayment','income','refund','purchase','unexpected','other'
  )),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (entry_id, owner_id) REFERENCES finance_ledger_entries(id, owner_id)
);

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE planning_drafts ADD CONSTRAINT planning_drafts_id_owner_key UNIQUE (id, owner_id);

CREATE TABLE consumer_agent_artifacts (
  run_id UUID NOT NULL,
  draft_id UUID NOT NULL UNIQUE,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, draft_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES agent_runs(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id, owner_id) REFERENCES planning_drafts(id, owner_id)
);

CREATE TABLE consumer_aftercare_previews (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  budget_period_id UUID NOT NULL,
  order_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('close','cancel')),
  order_status TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  rule_preset TEXT NOT NULL CHECK (rule_preset IN
    ('full_refund','fee_80','two_batches','reject','delay')),
  accepted_fee_minor INTEGER NOT NULL CHECK (accepted_fee_minor >= 0),
  accepted_refund_minor INTEGER NOT NULL CHECK (accepted_refund_minor >= 0),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','accepted','expired')),
  confirmed_at TIMESTAMPTZ,
  operation_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, owner_id) REFERENCES orders(id, owner_id),
  FOREIGN KEY (budget_period_id, owner_id) REFERENCES budget_periods(id, owner_id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'proposed' AND confirmed_at IS NULL)
    OR (status IN ('accepted','expired')))
);
CREATE INDEX consumer_aftercare_order_idx
  ON consumer_aftercare_previews(order_id, created_at DESC);

ALTER TABLE operations
  ADD COLUMN aftercare_preview_id UUID REFERENCES consumer_aftercare_previews(id);
CREATE UNIQUE INDEX operations_aftercare_preview_idx
  ON operations(aftercare_preview_id) WHERE aftercare_preview_id IS NOT NULL;
ALTER TABLE consumer_aftercare_previews
  ADD CONSTRAINT consumer_aftercare_operation_fkey
    FOREIGN KEY (operation_id) REFERENCES operations(id);

ALTER TABLE cancellation_requests
  ADD COLUMN aftercare_preview_id UUID REFERENCES consumer_aftercare_previews(id);
ALTER TABLE cancellation_requests
  DROP CONSTRAINT cancellation_requests_legacy_or_consumer_check;
ALTER TABLE cancellation_requests
  ADD CONSTRAINT cancellation_requests_legacy_or_consumer_check CHECK (
    (proposal_id IS NOT NULL AND confirmation_id IS NOT NULL
      AND budget_adjustment_id IS NULL AND owner_id IS NULL
      AND aftercare_preview_id IS NULL)
    OR (proposal_id IS NULL AND confirmation_id IS NULL
      AND budget_adjustment_id IS NOT NULL AND owner_id IS NOT NULL
      AND aftercare_preview_id IS NULL)
    OR (proposal_id IS NULL AND confirmation_id IS NULL
      AND budget_adjustment_id IS NULL AND owner_id IS NOT NULL
      AND aftercare_preview_id IS NOT NULL)
  );
CREATE UNIQUE INDEX cancellation_requests_aftercare_preview_idx
  ON cancellation_requests(aftercare_preview_id)
  WHERE aftercare_preview_id IS NOT NULL;

CREATE TABLE consumer_demo_scenarios (
  scenario_key TEXT PRIMARY KEY CHECK (length(btrim(scenario_key)) BETWEEN 3 AND 80),
  owner_id UUID NOT NULL REFERENCES users(id),
  account_id UUID NOT NULL,
  period_id UUID NOT NULL,
  service_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, owner_id) REFERENCES finance_accounts(id, owner_id),
  FOREIGN KEY (period_id, owner_id, account_id)
    REFERENCES budget_periods(id, owner_id, primary_account_id),
  UNIQUE (owner_id),
  UNIQUE (account_id),
  UNIQUE (period_id)
);
