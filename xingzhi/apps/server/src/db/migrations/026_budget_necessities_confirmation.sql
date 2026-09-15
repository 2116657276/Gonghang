-- Explicitly confirmed zero necessities must not be confused with missing data.
ALTER TABLE budget_periods
  ADD COLUMN necessities_confirmed_at TIMESTAMPTZ;
