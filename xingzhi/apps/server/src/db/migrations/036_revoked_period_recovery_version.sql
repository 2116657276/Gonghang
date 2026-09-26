-- Historical order recovery may bump a period version without reauthorizing the account.
-- Revocation must prevent new execution, not prevent closing an old budget or
-- recording a later verified settlement for a historical period.
CREATE OR REPLACE FUNCTION xz_budget_period_validate() RETURNS trigger AS $$
DECLARE
  linked_account finance_accounts%ROWTYPE;
  linked_snapshot finance_account_snapshots%ROWTYPE;
  owner_role TEXT;
BEGIN
  SELECT role INTO owner_role FROM users WHERE id = NEW.owner_id;
  IF owner_role IS DISTINCT FROM 'consumer' THEN
    RAISE EXCEPTION 'budget owner must be a consumer';
  END IF;
  SELECT * INTO linked_account FROM finance_accounts
    WHERE id = NEW.primary_account_id AND owner_id = NEW.owner_id;
  IF linked_account.id IS NULL OR linked_account.account_type <> 'debit' THEN
    RAISE EXCEPTION 'budget requires a debit account owned by consumer';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status = 'closed'
    OR linked_account.status <> 'linked') THEN
    RAISE EXCEPTION 'new budget requires linked account and open lifecycle';
  END IF;
  IF NEW.status = 'active' THEN
    SELECT * INTO linked_snapshot FROM finance_account_snapshots
      WHERE id = NEW.baseline_snapshot_id
        AND account_id = NEW.primary_account_id;
    IF (linked_account.status <> 'linked' AND (TG_OP = 'INSERT'
      OR ROW(NEW.status,NEW.savings_target_minor,NEW.baseline_snapshot_id,NEW.necessities_confirmed_at)
        IS DISTINCT FROM ROW(OLD.status,OLD.savings_target_minor,OLD.baseline_snapshot_id,OLD.necessities_confirmed_at)))
      OR linked_snapshot.id IS NULL
      OR linked_snapshot.fact_status <> 'observed'
      OR linked_snapshot.source <> linked_account.source
      OR linked_snapshot.available_balance_minor IS NULL
      OR linked_snapshot.covered_through_at IS NULL THEN
      RAISE EXCEPTION 'active budget requires linked debit account and complete observed snapshot';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.status = 'active' AND NEW.status = 'draft')
    OR (OLD.status = 'closed' AND NEW.status <> 'closed')
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.primary_account_id IS DISTINCT FROM OLD.primary_account_id
    OR NEW.month_start IS DISTINCT FROM OLD.month_start
    OR NEW.month_end IS DISTINCT FROM OLD.month_end) THEN
    RAISE EXCEPTION 'budget identity and lifecycle cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
