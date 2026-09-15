-- Direct table writes must not bypass the A-side order/account money boundary.
CREATE OR REPLACE FUNCTION xz_money_event_validate() RETURNS trigger AS $$
DECLARE
  linked_entry finance_ledger_entries%ROWTYPE;
  linked_order orders%ROWTYPE;
  linked_period budget_periods%ROWTYPE;
  linked_account finance_accounts%ROWTYPE;
  prior_refunds BIGINT;
BEGIN
  SELECT * INTO linked_order FROM orders
    WHERE id = NEW.order_id AND owner_id = NEW.owner_id FOR UPDATE;
  IF linked_order.id IS NULL OR linked_order.budget_period_id IS NULL
    OR linked_order.provider <> NEW.provider
    OR linked_order.currency <> NEW.currency
    OR NEW.amount_minor > linked_order.amount_minor THEN
    RAISE EXCEPTION 'money evidence requires matching new consumer order';
  END IF;
  SELECT * INTO linked_period FROM budget_periods
    WHERE id = linked_order.budget_period_id AND owner_id = NEW.owner_id;
  SELECT * INTO linked_account FROM finance_accounts
    WHERE id = linked_period.primary_account_id AND owner_id = NEW.owner_id;
  IF linked_account.id IS NULL OR linked_account.account_type <> 'debit'
    OR linked_account.source <> NEW.source
    OR (linked_order.environment = 'simulation' AND NEW.source <> 'demo')
    OR (linked_order.environment = 'sandbox'
      AND NEW.event_type IN ('payment_posted', 'refund_posted')
      AND (NEW.source <> 'bank_api' OR linked_account.provider <> 'icbc')) THEN
    RAISE EXCEPTION 'money evidence cannot cross account or environment source';
  END IF;
  IF NEW.event_type IN ('payment_posted', 'refund_posted') THEN
    SELECT * INTO linked_entry FROM finance_ledger_entries
      WHERE id = NEW.applied_ledger_entry_id AND owner_id = NEW.owner_id
        AND account_id = linked_account.id AND order_id = NEW.order_id;
    IF linked_entry.id IS NULL OR linked_entry.status <> 'posted'
      OR linked_entry.amount_minor <> NEW.amount_minor
      OR linked_entry.source <> NEW.source
      OR (NEW.source = 'bank_api' AND linked_entry.source_ref IS NULL)
      OR (NEW.event_type = 'payment_posted'
        AND (linked_entry.direction <> 'outflow'
          OR NEW.amount_minor <> linked_order.amount_minor))
      OR (NEW.event_type = 'refund_posted'
        AND linked_entry.direction <> 'inflow') THEN
      RAISE EXCEPTION 'posted money event must match posted order account entry';
    END IF;
  END IF;
  IF NEW.event_type = 'refund_posted' THEN
    SELECT COALESCE(SUM(amount_minor),0) INTO prior_refunds
      FROM finance_money_events
      WHERE order_id = NEW.order_id AND event_type = 'refund_posted';
    IF prior_refunds + NEW.amount_minor > linked_order.amount_minor THEN
      RAISE EXCEPTION 'posted refunds exceed original order amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
