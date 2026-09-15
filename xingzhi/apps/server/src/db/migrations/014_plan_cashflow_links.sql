ALTER TABLE plans
  ADD COLUMN cashflow_plan_id UUID,
  ADD COLUMN cashflow_state TEXT NOT NULL DEFAULT 'legacy'
    CHECK (cashflow_state IN ('legacy', 'draft', 'active')),
  ADD COLUMN target_date DATE,
  ADD COLUMN target_budget_minor INTEGER CHECK (target_budget_minor >= 0),
  ADD CONSTRAINT plans_id_owner_key UNIQUE (id, owner_id),
  ADD CONSTRAINT plans_cashflow_owner_fkey
    FOREIGN KEY (cashflow_plan_id, owner_id) REFERENCES cashflow_plans(id, owner_id),
  ADD CONSTRAINT plans_cashflow_state_link_check
    CHECK ((cashflow_state = 'active' AND cashflow_plan_id IS NOT NULL) OR
      (cashflow_state IN ('legacy', 'draft') AND cashflow_plan_id IS NULL));
CREATE INDEX plans_cashflow_idx
  ON plans(cashflow_plan_id, updated_at DESC) WHERE cashflow_plan_id IS NOT NULL;

ALTER TABLE plan_items
  ADD COLUMN required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN adjustable BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN planned_on DATE,
  ADD CONSTRAINT plan_items_id_plan_key UNIQUE (id, plan_id);
CREATE INDEX plan_items_plan_day_idx ON plan_items(plan_id, planned_on, position);

ALTER TABLE cashflow_plan_items
  ADD CONSTRAINT cashflow_items_related_plan_owner_fkey
    FOREIGN KEY (related_plan_id, owner_id) REFERENCES plans(id, owner_id),
  ADD CONSTRAINT cashflow_items_selected_same_plan_fkey
    FOREIGN KEY (selected_plan_item_id, related_plan_id) REFERENCES plan_items(id, plan_id);
CREATE UNIQUE INDEX cashflow_items_selected_once_idx
  ON cashflow_plan_items(selected_plan_item_id)
  WHERE selected_plan_item_id IS NOT NULL AND fact_status <> 'cancelled';

ALTER TABLE proposals
  ADD COLUMN cashflow_plan_id UUID,
  ADD COLUMN cashflow_version INTEGER CHECK (cashflow_version > 0),
  ADD COLUMN basis_snapshot_id UUID REFERENCES finance_account_snapshots(id),
  ADD CONSTRAINT proposals_cashflow_owner_fkey
    FOREIGN KEY (cashflow_plan_id, owner_id) REFERENCES cashflow_plans(id, owner_id),
  ADD CONSTRAINT proposals_finance_basis_check
    CHECK ((cashflow_plan_id IS NULL AND cashflow_version IS NULL AND basis_snapshot_id IS NULL) OR
      (cashflow_plan_id IS NOT NULL AND cashflow_version IS NOT NULL AND basis_snapshot_id IS NOT NULL));

-- Existing proposals, confirmations, authorizations and orders remain linked to
-- their original plans. These constraints prevent future cross-owner references.
ALTER TABLE proposals
  ADD CONSTRAINT proposals_plan_owner_fkey
    FOREIGN KEY (plan_id, owner_id) REFERENCES plans(id, owner_id),
  ADD CONSTRAINT proposals_id_plan_owner_key UNIQUE (id, plan_id, owner_id);

ALTER TABLE confirmations
  ADD CONSTRAINT confirmations_plan_owner_fkey
    FOREIGN KEY (plan_id, owner_id) REFERENCES plans(id, owner_id),
  ADD CONSTRAINT confirmations_proposal_same_plan_fkey
    FOREIGN KEY (proposal_id, plan_id, owner_id) REFERENCES proposals(id, plan_id, owner_id),
  ADD CONSTRAINT confirmations_id_plan_owner_key UNIQUE (id, plan_id, owner_id),
  ADD CONSTRAINT confirmations_id_plan_owner_proposal_key UNIQUE (id, plan_id, owner_id, proposal_id);

ALTER TABLE authorizations
  ADD CONSTRAINT authorizations_plan_owner_fkey
    FOREIGN KEY (plan_id, owner_id) REFERENCES plans(id, owner_id),
  ADD CONSTRAINT authorizations_confirmation_same_plan_fkey
    FOREIGN KEY (confirmation_id, plan_id, owner_id) REFERENCES confirmations(id, plan_id, owner_id),
  ADD CONSTRAINT authorizations_id_plan_owner_confirmation_key
    UNIQUE (id, plan_id, owner_id, confirmation_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_plan_owner_fkey
    FOREIGN KEY (plan_id, owner_id) REFERENCES plans(id, owner_id),
  ADD CONSTRAINT orders_item_same_plan_fkey
    FOREIGN KEY (plan_item_id, plan_id) REFERENCES plan_items(id, plan_id),
  ADD CONSTRAINT orders_confirmation_same_plan_fkey
    FOREIGN KEY (confirmation_id, plan_id, owner_id) REFERENCES confirmations(id, plan_id, owner_id),
  ADD CONSTRAINT orders_authorization_same_confirmation_fkey
    FOREIGN KEY (purchase_authorization_id, plan_id, owner_id, confirmation_id)
      REFERENCES authorizations(id, plan_id, owner_id, confirmation_id),
  ADD CONSTRAINT orders_one_order_per_item_key UNIQUE (plan_item_id),
  ADD CONSTRAINT orders_amount_bounds_check
    CHECK (reserved_minor >= 0 AND refunded_minor <= amount_minor);
