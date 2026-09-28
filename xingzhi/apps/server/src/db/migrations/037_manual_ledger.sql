-- User-entered expenses are a separate record, never a bank or Demo cash fact.
CREATE TABLE manual_ledger_entries (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  account_id UUID NOT NULL,
  occurred_on DATE NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  category TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, account_id) REFERENCES finance_accounts(owner_id, id)
);
CREATE INDEX manual_ledger_account_date_idx
  ON manual_ledger_entries(account_id, occurred_on DESC, id DESC);
