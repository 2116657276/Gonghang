CREATE TABLE runtime_heartbeats (
  component TEXT PRIMARY KEY CHECK (component IN ('worker')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
