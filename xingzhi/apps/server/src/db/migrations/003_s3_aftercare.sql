ALTER TABLE catalog_items
  ADD COLUMN cancellation_rule TEXT NOT NULL DEFAULT 'full_refund'
  CHECK (cancellation_rule IN ('full_refund', 'fee_80', 'two_batches', 'reject', 'delay'));

UPDATE catalog_items
SET cancellation_rule = CASE code
  WHEN 'B-STAY' THEN 'fee_80'
  ELSE 'full_refund'
END;

ALTER TABLE cancellation_requests DROP CONSTRAINT cancellation_requests_status_check;
ALTER TABLE cancellation_requests ADD CONSTRAINT cancellation_requests_status_check CHECK (status IN (
  'submitted', 'approved', 'rejected', 'delayed', 'refund_processing', 'completed', 'pending_review', 'simulated_complete'
));
ALTER TABLE cancellation_requests
  ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN rule_preset TEXT NOT NULL DEFAULT 'full_refund'
    CHECK (rule_preset IN ('full_refund', 'fee_80', 'two_batches', 'reject', 'delay')),
  ADD COLUMN decision TEXT CHECK (decision IN ('approve', 'reject', 'delay')),
  ADD COLUMN decision_reason TEXT,
  ADD COLUMN decided_by UUID REFERENCES users(id),
  ADD COLUMN decided_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE cancellation_requests
SET status = 'completed'
WHERE status = 'simulated_complete';

CREATE UNIQUE INDEX cancellation_requests_active_order_idx
  ON cancellation_requests (order_id)
  WHERE status IN ('submitted', 'approved', 'delayed', 'refund_processing', 'pending_review');

ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type IN (
  'simulate_payment', 'simulate_close', 'simulate_refund', 'simulate_refund_batch', 'merchant_cancellation_review',
  'sandbox_payment_handoff', 'sandbox_payment_recheck', 'sandbox_close', 'sandbox_refund'
));

CREATE TABLE refund_batches (
  id UUID PRIMARY KEY,
  cancellation_request_id UUID NOT NULL REFERENCES cancellation_requests(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  merchant_id UUID NOT NULL REFERENCES users(id),
  operation_id UUID UNIQUE REFERENCES operations(id),
  environment TEXT NOT NULL CHECK (environment IN ('simulation', 'sandbox')),
  provider TEXT NOT NULL CHECK (provider IN ('simulation', 'alipay')),
  batch_number INTEGER NOT NULL CHECK (batch_number > 0),
  business_number TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'unknown', 'pending_review', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cancellation_request_id, batch_number),
  UNIQUE (environment, provider, business_number)
);
CREATE INDEX refund_batches_cancellation_idx ON refund_batches (cancellation_request_id, batch_number);
CREATE INDEX refund_batches_merchant_idx ON refund_batches (merchant_id, status, created_at DESC);

CREATE TABLE manual_tasks (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  merchant_id UUID NOT NULL REFERENCES users(id),
  order_id UUID REFERENCES orders(id),
  cancellation_request_id UUID REFERENCES cancellation_requests(id),
  refund_batch_id UUID REFERENCES refund_batches(id),
  operation_id UUID REFERENCES operations(id),
  type TEXT NOT NULL CHECK (type IN ('cancellation_follow_up', 'refund_recheck', 'operation_recheck')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'resolved')),
  reason TEXT NOT NULL,
  next_action TEXT NOT NULL,
  next_review_at TIMESTAMPTZ NOT NULL,
  claimed_by UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ,
  last_note TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX manual_tasks_merchant_idx ON manual_tasks (merchant_id, state, next_review_at);
