ALTER TABLE payment_attempts ADD COLUMN query_not_before TIMESTAMPTZ;
ALTER TABLE operations ADD COLUMN sent_at TIMESTAMPTZ;
ALTER TABLE operations ADD COLUMN channel_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type IN (
  'simulate_payment','simulate_close','simulate_refund','simulate_refund_batch','merchant_cancellation_review',
  'sandbox_payment_handoff','sandbox_payment_recheck','sandbox_close','sandbox_refund','sandbox_refund_recheck'
));
