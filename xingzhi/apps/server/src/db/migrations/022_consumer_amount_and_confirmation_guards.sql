-- Cross-table money equality and confirmation freshness are enforced here;
-- they do not replace the A-side same-transaction funding calculation.
CREATE FUNCTION xz_money_event_validate() RETURNS trigger AS $$
DECLARE linked_entry finance_ledger_entries%ROWTYPE;
BEGIN
  IF NEW.event_type IN ('payment_posted', 'refund_posted') THEN
    SELECT * INTO linked_entry FROM finance_ledger_entries
      WHERE id = NEW.applied_ledger_entry_id;
    IF linked_entry.id IS NULL OR linked_entry.status <> 'posted'
      OR linked_entry.amount_minor <> NEW.amount_minor
      OR linked_entry.source <> NEW.source
      OR (NEW.event_type = 'payment_posted'
        AND linked_entry.direction <> 'outflow')
      OR (NEW.event_type = 'refund_posted'
        AND linked_entry.direction <> 'inflow') THEN
      RAISE EXCEPTION 'posted money event must match posted account entry';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_money_event_validate_before_insert
  BEFORE INSERT ON finance_money_events FOR EACH ROW
  EXECUTE FUNCTION xz_money_event_validate();

CREATE FUNCTION xz_immutable_fact_reject() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'financial or quote evidence cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_money_event_immutable
  BEFORE UPDATE OR DELETE ON finance_money_events FOR EACH ROW
  EXECUTE FUNCTION xz_immutable_fact_reject();
CREATE TRIGGER xz_funding_assessment_immutable
  BEFORE UPDATE OR DELETE ON funding_assessments FOR EACH ROW
  EXECUTE FUNCTION xz_immutable_fact_reject();
CREATE TRIGGER xz_quote_no_delete
  BEFORE DELETE ON offer_quotes FOR EACH ROW
  EXECUTE FUNCTION xz_immutable_fact_reject();
CREATE TRIGGER xz_target_change_immutable
  BEFORE UPDATE OR DELETE ON budget_target_changes FOR EACH ROW
  EXECUTE FUNCTION xz_immutable_fact_reject();

CREATE OR REPLACE FUNCTION xz_purchase_intent_validate() RETURNS trigger AS $$
DECLARE linked_quote offer_quotes%ROWTYPE;
DECLARE linked_period budget_periods%ROWTYPE;
DECLARE linked_account finance_accounts%ROWTYPE;
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
    IF OLD.status = 'proposed' AND NEW.status = 'confirmed' THEN
      SELECT * INTO linked_quote FROM offer_quotes WHERE id = NEW.quote_id;
      SELECT * INTO linked_period FROM budget_periods WHERE id = NEW.period_id;
      SELECT * INTO linked_account FROM finance_accounts
        WHERE id = linked_period.primary_account_id;
      IF linked_quote.status <> 'valid' OR linked_quote.valid_until <= now()
        OR NEW.expires_at <= now()
        OR linked_period.status <> 'active'
        OR linked_period.version <> NEW.period_version
        OR linked_account.status <> 'linked'
        OR linked_account.financial_version <> NEW.financial_version THEN
        RAISE EXCEPTION 'intent confirmation needs current budget, quote and finance versions';
      END IF;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE orders ADD CONSTRAINT orders_consumer_reserved_bounds_check
  CHECK (purchase_intent_id IS NULL OR reserved_minor <= amount_minor);
