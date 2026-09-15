ALTER TABLE catalog_items
  ADD COLUMN category_code TEXT,
  ADD COLUMN location_label TEXT,
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN purchase_mode TEXT NOT NULL DEFAULT 'listing'
    CHECK (purchase_mode IN ('listing', 'orderable')),
  ADD COLUMN available_from DATE,
  ADD COLUMN available_to DATE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT catalog_items_available_range_check
    CHECK (available_from IS NULL OR available_to IS NULL OR available_to >= available_from),
  ADD CONSTRAINT catalog_items_unbooked_listing_check
    CHECK (kind <> 'unbooked' OR purchase_mode = 'listing');

UPDATE catalog_items
SET category_code = CASE kind
      WHEN 'transport' THEN 'transport'
      WHEN 'stay' THEN 'stay'
      WHEN 'activity' THEN 'activity'
      ELSE NULL
    END,
    purchase_mode = CASE WHEN kind = 'unbooked' THEN 'listing' ELSE 'orderable' END,
    updated_at = created_at;

ALTER TABLE catalog_items DROP CONSTRAINT catalog_items_kind_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_kind_check
  CHECK (kind IN ('transport', 'stay', 'activity', 'unbooked', 'food'));

ALTER TABLE plan_items DROP CONSTRAINT plan_items_kind_check;
ALTER TABLE plan_items ADD CONSTRAINT plan_items_kind_check
  CHECK (kind IN ('transport', 'stay', 'activity', 'unbooked', 'food'));

CREATE INDEX catalog_items_active_candidates_idx
  ON catalog_items(category_code, purchase_mode, price_minor)
  WHERE active;
