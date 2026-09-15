-- Old transaction rows retain their legacy plan/confirmation/merchant links.
-- New consumer rows use a confirmed purchase intent and budget-period scope.
ALTER TABLE orders
  ALTER COLUMN plan_id DROP NOT NULL,
  ALTER COLUMN plan_item_id DROP NOT NULL,
  ALTER COLUMN merchant_id DROP NOT NULL,
  ALTER COLUMN confirmation_id DROP NOT NULL,
  ALTER COLUMN purchase_authorization_id DROP NOT NULL,
  ADD CONSTRAINT orders_legacy_or_consumer_shape_check
    CHECK ((purchase_intent_id IS NULL AND budget_period_id IS NULL
      AND plan_id IS NOT NULL AND plan_item_id IS NOT NULL
      AND merchant_id IS NOT NULL AND confirmation_id IS NOT NULL
      AND purchase_authorization_id IS NOT NULL)
      OR (purchase_intent_id IS NOT NULL AND budget_period_id IS NOT NULL
        AND plan_id IS NULL AND plan_item_id IS NULL
        AND merchant_id IS NULL AND confirmation_id IS NULL
        AND purchase_authorization_id IS NULL));

CREATE TABLE budget_events (
  id BIGSERIAL PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  actor_id UUID REFERENCES users(id),
  type TEXT NOT NULL CHECK (length(btrim(type)) > 0),
  data JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(data) = 'object'),
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id) REFERENCES budget_periods(id, owner_id)
);
CREATE INDEX budget_events_period_cursor_idx
  ON budget_events(period_id, id);

CREATE TABLE budget_adjustment_proposals (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  period_id UUID NOT NULL,
  basis_financial_version BIGINT NOT NULL CHECK (basis_financial_version > 0),
  basis_period_version BIGINT NOT NULL CHECK (basis_period_version > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 200),
  proposed_changes JSONB NOT NULL
    CHECK (jsonb_typeof(proposed_changes) = 'object'),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed', 'confirmed', 'executing', 'complete',
      'expired', 'rejected', 'pending_review')),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, owner_id) REFERENCES budget_periods(id, owner_id),
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, period_id),
  CHECK (confirmed_by IS NULL OR confirmed_by = owner_id),
  CHECK ((confirmed_by IS NULL AND confirmed_at IS NULL)
    OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX budget_adjustments_period_status_idx
  ON budget_adjustment_proposals(period_id, status, created_at DESC);

ALTER TABLE cancellation_requests
  ALTER COLUMN proposal_id DROP NOT NULL,
  ALTER COLUMN confirmation_id DROP NOT NULL,
  ADD COLUMN owner_id UUID,
  ADD COLUMN budget_adjustment_id UUID,
  ADD CONSTRAINT cancellation_requests_consumer_order_owner_fkey
    FOREIGN KEY (order_id, owner_id) REFERENCES orders(id, owner_id),
  ADD CONSTRAINT cancellation_requests_budget_adjustment_owner_fkey
    FOREIGN KEY (budget_adjustment_id, owner_id)
      REFERENCES budget_adjustment_proposals(id, owner_id),
  ADD CONSTRAINT cancellation_requests_legacy_or_consumer_check
    CHECK ((proposal_id IS NOT NULL AND confirmation_id IS NOT NULL
      AND budget_adjustment_id IS NULL AND owner_id IS NULL)
      OR (proposal_id IS NULL AND confirmation_id IS NULL
        AND budget_adjustment_id IS NOT NULL AND owner_id IS NOT NULL));
CREATE UNIQUE INDEX cancellation_requests_budget_adjustment_order_idx
  ON cancellation_requests(budget_adjustment_id, order_id)
  WHERE budget_adjustment_id IS NOT NULL;

ALTER TABLE refund_batches
  ALTER COLUMN merchant_id DROP NOT NULL,
  ADD COLUMN responsible_provider TEXT,
  ADD CONSTRAINT refund_batches_responsibility_check
    CHECK (merchant_id IS NOT NULL OR
      (responsible_provider IS NOT NULL AND length(btrim(responsible_provider)) > 0));

ALTER TABLE operations
  ALTER COLUMN plan_id DROP NOT NULL,
  ADD COLUMN budget_period_id UUID,
  ADD CONSTRAINT operations_consumer_period_owner_fkey
    FOREIGN KEY (budget_period_id, owner_id)
      REFERENCES budget_periods(id, owner_id),
  ADD CONSTRAINT operations_legacy_or_consumer_scope_check
    CHECK ((plan_id IS NOT NULL AND budget_period_id IS NULL)
      OR (plan_id IS NULL AND budget_period_id IS NOT NULL));
CREATE INDEX operations_consumer_period_idx
  ON operations(budget_period_id, created_at DESC)
  WHERE budget_period_id IS NOT NULL;
