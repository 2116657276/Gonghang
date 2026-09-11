CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('consumer', 'merchant_admin', 'reviewer')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  token_digest TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalog_items (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transport', 'stay', 'activity', 'unbooked')),
  description TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  rule_label TEXT NOT NULL,
  rule_version INTEGER NOT NULL DEFAULT 1,
  cancellation_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_fee_minor >= 0),
  simulation_mode TEXT NOT NULL CHECK (simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  purchase_limit_minor INTEGER NOT NULL DEFAULT 300000 CHECK (purchase_limit_minor > 0),
  paused_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plans_owner_idx ON plans(owner_id, updated_at DESC);

CREATE TABLE plan_items (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES catalog_items(id),
  merchant_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transport', 'stay', 'activity', 'unbooked')),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_confirmation', 'in_progress', 'kept', 'stopped', 'completed', 'pending_review')),
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, position)
);

CREATE TABLE proposals (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('purchase', 'change')),
  plan_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'rejected', 'executing', 'complete', 'pending_review')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX proposals_plan_idx ON proposals(plan_id, created_at DESC);

CREATE TABLE confirmations (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  proposal_id UUID NOT NULL REFERENCES proposals(id),
  type TEXT NOT NULL CHECK (type IN ('purchase', 'change', 'query_renewal')),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE authorizations (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  confirmation_id UUID NOT NULL REFERENCES confirmations(id),
  type TEXT NOT NULL CHECK (type IN ('purchase', 'aftercare', 'query')),
  scope JSONB NOT NULL,
  purchase_limit_minor INTEGER,
  accepted_fee_minor INTEGER,
  accepted_refund_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'expired')),
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  supersedes_id UUID REFERENCES authorizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX authorizations_plan_type_idx ON authorizations(plan_id, type, created_at DESC);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  plan_item_id UUID NOT NULL REFERENCES plan_items(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  merchant_id UUID NOT NULL REFERENCES users(id),
  confirmation_id UUID NOT NULL REFERENCES confirmations(id),
  purchase_authorization_id UUID NOT NULL REFERENCES authorizations(id),
  item_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  environment TEXT NOT NULL DEFAULT 'simulation' CHECK (environment = 'simulation'),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'fulfilling', 'cancellation_processing', 'fulfilled', 'cancelled', 'cancellation_rejected')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'unknown', 'closed', 'failed')),
  simulation_mode TEXT NOT NULL CHECK (simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN')),
  reserved_minor INTEGER NOT NULL,
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(confirmation_id, plan_item_id)
);
CREATE INDEX orders_plan_idx ON orders(plan_id, created_at DESC);
CREATE INDEX orders_merchant_idx ON orders(merchant_id, created_at DESC);

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  business_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'unknown', 'closed', 'failed')),
  sent_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cancellation_requests (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  proposal_id UUID NOT NULL REFERENCES proposals(id),
  confirmation_id UUID NOT NULL REFERENCES confirmations(id),
  accepted_fee_minor INTEGER NOT NULL DEFAULT 0,
  accepted_refund_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'simulated_complete', 'pending_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(proposal_id, order_id)
);

CREATE TABLE operations (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('simulate_payment', 'simulate_close', 'simulate_refund')),
  entity_id UUID NOT NULL,
  authorization_id UUID REFERENCES authorizations(id),
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'processing', 'succeeded', 'unknown', 'pending_review', 'failed')),
  purpose TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_version INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operations_recovery_idx ON operations(state, next_run_at);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'complete')),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_recovery_idx ON jobs(state, next_run_at);

CREATE TABLE idempotency_records (
  actor_id UUID NOT NULL REFERENCES users(id),
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_payload JSONB NOT NULL,
  response_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, route, idempotency_key)
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id),
  actor_id UUID REFERENCES users(id),
  type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_plan_cursor_idx ON events(plan_id, id);

CREATE TABLE review_scopes (
  reviewer_id UUID NOT NULL REFERENCES users(id),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  PRIMARY KEY(reviewer_id, plan_id)
);
