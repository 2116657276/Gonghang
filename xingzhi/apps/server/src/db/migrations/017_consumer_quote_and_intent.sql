-- Immutable candidate quotes are separate from user-entered estimates and
-- mutable catalog listing prices. Provider integrations remain future work.
CREATE TABLE offer_quotes (
  id UUID PRIMARY KEY,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) BETWEEN 2 AND 80),
  quote_source TEXT NOT NULL CHECK (quote_source IN ('demo', 'channel_api')),
  provider_quote_ref TEXT,
  quote_version BIGINT NOT NULL CHECK (quote_version > 0),
  price_minor BIGINT NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  service_on DATE,
  rule_version BIGINT NOT NULL CHECK (rule_version > 0),
  rule_snapshot JSONB NOT NULL CHECK (jsonb_typeof(rule_snapshot) = 'object'),
  valid_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid'
    CHECK (status IN ('valid', 'expired', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, quote_version),
  UNIQUE (id, quote_version, price_minor),
  CHECK (valid_until > created_at)
);
CREATE UNIQUE INDEX offer_quotes_provider_ref_idx
  ON offer_quotes(provider, provider_quote_ref)
  WHERE provider_quote_ref IS NOT NULL;
CREATE INDEX offer_quotes_catalog_valid_idx
  ON offer_quotes(catalog_item_id, valid_until DESC)
  WHERE status = 'valid';

CREATE FUNCTION xz_quote_validate() RETURNS trigger AS $$
DECLARE listing catalog_items%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO listing FROM catalog_items WHERE id = NEW.catalog_item_id;
    IF listing.id IS NULL OR NOT listing.active
      OR listing.purchase_mode <> 'orderable' OR listing.currency <> 'CNY' THEN
      RAISE EXCEPTION 'quote requires an active orderable CNY listing';
    END IF;
  ELSIF ROW(NEW.catalog_item_id, NEW.provider, NEW.quote_source,
      NEW.provider_quote_ref, NEW.quote_version, NEW.price_minor,
      NEW.currency, NEW.service_on, NEW.rule_version,
      NEW.rule_snapshot, NEW.valid_until, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.catalog_item_id, OLD.provider, OLD.quote_source,
      OLD.provider_quote_ref, OLD.quote_version, OLD.price_minor,
      OLD.currency, OLD.service_on, OLD.rule_version,
      OLD.rule_snapshot, OLD.valid_until, OLD.created_at)
    OR (OLD.status <> 'valid' AND NEW.status IS DISTINCT FROM OLD.status)
    OR (OLD.status = 'valid' AND NEW.status NOT IN
      ('valid', 'expired', 'withdrawn')) THEN
    RAISE EXCEPTION 'quote terms are immutable; only status may expire or withdraw';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_quote_validate_before_write
  BEFORE INSERT OR UPDATE ON offer_quotes
  FOR EACH ROW EXECUTE FUNCTION xz_quote_validate();

CREATE TABLE funding_assessments (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  account_id UUID NOT NULL,
  budget_item_id UUID NOT NULL,
  quote_id UUID NOT NULL,
  financial_version BIGINT NOT NULL CHECK (financial_version > 0),
  period_version BIGINT NOT NULL CHECK (period_version > 0),
  quote_version BIGINT NOT NULL CHECK (quote_version > 0),
  replaced_estimate_minor BIGINT NOT NULL
    CHECK (replaced_estimate_minor >= 0),
  quoted_amount_minor BIGINT NOT NULL CHECK (quoted_amount_minor > 0),
  incremental_impact_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('allowed', 'needs_adjustment', 'blocked', 'unknown')),
  shortfall_minor BIGINT NOT NULL DEFAULT 0 CHECK (shortfall_minor >= 0),
  affected_dates DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  basis_snapshot_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id, account_id)
    REFERENCES budget_periods(id, owner_id, primary_account_id),
  FOREIGN KEY (budget_item_id, owner_id, period_id)
    REFERENCES budget_items(id, owner_id, period_id),
  FOREIGN KEY (basis_snapshot_id, account_id)
    REFERENCES finance_account_snapshots(id, account_id),
  FOREIGN KEY (quote_id, quote_version, quoted_amount_minor)
    REFERENCES offer_quotes(id, quote_version, price_minor),
  UNIQUE (id, owner_id, period_id, budget_item_id, quote_id),
  CHECK (incremental_impact_minor = quoted_amount_minor - replaced_estimate_minor),
  CHECK (expires_at > created_at)
);
CREATE INDEX funding_assessments_item_idx
  ON funding_assessments(budget_item_id, created_at DESC);

CREATE TABLE purchase_intents (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  budget_item_id UUID NOT NULL,
  quote_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  financial_version BIGINT NOT NULL CHECK (financial_version > 0),
  period_version BIGINT NOT NULL CHECK (period_version > 0),
  quote_version BIGINT NOT NULL CHECK (quote_version > 0),
  accepted_amount_minor BIGINT CHECK (accepted_amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'confirmed', 'ordered', 'expired', 'rejected')),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id) REFERENCES budget_periods(id, owner_id),
  FOREIGN KEY (budget_item_id, owner_id, period_id)
    REFERENCES budget_items(id, owner_id, period_id),
  FOREIGN KEY (assessment_id, owner_id, period_id, budget_item_id, quote_id)
    REFERENCES funding_assessments(id, owner_id, period_id, budget_item_id, quote_id),
  FOREIGN KEY (quote_id, quote_version, accepted_amount_minor)
    REFERENCES offer_quotes(id, quote_version, price_minor),
  UNIQUE (id, owner_id, period_id),
  CHECK ((status IN ('proposed', 'expired', 'rejected')
      AND accepted_amount_minor IS NULL AND confirmed_at IS NULL)
    OR (status IN ('confirmed', 'ordered')
      AND accepted_amount_minor IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX purchase_intents_one_open_item_idx
  ON purchase_intents(budget_item_id)
  WHERE status IN ('proposed', 'confirmed', 'ordered');
CREATE INDEX purchase_intents_owner_status_idx
  ON purchase_intents(owner_id, status, created_at DESC);

CREATE TABLE planning_drafts (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  basis_financial_version BIGINT NOT NULL CHECK (basis_financial_version > 0),
  basis_period_version BIGINT NOT NULL CHECK (basis_period_version > 0),
  model_source TEXT NOT NULL CHECK (length(btrim(model_source)) > 0),
  validated_payload JSONB NOT NULL
    CHECK (jsonb_typeof(validated_payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'accepted', 'discarded', 'stale')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id) REFERENCES budget_periods(id, owner_id)
);
CREATE INDEX planning_drafts_owner_period_idx
  ON planning_drafts(owner_id, period_id, created_at DESC);

-- Legacy orders keep both columns NULL. New consumer orders must reference a
-- confirmed intent from the same owner and budget period.
ALTER TABLE orders
  ADD COLUMN budget_period_id UUID,
  ADD COLUMN purchase_intent_id UUID,
  ADD CONSTRAINT orders_consumer_intent_pair_check
    CHECK ((budget_period_id IS NULL AND purchase_intent_id IS NULL)
      OR (budget_period_id IS NOT NULL AND purchase_intent_id IS NOT NULL)),
  ADD CONSTRAINT orders_consumer_intent_owner_period_fkey
    FOREIGN KEY (purchase_intent_id, owner_id, budget_period_id)
      REFERENCES purchase_intents(id, owner_id, period_id),
  ADD CONSTRAINT orders_purchase_intent_once_key UNIQUE (purchase_intent_id);
CREATE INDEX orders_budget_period_idx
  ON orders(budget_period_id, created_at DESC)
  WHERE budget_period_id IS NOT NULL;

CREATE FUNCTION xz_account_version_from_consumer_order() RETURNS trigger AS $$
DECLARE
  linked_account_id UUID;
  linked_period_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    linked_period_id := OLD.budget_period_id;
  ELSE
    linked_period_id := NEW.budget_period_id;
  END IF;
  IF linked_period_id IS NOT NULL THEN
    SELECT primary_account_id INTO linked_account_id
      FROM budget_periods
      WHERE id = linked_period_id;
    UPDATE finance_accounts SET updated_at = now()
      WHERE id = linked_account_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_consumer_order_version_after_write
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION xz_account_version_from_consumer_order();
