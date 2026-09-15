CREATE TABLE finance_accounts (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'icbc')),
  account_type TEXT NOT NULL CHECK (account_type IN ('debit', 'credit', 'loan')),
  provider_account_ref TEXT NOT NULL,
  masked_identifier TEXT NOT NULL,
  display_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  source TEXT NOT NULL CHECK (source IN ('demo', 'bank_api')),
  status TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'revoked')),
  authorized_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, provider, provider_account_ref),
  UNIQUE (owner_id, id),
  CHECK ((status = 'linked' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  CHECK ((provider = 'demo' AND source = 'demo') OR (provider = 'icbc' AND source = 'bank_api'))
);
CREATE INDEX finance_accounts_owner_status_idx ON finance_accounts(owner_id, status);

CREATE TABLE finance_account_snapshots (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES finance_accounts(id),
  available_balance_minor INTEGER CHECK (available_balance_minor >= 0),
  current_balance_minor INTEGER,
  outstanding_minor INTEGER CHECK (outstanding_minor >= 0),
  credit_limit_minor INTEGER CHECK (credit_limit_minor >= 0),
  as_of TIMESTAMPTZ NOT NULL,
  covered_through_at TIMESTAMPTZ,
  covered_through_ref TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fact_status TEXT NOT NULL CHECK (fact_status IN ('observed', 'estimated', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('demo', 'bank_api')),
  provider_snapshot_ref TEXT,
  UNIQUE (id, account_id)
);
CREATE UNIQUE INDEX finance_snapshots_source_ref_idx
  ON finance_account_snapshots(account_id, source, provider_snapshot_ref)
  WHERE provider_snapshot_ref IS NOT NULL;
CREATE INDEX finance_snapshots_latest_idx
  ON finance_account_snapshots(account_id, as_of DESC, captured_at DESC);

CREATE TABLE finance_ledger_entries (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  account_id UUID NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('demo', 'bank_api')),
  source_ref TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  posted_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'reversed')),
  category TEXT,
  merchant_name TEXT,
  note TEXT,
  order_id UUID REFERENCES orders(id),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, account_id) REFERENCES finance_accounts(owner_id, id),
  UNIQUE (id, owner_id),
  UNIQUE (account_id, source, dedupe_key),
  CHECK (status <> 'posted' OR posted_at IS NOT NULL)
);
CREATE INDEX finance_ledger_account_posted_idx
  ON finance_ledger_entries(account_id, posted_at DESC, id) WHERE status = 'posted';
CREATE INDEX finance_ledger_owner_occurred_idx
  ON finance_ledger_entries(owner_id, occurred_at DESC);
CREATE INDEX finance_ledger_order_idx
  ON finance_ledger_entries(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE finance_obligations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  liability_account_id UUID,
  repayment_account_id UUID,
  obligation_type TEXT NOT NULL CHECK (obligation_type IN ('credit_bill', 'loan_repayment', 'installment')),
  label TEXT NOT NULL,
  period_label TEXT,
  sequence_no INTEGER CHECK (sequence_no > 0),
  sequence_total INTEGER CHECK (sequence_total > 0),
  due_on DATE NOT NULL,
  amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor >= 0),
  outstanding_minor INTEGER CHECK (outstanding_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'paid', 'overdue', 'unknown', 'cancelled')),
  settled_ledger_entry_id UUID,
  included_in_obligation_id UUID,
  source TEXT NOT NULL CHECK (source IN ('demo', 'bank_api', 'user_input')),
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, liability_account_id) REFERENCES finance_accounts(owner_id, id),
  FOREIGN KEY (owner_id, repayment_account_id) REFERENCES finance_accounts(owner_id, id),
  FOREIGN KEY (settled_ledger_entry_id, owner_id) REFERENCES finance_ledger_entries(id, owner_id),
  FOREIGN KEY (included_in_obligation_id, owner_id) REFERENCES finance_obligations(id, owner_id),
  UNIQUE (id, owner_id),
  CHECK (included_in_obligation_id IS DISTINCT FROM id),
  CHECK ((sequence_no IS NULL AND sequence_total IS NULL) OR
    (sequence_no IS NOT NULL AND sequence_total IS NOT NULL AND sequence_no <= sequence_total))
);
CREATE UNIQUE INDEX finance_obligations_source_ref_idx
  ON finance_obligations(owner_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX finance_obligations_repayment_due_idx
  ON finance_obligations(repayment_account_id, due_on) WHERE status IN ('upcoming', 'overdue', 'unknown');

CREATE TABLE cashflow_plans (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  primary_account_id UUID NOT NULL,
  basis_snapshot_id UUID,
  horizon_start DATE NOT NULL,
  horizon_end DATE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  reserve_target_minor INTEGER NOT NULL CHECK (reserve_target_minor >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, primary_account_id) REFERENCES finance_accounts(owner_id, id),
  FOREIGN KEY (basis_snapshot_id, primary_account_id) REFERENCES finance_account_snapshots(id, account_id),
  UNIQUE (id, owner_id),
  CHECK (horizon_end >= horizon_start),
  CHECK (length(timezone) > 0)
);
CREATE UNIQUE INDEX cashflow_plans_one_active_account_idx
  ON cashflow_plans(owner_id, primary_account_id) WHERE status = 'active';
CREATE INDEX cashflow_plans_owner_status_idx ON cashflow_plans(owner_id, status, updated_at DESC);

CREATE TABLE cashflow_plan_items (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  cashflow_plan_id UUID NOT NULL,
  line_type TEXT NOT NULL CHECK (line_type IN ('income', 'essential_expense', 'planned_spend')),
  label TEXT NOT NULL,
  category_code TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  due_on DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'user_input' CHECK (source = 'user_input'),
  fact_status TEXT NOT NULL DEFAULT 'estimated' CHECK (fact_status IN ('estimated', 'confirmed', 'cancelled')),
  related_plan_id UUID REFERENCES plans(id),
  selected_plan_item_id UUID REFERENCES plan_items(id),
  settled_ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (cashflow_plan_id, owner_id) REFERENCES cashflow_plans(id, owner_id),
  FOREIGN KEY (settled_ledger_entry_id, owner_id) REFERENCES finance_ledger_entries(id, owner_id),
  CHECK (selected_plan_item_id IS NULL OR (line_type = 'planned_spend' AND related_plan_id IS NOT NULL))
);
CREATE INDEX cashflow_plan_items_due_idx
  ON cashflow_plan_items(cashflow_plan_id, due_on) WHERE fact_status <> 'cancelled';
CREATE INDEX cashflow_plan_items_related_plan_idx
  ON cashflow_plan_items(related_plan_id) WHERE related_plan_id IS NOT NULL;
