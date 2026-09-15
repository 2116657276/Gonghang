-- The same verified provider result must not create multiple cash facts.
ALTER TABLE finance_ledger_entries
  ADD CONSTRAINT finance_ledger_id_owner_order_key
    UNIQUE (id, owner_id, order_id);

CREATE TABLE finance_money_events (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  order_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) BETWEEN 2 AND 80),
  provider_event_id TEXT NOT NULL
    CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('payment_pending', 'payment_posted', 'payment_failed',
      'refund_requested', 'refund_verified', 'refund_posted',
      'result_unknown')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  occurred_at TIMESTAMPTZ NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN
    ('unverified', 'verified', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('demo', 'bank_api')),
  applied_ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, owner_id) REFERENCES orders(id, owner_id),
  FOREIGN KEY (applied_ledger_entry_id, owner_id, order_id)
    REFERENCES finance_ledger_entries(id, owner_id, order_id),
  UNIQUE (provider, provider_event_id, event_type),
  CHECK ((event_type IN ('payment_posted', 'refund_posted')
      AND verification_state = 'verified'
      AND applied_ledger_entry_id IS NOT NULL)
    OR (event_type NOT IN ('payment_posted', 'refund_posted')
      AND applied_ledger_entry_id IS NULL))
);
CREATE INDEX finance_money_events_order_idx
  ON finance_money_events(order_id, occurred_at DESC);

ALTER TABLE budget_adjustment_proposals
  ADD CONSTRAINT budget_adjustments_confirmation_state_check
    CHECK ((status = 'proposed' AND confirmed_by IS NULL)
      OR (status IN ('confirmed', 'executing', 'complete', 'pending_review')
        AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
      OR status IN ('expired', 'rejected'));

CREATE FUNCTION xz_budget_adjustment_validate() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.confirmed_by IS NOT NULL THEN
      RAISE EXCEPTION 'adjustment proposal must start unconfirmed';
    END IF;
  ELSE
    IF ROW(NEW.owner_id, NEW.period_id, NEW.basis_financial_version,
        NEW.basis_period_version, NEW.reason, NEW.proposed_changes,
        NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.owner_id, OLD.period_id,
        OLD.basis_financial_version, OLD.basis_period_version,
        OLD.reason, OLD.proposed_changes, OLD.expires_at)
      OR (OLD.status = 'proposed' AND NEW.status NOT IN
        ('proposed', 'confirmed', 'expired', 'rejected'))
      OR (OLD.status = 'confirmed' AND NEW.status NOT IN
        ('confirmed', 'executing', 'expired', 'rejected'))
      OR (OLD.status = 'executing' AND NEW.status NOT IN
        ('executing', 'complete', 'pending_review'))
      OR (OLD.status = 'pending_review' AND NEW.status NOT IN
        ('pending_review', 'executing', 'complete'))
      OR (OLD.status IN ('complete', 'expired', 'rejected')
        AND NEW.status IS DISTINCT FROM OLD.status)
      OR (OLD.confirmed_by IS NOT NULL
        AND (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
          OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)) THEN
      RAISE EXCEPTION 'confirmed adjustment scope and evidence are immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_budget_adjustment_validate_before_write
  BEFORE INSERT OR UPDATE ON budget_adjustment_proposals
  FOR EACH ROW EXECUTE FUNCTION xz_budget_adjustment_validate();
