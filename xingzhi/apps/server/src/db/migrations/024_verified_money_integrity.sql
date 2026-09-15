-- One account posting is one cash fact, even if a provider retries with a new event ID.
CREATE UNIQUE INDEX finance_money_events_posted_entry_once_idx
  ON finance_money_events(applied_ledger_entry_id)
  WHERE event_type IN ('payment_posted', 'refund_posted');

CREATE UNIQUE INDEX finance_money_events_payment_once_order_idx
  ON finance_money_events(order_id)
  WHERE event_type = 'payment_posted';

-- A posted entry linked to immutable money evidence must remain the same fact.
-- Corrections are separate reversing entries, not edits to historic evidence.
CREATE FUNCTION xz_linked_posted_ledger_immutable() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_money_events
      WHERE applied_ledger_entry_id = OLD.id
        AND event_type IN ('payment_posted', 'refund_posted')) THEN
    IF TG_OP = 'DELETE' OR ROW(NEW.owner_id, NEW.account_id, NEW.source,
      NEW.source_ref, NEW.direction, NEW.amount_minor, NEW.occurred_at,
      NEW.posted_at, NEW.status, NEW.order_id, NEW.dedupe_key)
      IS DISTINCT FROM ROW(OLD.owner_id, OLD.account_id, OLD.source,
      OLD.source_ref, OLD.direction, OLD.amount_minor, OLD.occurred_at,
      OLD.posted_at, OLD.status, OLD.order_id, OLD.dedupe_key) THEN
      RAISE EXCEPTION 'ledger entry linked to posted money evidence is immutable';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER xz_linked_posted_ledger_immutable_before_write
  BEFORE UPDATE OR DELETE ON finance_ledger_entries FOR EACH ROW
  EXECUTE FUNCTION xz_linked_posted_ledger_immutable();

-- Confirmed new-order price and provider scope cannot be changed after insert.
CREATE OR REPLACE FUNCTION xz_consumer_order_identity_on_update() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.budget_period_id IS DISTINCT FROM OLD.budget_period_id
    OR NEW.purchase_intent_id IS DISTINCT FROM OLD.purchase_intent_id
    OR (OLD.purchase_intent_id IS NOT NULL AND (
      NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.provider IS DISTINCT FROM OLD.provider)) THEN
    RAISE EXCEPTION 'order financial owner, intent and accepted price are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
