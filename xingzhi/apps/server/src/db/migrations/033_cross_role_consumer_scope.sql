-- New orders retain the consumer shape (legacy merchant_id/plan_id stay NULL).
-- Capture the merchant at order creation, never infer ownership from a provider.
CREATE TABLE consumer_order_merchants (
  order_id UUID PRIMARY KEY REFERENCES orders(id),
  merchant_id UUID NOT NULL REFERENCES users(id),
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consumer_order_merchants_merchant_idx ON consumer_order_merchants(merchant_id, order_id);

CREATE FUNCTION xz_capture_order_merchant() RETURNS trigger AS $$
BEGIN
  IF NEW.purchase_intent_id IS NOT NULL THEN
    INSERT INTO consumer_order_merchants(order_id,merchant_id,catalog_item_id)
      SELECT NEW.id,c.merchant_id,c.id FROM purchase_intents i
      JOIN offer_quotes q ON q.id=i.quote_id JOIN catalog_items c ON c.id=q.catalog_item_id
      JOIN users u ON u.id=c.merchant_id AND u.role='merchant_admin'
      WHERE i.id=NEW.purchase_intent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'consumer order requires a registered merchant'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_capture_order_merchant_after_insert AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION xz_capture_order_merchant();

CREATE FUNCTION xz_order_merchant_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'captured order merchant is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_order_merchant_immutable_before_write BEFORE UPDATE OR DELETE ON consumer_order_merchants
  FOR EACH ROW EXECUTE FUNCTION xz_order_merchant_immutable();

-- Do not guess ownership for older consumer orders from a mutable catalog.
-- They remain readable by their owner/reviewer but unassigned to a merchant.
CREATE TABLE budget_review_scopes (
  reviewer_id UUID NOT NULL REFERENCES users(id),
  period_id UUID NOT NULL REFERENCES budget_periods(id),
  PRIMARY KEY(reviewer_id,period_id)
);
CREATE FUNCTION xz_budget_reviewer_role() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.reviewer_id AND role='reviewer') THEN
    RAISE EXCEPTION 'budget review scope requires a reviewer';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER xz_budget_reviewer_role_before_write BEFORE INSERT OR UPDATE ON budget_review_scopes
  FOR EACH ROW EXECUTE FUNCTION xz_budget_reviewer_role();
CREATE TABLE budget_evidence_exports (
  id UUID PRIMARY KEY,
  period_id UUID NOT NULL REFERENCES budget_periods(id),
  requester_id UUID NOT NULL REFERENCES users(id),
  format TEXT NOT NULL CHECK(format IN ('json','html')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX budget_evidence_exports_scope_idx
  ON budget_evidence_exports(requester_id,period_id,expires_at);

ALTER TABLE consumer_demo_scenarios
  ADD COLUMN aftercare_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK (aftercare_mode IN ('automatic','merchant-review')),
  ADD COLUMN merchant_id UUID REFERENCES users(id),
  ADD COLUMN reviewer_id UUID REFERENCES users(id),
  ADD COLUMN catalog_item_id UUID REFERENCES catalog_items(id),
  ADD COLUMN quote_id UUID REFERENCES offer_quotes(id);
