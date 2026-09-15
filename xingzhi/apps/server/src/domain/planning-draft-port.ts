import type { PoolClient } from 'pg';
import type { PlanningDraftAssessment, PlanningDraftItem } from '@xingzhi/contracts';

export interface PlanningDraftPort {
  assessPlanningDraft(
    client: PoolClient,
    ownerId: string,
    periodId: string,
    expectedFinancialVersion: number,
    expectedPeriodVersion: number,
    proposedItems: PlanningDraftItem[],
  ): Promise<PlanningDraftAssessment>;
}
