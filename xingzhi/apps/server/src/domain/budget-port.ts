import type { PoolClient } from 'pg';
import type { BudgetItemChangeInput, BudgetItemCancelInput, BudgetItemMutationResult } from '@xingzhi/contracts';

// A implements these functions; B owns the transaction and HTTP idempotency.
// No mock implementation is installed in the running service.
export interface BudgetItemPort {
  applyBudgetItemChange(client: PoolClient, ownerId: string, input: BudgetItemChangeInput): Promise<BudgetItemMutationResult>;
  cancelBudgetItem(client: PoolClient, ownerId: string, input: BudgetItemCancelInput): Promise<BudgetItemMutationResult>;
}
