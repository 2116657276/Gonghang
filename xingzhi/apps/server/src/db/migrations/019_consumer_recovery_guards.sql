-- Revocation must prevent new execution, not prevent closing an old budget or
-- recording a later verified settlement for a historical period.
CREATE OR REPLACE FUNCTION xz_budget_period_validate() RETURNS trigger AS $$
DECLARE
  linked_account finance_accounts%ROWTYPE;
  linked_snapshot finance_account_snapshots%ROWTYPE;
  owner_role TEXT;
BEGIN
  SELECT role INTO owner_role FROM users WHERE id = NEW.owner_id;
  IF owner_role IS DISTINCT FROM 'consumer' THEN
    RAISE EXCEPTION 'budget owner must be a consumer';
  END IF;
  SELECT * INTO linked_account FROM finance_accounts
    WHERE id = NEW.primary_account_id AND owner_id = NEW.owner_id;
  IF linked_account.id IS NULL OR linked_account.account_type <> 'debit' THEN
    RAISE EXCEPTION 'budget requires a debit account owned by consumer';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status = 'closed'
    OR linked_account.status <> 'linked') THEN
    RAISE EXCEPTION 'new budget requires linked account and open lifecycle';
  END IF;
  IF NEW.status = 'active' THEN
    SELECT * INTO linked_snapshot FROM finance_account_snapshots
      WHERE id = NEW.baseline_snapshot_id
        AND account_id = NEW.primary_account_id;
    IF linked_account.status <> 'linked'
      OR linked_snapshot.id IS NULL
      OR linked_snapshot.fact_status <> 'observed'
      OR linked_snapshot.source <> linked_account.source
      OR linked_snapshot.available_balance_minor IS NULL
      OR linked_snapshot.covered_through_at IS NULL THEN
      RAISE EXCEPTION 'active budget requires linked debit account and complete observed snapshot';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.status = 'active' AND NEW.status = 'draft')
    OR (OLD.status = 'closed' AND NEW.status <> 'closed')
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.primary_account_id IS DISTINCT FROM OLD.primary_account_id
    OR NEW.month_start IS DISTINCT FROM OLD.month_start
    OR NEW.month_end IS DISTINCT FROM OLD.month_end) THEN
    RAISE EXCEPTION 'budget identity and lifecycle cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION xz_budget_item_validate() RETURNS trigger AS $$
DECLARE
  period_row budget_periods%ROWTYPE;
  settled_row finance_ledger_entries%ROWTYPE;
BEGIN
  SELECT * INTO period_row FROM budget_periods WHERE id = NEW.period_id;
  IF period_row.id IS NULL
    OR NEW.planned_on < period_row.month_start
    OR NEW.planned_on > period_row.month_end THEN
    RAISE EXCEPTION 'budget item must belong to its calendar-month period';
  END IF;
  IF period_row.status = 'closed' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'closed budget does not accept new items';
    ELSIF NEW.status <> 'settled'
      OR OLD.status NOT IN ('committed', 'settled')
      OR ROW(NEW.title, NEW.category_code, NEW.planned_on,
        NEW.user_estimated_amount_minor, NEW.priority)
        IS DISTINCT FROM ROW(OLD.title, OLD.category_code, OLD.planned_on,
          OLD.user_estimated_amount_minor, OLD.priority) THEN
      RAISE EXCEPTION 'closed budget only accepts later verified settlement';
    END IF;
  END IF;
  IF NEW.status = 'settled' THEN
    SELECT * INTO settled_row FROM finance_ledger_entries
      WHERE id = NEW.settled_ledger_entry_id
        AND owner_id = NEW.owner_id AND account_id = NEW.account_id;
    IF settled_row.id IS NULL OR settled_row.status <> 'posted'
      OR (NEW.kind = 'expected_income' AND settled_row.direction <> 'inflow')
      OR (NEW.kind <> 'expected_income' AND settled_row.direction <> 'outflow') THEN
      RAISE EXCEPTION 'settled budget item requires matching posted account entry';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.period_id IS DISTINCT FROM OLD.period_id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR (OLD.status IN ('committed', 'settled')
        AND (NEW.status = 'planned'
          OR NEW.user_estimated_amount_minor IS DISTINCT FROM OLD.user_estimated_amount_minor)) THEN
      RAISE EXCEPTION 'committed budget item identity and estimate are immutable';
    END IF;
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION xz_consumer_order_identity_on_update() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.budget_period_id IS DISTINCT FROM OLD.budget_period_id
    OR NEW.purchase_intent_id IS DISTINCT FROM OLD.purchase_intent_id THEN
    RAISE EXCEPTION 'order financial owner and purchase intent cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_consumer_order_identity_before_update
  BEFORE UPDATE ON orders FOR EACH ROW
  EXECUTE FUNCTION xz_consumer_order_identity_on_update();
