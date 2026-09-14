ALTER TABLE catalog_items
  ADD COLUMN close_simulation_mode TEXT NOT NULL DEFAULT 'SUCCESS'
    CHECK (close_simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN')),
  ADD COLUMN refund_simulation_mode TEXT NOT NULL DEFAULT 'SUCCESS'
    CHECK (refund_simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN'));

ALTER TABLE orders
  ADD COLUMN close_simulation_mode TEXT NOT NULL DEFAULT 'SUCCESS'
    CHECK (close_simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN')),
  ADD COLUMN refund_simulation_mode TEXT NOT NULL DEFAULT 'SUCCESS'
    CHECK (refund_simulation_mode IN ('SUCCESS', 'PENDING', 'UNKNOWN'));
