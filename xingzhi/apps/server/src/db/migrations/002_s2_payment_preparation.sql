ALTER TABLE orders DROP CONSTRAINT orders_environment_check;
ALTER TABLE orders ADD CONSTRAINT orders_environment_check CHECK (environment IN ('simulation', 'sandbox'));
ALTER TABLE orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'simulation' CHECK (provider IN ('simulation', 'alipay'));

ALTER TABLE payment_attempts ADD COLUMN environment TEXT NOT NULL DEFAULT 'simulation' CHECK (environment IN ('simulation', 'sandbox'));
ALTER TABLE payment_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'simulation' CHECK (provider IN ('simulation', 'alipay'));
ALTER TABLE payment_attempts ADD COLUMN handoff_ready_at TIMESTAMPTZ;
ALTER TABLE payment_attempts ADD COLUMN provider_trade_no TEXT;
ALTER TABLE payment_attempts ADD COLUMN provider_status TEXT;

ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type IN (
  'simulate_payment', 'simulate_close', 'simulate_refund',
  'sandbox_payment_handoff', 'sandbox_payment_recheck', 'sandbox_close', 'sandbox_refund'
));

CREATE TABLE payment_notifications (
  id UUID PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment = 'sandbox'),
  provider TEXT NOT NULL CHECK (provider = 'alipay'),
  notification_id TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  processing_state TEXT NOT NULL CHECK (processing_state IN ('applied', 'rejected', 'quarantined')),
  order_id UUID REFERENCES orders(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, provider, notification_id)
);
