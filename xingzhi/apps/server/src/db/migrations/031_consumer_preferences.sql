CREATE TABLE consumer_preferences (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  default_account_id UUID,
  notify_planning BOOLEAN NOT NULL DEFAULT TRUE,
  notify_orders BOOLEAN NOT NULL DEFAULT TRUE,
  notify_refunds BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, default_account_id) REFERENCES finance_accounts(owner_id, id)
);
