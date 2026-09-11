CREATE TABLE evidence_exports (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES users(id),
  format TEXT NOT NULL CHECK (format IN ('json', 'html')),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX evidence_exports_access_idx
  ON evidence_exports (requester_id, plan_id, expires_at DESC);
