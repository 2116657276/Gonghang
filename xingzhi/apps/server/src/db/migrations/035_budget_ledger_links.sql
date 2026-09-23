-- A posted non-order expense may cover one uncommitted budget item. Old links
-- remain as audit facts when the consumer removes a mistaken association.
CREATE TABLE budget_ledger_links (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  account_id UUID NOT NULL,
  item_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  covered_minor INTEGER NOT NULL CHECK (covered_minor > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlinked_at TIMESTAMPTZ,
  FOREIGN KEY (period_id,owner_id,account_id)
    REFERENCES budget_periods(id,owner_id,primary_account_id),
  FOREIGN KEY (item_id,owner_id,period_id)
    REFERENCES budget_items(id,owner_id,period_id),
  FOREIGN KEY (entry_id,owner_id,account_id)
    REFERENCES finance_ledger_entries(id,owner_id,account_id),
  CHECK ((active AND unlinked_at IS NULL) OR (NOT active AND unlinked_at IS NOT NULL))
);
CREATE UNIQUE INDEX budget_ledger_links_active_entry_idx
  ON budget_ledger_links(entry_id) WHERE active;
CREATE INDEX budget_ledger_links_active_item_idx
  ON budget_ledger_links(item_id) WHERE active;

-- Linked money facts cannot be silently rewritten. Corrections require an
-- explicit unlink first; the historic link remains readable afterwards.
CREATE FUNCTION xz_budget_linked_ledger_immutable() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM budget_ledger_links WHERE entry_id=OLD.id AND active) THEN
    IF TG_OP='DELETE' OR ROW(NEW.owner_id,NEW.account_id,NEW.direction,
      NEW.amount_minor,NEW.occurred_at,NEW.posted_at,NEW.status,NEW.order_id)
      IS DISTINCT FROM ROW(OLD.owner_id,OLD.account_id,OLD.direction,
      OLD.amount_minor,OLD.occurred_at,OLD.posted_at,OLD.status,OLD.order_id) THEN
      RAISE EXCEPTION 'unlink budget item before changing linked ledger fact';
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_budget_linked_ledger_before_write
  BEFORE UPDATE OR DELETE ON finance_ledger_entries FOR EACH ROW
  EXECUTE FUNCTION xz_budget_linked_ledger_immutable();
