-- New consumer budgeting has a calendar-month write model. The earlier 30-day
-- cashflow tables remain untouched and are not written by the new workflow.
ALTER TABLE finance_accounts
  ADD COLUMN financial_version BIGINT NOT NULL DEFAULT 1
    CHECK (financial_version > 0),
  ADD CONSTRAINT finance_accounts_id_source_key UNIQUE (id, source);

ALTER TABLE finance_account_snapshots
  ADD CONSTRAINT finance_snapshots_account_source_fkey
    FOREIGN KEY (account_id, source) REFERENCES finance_accounts(id, source);

ALTER TABLE finance_ledger_entries
  ADD CONSTRAINT finance_ledger_account_source_fkey
    FOREIGN KEY (account_id, source) REFERENCES finance_accounts(id, source),
  ADD CONSTRAINT finance_ledger_id_owner_account_key
    UNIQUE (id, owner_id, account_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_id_owner_key UNIQUE (id, owner_id);

ALTER TABLE finance_ledger_entries
  ADD CONSTRAINT finance_ledger_order_owner_fkey
    FOREIGN KEY (order_id, owner_id) REFERENCES orders(id, owner_id);

CREATE TABLE budget_periods (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  primary_account_id UUID NOT NULL,
  baseline_snapshot_id UUID,
  month_start DATE NOT NULL,
  month_end DATE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (timezone = 'Asia/Shanghai'),
  savings_target_minor BIGINT NOT NULL CHECK (savings_target_minor >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, primary_account_id)
    REFERENCES finance_accounts(owner_id, id),
  FOREIGN KEY (baseline_snapshot_id, primary_account_id)
    REFERENCES finance_account_snapshots(id, account_id),
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, primary_account_id),
  UNIQUE (owner_id, primary_account_id, month_start),
  CHECK (EXTRACT(DAY FROM month_start) = 1),
  CHECK (month_end = (month_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE),
  CHECK ((status = 'active' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE INDEX budget_periods_owner_month_idx
  ON budget_periods(owner_id, month_start DESC);

CREATE TABLE budget_items (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  account_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('expected_income', 'essential_expense', 'planned_spend')),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  category_code TEXT,
  planned_on DATE NOT NULL,
  user_estimated_amount_minor BIGINT NOT NULL
    CHECK (user_estimated_amount_minor > 0),
  priority TEXT NOT NULL CHECK (priority IN ('required', 'adjustable')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN
    ('planned', 'committed', 'settled', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'user_input' CHECK (source = 'user_input'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  settled_ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id, account_id)
    REFERENCES budget_periods(id, owner_id, primary_account_id),
  FOREIGN KEY (settled_ledger_entry_id, owner_id, account_id)
    REFERENCES finance_ledger_entries(id, owner_id, account_id),
  UNIQUE (id, owner_id, period_id),
  CHECK (kind <> 'essential_expense' OR priority = 'required'),
  CHECK (status <> 'settled' OR settled_ledger_entry_id IS NOT NULL)
);
CREATE INDEX budget_items_period_day_idx
  ON budget_items(period_id, planned_on)
  WHERE status <> 'cancelled';

CREATE TABLE budget_target_changes (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  confirmed_by UUID NOT NULL REFERENCES users(id),
  previous_target_minor BIGINT NOT NULL CHECK (previous_target_minor >= 0),
  new_target_minor BIGINT NOT NULL CHECK (new_target_minor >= 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 200),
  basis_period_version BIGINT NOT NULL CHECK (basis_period_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id) REFERENCES budget_periods(id, owner_id),
  CHECK (confirmed_by = owner_id),
  CHECK (previous_target_minor <> new_target_minor)
);
CREATE INDEX budget_target_changes_period_idx
  ON budget_target_changes(period_id, created_at DESC);

-- All controlled writes to account facts invalidate prior funding assessments.
CREATE FUNCTION xz_account_version_on_update() RETURNS trigger AS $$
BEGIN
  NEW.financial_version := OLD.financial_version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_account_version_before_update
  BEFORE UPDATE ON finance_accounts FOR EACH ROW
  EXECUTE FUNCTION xz_account_version_on_update();

CREATE FUNCTION xz_period_version_on_update() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_period_version_before_update
  BEFORE UPDATE ON budget_periods FOR EACH ROW
  EXECUTE FUNCTION xz_period_version_on_update();

CREATE FUNCTION xz_account_version_from_fact() RETURNS trigger AS $$
DECLARE
  target_id UUID;
  previous_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'finance_obligations' THEN
    IF TG_OP <> 'DELETE' THEN target_id := NEW.repayment_account_id; END IF;
    IF TG_OP <> 'INSERT' THEN previous_id := OLD.repayment_account_id; END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN target_id := NEW.account_id; END IF;
    IF TG_OP <> 'INSERT' THEN previous_id := OLD.account_id; END IF;
  END IF;
  IF target_id IS NOT NULL THEN
    UPDATE finance_accounts SET updated_at = now() WHERE id = target_id;
  END IF;
  IF previous_id IS NOT NULL AND previous_id IS DISTINCT FROM target_id THEN
    UPDATE finance_accounts SET updated_at = now() WHERE id = previous_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_snapshot_version_after_write
  AFTER INSERT OR UPDATE OR DELETE ON finance_account_snapshots
  FOR EACH ROW EXECUTE FUNCTION xz_account_version_from_fact();
CREATE TRIGGER xz_ledger_version_after_write
  AFTER INSERT OR UPDATE OR DELETE ON finance_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION xz_account_version_from_fact();
CREATE TRIGGER xz_obligation_version_after_write
  AFTER INSERT OR UPDATE OR DELETE ON finance_obligations
  FOR EACH ROW EXECUTE FUNCTION xz_account_version_from_fact();

CREATE FUNCTION xz_period_version_from_item() RETURNS trigger AS $$
DECLARE
  target_id UUID;
  previous_id UUID;
BEGIN
  IF TG_OP <> 'DELETE' THEN target_id := NEW.period_id; END IF;
  IF TG_OP <> 'INSERT' THEN previous_id := OLD.period_id; END IF;
  UPDATE budget_periods SET updated_at = now()
  WHERE id = target_id;
  IF previous_id IS NOT NULL AND previous_id IS DISTINCT FROM target_id THEN
    UPDATE budget_periods SET updated_at = now() WHERE id = previous_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION xz_budget_item_validate() RETURNS trigger AS $$
DECLARE period_row budget_periods%ROWTYPE;
BEGIN
  SELECT * INTO period_row FROM budget_periods WHERE id = NEW.period_id;
  IF period_row.id IS NULL OR period_row.status <> 'active'
    OR NEW.planned_on < period_row.month_start
    OR NEW.planned_on > period_row.month_end THEN
    RAISE EXCEPTION 'budget item must belong to an active period and its calendar month';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.version := OLD.version + 1; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_budget_item_validate_before_write
  BEFORE INSERT OR UPDATE ON budget_items
  FOR EACH ROW EXECUTE FUNCTION xz_budget_item_validate();
CREATE TRIGGER xz_budget_item_version_after_write
  AFTER INSERT OR UPDATE OR DELETE ON budget_items
  FOR EACH ROW EXECUTE FUNCTION xz_period_version_from_item();
