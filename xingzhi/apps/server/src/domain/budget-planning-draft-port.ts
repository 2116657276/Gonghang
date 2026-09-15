import type { PlanningDraftPort } from './planning-draft-port.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';

export const budgetPlanningDraftPort: PlanningDraftPort = {
  async assessPlanningDraft(client, ownerId, periodId,
    expectedFinancialVersion, expectedPeriodVersion, proposedItems) {
    const result = await forecastBudgetCashflow(client, ownerId, periodId, {
      expectedFinancialVersion, expectedPeriodVersion, proposedItems,
    });
    return {
      status: result.forecast.status,
      shortfallMinor: result.forecast.shortfallMinor,
      affectedDates: result.forecast.affectedDates,
      reasonCodes: result.forecast.reasonCodes,
    };
  },
};
