-- A budget may be drafted with an incomplete balance basis, but it cannot
-- become executable until its debit-account snapshot is observed and covered.
ALTER TABLE budget_periods DROP CONSTRAINT budget_periods_status_check;
ALTER TABLE budget_periods ADD CONSTRAINT budget_periods_status_check
  CHECK (status IN ('draft', 'active', 'closed'));
ALTER TABLE budget_periods DROP CONSTRAINT budget_periods_check1;
ALTER TABLE budget_periods ADD CONSTRAINT budget_periods_lifecycle_check
  CHECK ((status IN ('draft', 'active') AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL));

CREATE FUNCTION xz_budget_period_validate() RETURNS trigger AS $$
DECLARE
  linked_account finance_accounts%ROWTYPE;
  linked_snapshot finance_account_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO linked_account FROM finance_accounts
    WHERE id = NEW.primary_account_id AND owner_id = NEW.owner_id;
  IF linked_account.id IS NULL OR linked_account.account_type <> 'debit'
    OR linked_account.status <> 'linked' THEN
    RAISE EXCEPTION 'budget requires an authorized debit account owned by consumer';
  END IF;
  IF NEW.status = 'active' THEN
    SELECT * INTO linked_snapshot FROM finance_account_snapshots
      WHERE id = NEW.baseline_snapshot_id
        AND account_id = NEW.primary_account_id;
    IF linked_snapshot.id IS NULL
      OR linked_snapshot.fact_status <> 'observed'
      OR linked_snapshot.source <> linked_account.source
      OR linked_snapshot.available_balance_minor IS NULL
      OR linked_snapshot.covered_through_at IS NULL THEN
      RAISE EXCEPTION 'active budget requires a complete observed debit snapshot';
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
CREATE TRIGGER xz_budget_period_validate_before_write
  BEFORE INSERT OR UPDATE ON budget_periods
  FOR EACH ROW EXECUTE FUNCTION xz_budget_period_validate();

CREATE OR REPLACE FUNCTION xz_budget_item_validate() RETURNS trigger AS $$
DECLARE
  period_row budget_periods%ROWTYPE;
  settled_row finance_ledger_entries%ROWTYPE;
BEGIN
  SELECT * INTO period_row FROM budget_periods WHERE id = NEW.period_id;
  IF period_row.id IS NULL OR period_row.status = 'closed'
    OR NEW.planned_on < period_row.month_start
    OR NEW.planned_on > period_row.month_end THEN
    RAISE EXCEPTION 'budget item must belong to an open calendar-month period';
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

-- Preserve the confirmation evidence even if a confirmed intent expires.
ALTER TABLE purchase_intents DROP CONSTRAINT purchase_intents_check;
ALTER TABLE purchase_intents ADD CONSTRAINT purchase_intents_confirmation_check
  CHECK ((status = 'proposed' AND accepted_amount_minor IS NULL
      AND confirmed_at IS NULL)
    OR (status IN ('confirmed', 'ordered')
      AND accepted_amount_minor IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (status IN ('expired', 'rejected')
      AND ((accepted_amount_minor IS NULL AND confirmed_at IS NULL)
        OR (accepted_amount_minor IS NOT NULL AND confirmed_at IS NOT NULL))));

CREATE FUNCTION xz_purchase_intent_validate() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'purchase intent must start as proposed';
    END IF;
  ELSE
    IF ROW(NEW.owner_id, NEW.period_id, NEW.budget_item_id, NEW.quote_id,
        NEW.assessment_id, NEW.financial_version, NEW.period_version,
        NEW.quote_version, NEW.expires_at, NEW.idempotency_key)
      IS DISTINCT FROM ROW(OLD.owner_id, OLD.period_id, OLD.budget_item_id,
        OLD.quote_id, OLD.assessment_id, OLD.financial_version,
        OLD.period_version, OLD.quote_version, OLD.expires_at,
        OLD.idempotency_key)
      OR (OLD.status = 'proposed' AND NEW.status NOT IN
        ('proposed', 'confirmed', 'expired', 'rejected'))
      OR (OLD.status = 'confirmed' AND NEW.status NOT IN
        ('confirmed', 'ordered', 'expired', 'rejected'))
      OR (OLD.status IN ('ordered', 'expired', 'rejected')
        AND NEW.status IS DISTINCT FROM OLD.status)
      OR (OLD.confirmed_at IS NOT NULL
        AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
          OR NEW.accepted_amount_minor IS DISTINCT FROM OLD.accepted_amount_minor)) THEN
      RAISE EXCEPTION 'purchase intent scope and lifecycle are immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_purchase_intent_validate_before_write
  BEFORE INSERT OR UPDATE ON purchase_intents
  FOR EACH ROW EXECUTE FUNCTION xz_purchase_intent_validate();

CREATE FUNCTION xz_consumer_order_validate() RETURNS trigger AS $$
DECLARE
  linked_intent purchase_intents%ROWTYPE;
  linked_quote offer_quotes%ROWTYPE;
  linked_period budget_periods%ROWTYPE;
BEGIN
  IF NEW.purchase_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO linked_intent FROM purchase_intents
    WHERE id = NEW.purchase_intent_id FOR UPDATE;
  SELECT * INTO linked_quote FROM offer_quotes
    WHERE id = linked_intent.quote_id;
  SELECT * INTO linked_period FROM budget_periods
    WHERE id = NEW.budget_period_id;
  IF linked_intent.id IS NULL OR linked_intent.status <> 'confirmed'
    OR linked_intent.owner_id <> NEW.owner_id
    OR linked_intent.period_id <> NEW.budget_period_id
    OR linked_intent.accepted_amount_minor <> NEW.amount_minor
    OR linked_quote.status <> 'valid' OR linked_quote.valid_until <= now()
    OR linked_intent.expires_at <= now()
    OR linked_period.status <> 'active' THEN
    RAISE EXCEPTION 'new order requires current confirmed quote, amount and active budget';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_consumer_order_validate_before_insert
  BEFORE INSERT ON orders FOR EACH ROW
  EXECUTE FUNCTION xz_consumer_order_validate();
