CREATE TABLE model_budget (
  id INTEGER PRIMARY KEY CHECK (id=1),
  spent_micros BIGINT NOT NULL DEFAULT 0 CHECK (spent_micros>=0),
  reserved_micros BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micros>=0),
  CHECK (spent_micros+reserved_micros<=100000000)
);
INSERT INTO model_budget(id) VALUES (1);
CREATE TABLE model_usage (
  id UUID PRIMARY KEY,
  purpose TEXT NOT NULL,
  reserved_micros BIGINT NOT NULL CHECK (reserved_micros>0),
  settled_micros BIGINT CHECK (settled_micros>=0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled')),
  usage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);
