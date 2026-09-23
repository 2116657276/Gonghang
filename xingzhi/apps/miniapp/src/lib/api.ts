import Taro from '@tarojs/taro';
import type { Adjustment, AdjustmentConfirmation, AdjustmentDetail, AftercareConfirmation, AftercarePreview, AgentRunSummary, ApiEnvelope, BudgetItemChangePreview, BudgetItemImpact, BudgetItemInput, BudgetLedgerLinks, BudgetPeriod, ConsumerOrder, ConsumerPreferences, FundingAssessment, Offer, OfferQuote, Operation, OrderAftercare, PaymentHandoff, PaymentReadiness, PaymentRecheck, PeriodEvent, PeriodReview, PlanningDraft, PurchaseIntent, PurchaseIntentProposal, RollingCashflow, RuntimeStatus, User } from './types';
import { ApiError, parseApiError } from './errors';
import { apiBase, isH5Runtime } from './runtime-config';
import { beginIdempotentRequest, completeIdempotentRequest } from './idempotency';
import { clearClientSession, saveMiniappSession, sessionHeaders } from './session';

export { ApiError } from './errors';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  data?: unknown;
  auth?: boolean;
  idempotent?: boolean;
  redirectOnUnauthorized?: boolean;
};

export async function request<T>(path: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET';
  const shouldAuthenticate = options.auth !== false;
  const shouldUseIdempotency = options.idempotent ?? !['GET'].includes(method);
  const pending = shouldUseIdempotency ? beginIdempotentRequest(method, path, options.data) : null;
  const header: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(shouldAuthenticate ? sessionHeaders() : {}),
  };
  if (pending) header['Idempotency-Key'] = pending.key;

  let response;
  try {
    response = await Taro.request<T>({
      url: `${apiBase()}/api${path}`, method, data: options.data, header,
      timeout: 15000,
      ...(isH5Runtime ? { credentials: 'include' as const } : {}),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('网络连接失败，请检查网络后重试。', 0, 'NETWORK_ERROR');
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    // 5xx / timeout may be an acknowledged-but-response-lost write. Keep the
    // same key so an explicit retry cannot create a second business object.
    if (pending && response.statusCode < 500 && response.statusCode !== 408) {
      completeIdempotentRequest(pending.storageId, pending.key);
    }
    const error = parseApiError(response.data, response.statusCode);
    if (shouldAuthenticate && options.redirectOnUnauthorized !== false && response.statusCode === 401) {
      clearClientSession();
      void Taro.reLaunch({ url: '/pages/login/index' });
    }
    throw error;
  }
  if (pending) completeIdempotentRequest(pending.storageId, pending.key);
  return response.data as T;
}

export const api = {
  session: () => {
    if (!isH5Runtime && !sessionHeaders().Authorization) {
      throw new ApiError('请先登录。', 401, 'UNAUTHENTICATED');
    }
    // 登录页把 401 当作“尚未登录”的正常结果，不能再次重启登录页。
    return request<{ user: User }>('/session', { redirectOnUnauthorized: false });
  },
  login: async (email: string, password: string) => {
    if (isH5Runtime) return request<{ user: User }>('/sessions', {
      method: 'POST', data: { email, password }, auth: false, idempotent: false,
    });
    const result = await request<ApiEnvelope<{ token: string; expiresAt: string; user: User }>>('/miniapp/sessions', {
      method: 'POST', data: { email, password }, auth: false, idempotent: false,
    });
    saveMiniappSession(result.data);
    return { user: result.data.user };
  },
  logout: async () => {
    await request<void>('/session', { method: 'DELETE', idempotent: false });
    clearClientSession();
  },
  accounts: () => request<ApiEnvelope<{ accounts: import('./types').FinanceAccountFacts[] }>>('/finance/accounts'),
  preferences: () => request<ApiEnvelope<ConsumerPreferences>>('/consumer-preferences'),
  updatePreferences: (data: { defaultAccountId?: string | null; notifications?: ConsumerPreferences['notifications'] }) =>
    request<ApiEnvelope<ConsumerPreferences>>('/consumer-preferences', { method: 'PATCH', data }),
  revokeAccount: (id: string, data: { expectedStatus: 'linked' }) =>
    request<ApiEnvelope<{ accountId: string; status: 'revoked'; revokedAt: string; financialVersion: number; affectedPeriodIds: string[] }>>(
      `/finance/accounts/${id}/revocations`, { method: 'POST', data },
    ),
  reauthorizeDemoAccount: (id: string) => request<ApiEnvelope<{ accountId: string; status: 'linked'; financialVersion: number;
    reauthorizedAt: string | null; reused: boolean }>>(`/finance/accounts/${id}/demo-reauthorizations`, {
      method: 'POST', data: { expectedStatus: 'revoked', acknowledgedDemoData: true },
    }),
  periods: () => request<ApiEnvelope<{ periods: import('./types').BudgetPeriod[] }>>('/budget-periods'),
  period: (id: string) => request<ApiEnvelope<BudgetPeriod>>(`/budget-periods/${id}`),
  rollingCashflow: (id: string) => request<ApiEnvelope<RollingCashflow>>(`/budget-periods/${id}/rolling-cashflow`),
  budgetItemImpact: (periodId: string, itemId: string) => request<ApiEnvelope<BudgetItemImpact>>(
    `/budget-periods/${periodId}/items/${itemId}/impact`,
  ),
  budgetLedgerLinks: (periodId: string) => request<ApiEnvelope<BudgetLedgerLinks>>(
    `/budget-periods/${periodId}/ledger-links`),
  linkBudgetLedger: (periodId: string, data: { entryId: string; itemId: string; coveredMinor: number;
    expectedFinancialVersion: number; expectedPeriodVersion: number; confirmedByUser: true }) =>
    request<ApiEnvelope<BudgetLedgerLinks>>(`/budget-periods/${periodId}/ledger-links`,
      { method: 'POST', data }),
  unlinkBudgetLedger: (periodId: string, linkId: string, expectedPeriodVersion: number) =>
    request<ApiEnvelope<BudgetLedgerLinks>>(`/budget-periods/${periodId}/ledger-links/${linkId}/unlinks`,
      { method: 'POST', data: { expectedPeriodVersion, confirmedByUser: true } }),
  budgetItemChangePreview: (periodId: string, data: BudgetItemInput) => request<ApiEnvelope<BudgetItemChangePreview>>(
    `/budget-periods/${periodId}/items/change-preview`, { method: 'POST', data, idempotent: false },
  ),
  createPeriod: (data: { accountId: string; monthStart: string; savingsTargetMinor: number; expectedFinancialVersion: number }) =>
    request<ApiEnvelope<BudgetPeriod>>('/budget-periods', { method: 'POST', data }),
  changeSavingsTarget: (id: string, data: { newTargetMinor: number; expectedPeriodVersion: number; reason: string; confirmedByUser: true }) =>
    request<ApiEnvelope<BudgetPeriod & { targetChangeId: string | null }>>(`/budget-periods/${id}/savings-target`, { method: 'PATCH', data }),
  activatePeriod: (id: string, data: { expectedFinancialVersion: number; expectedPeriodVersion: number; confirmedNecessities: true }) =>
    request<ApiEnvelope<BudgetPeriod>>(`/budget-periods/${id}/activations`, { method: 'POST', data }),
  closePeriod: (id: string, data: { expectedPeriodVersion: number; confirmedByUser: true; reason: string }) =>
    request<ApiEnvelope<BudgetPeriod>>(`/budget-periods/${id}/closures`, { method: 'POST', data }),
  saveBudgetItem: (data: BudgetItemInput) => request<ApiEnvelope<{ item: import('./types').BudgetItem; basis: BudgetPeriod['basis'] }>>(
    data.itemId ? `/budget-periods/${data.periodId}/items/${data.itemId}` : `/budget-periods/${data.periodId}/items`,
    { method: data.itemId ? 'PATCH' : 'POST', data },
  ),
  cancelBudgetItem: (periodId: string, itemId: string, expectedPeriodVersion: number, reason: string, expectedFinancialVersion?: number) =>
    request<ApiEnvelope<{ item: import('./types').BudgetItem; basis: BudgetPeriod['basis'] }>>(`/budget-periods/${periodId}/items/${itemId}/cancellations`, {
      method: 'POST', data: { periodId, itemId, expectedPeriodVersion, reason, expectedFinancialVersion },
    }),
  planningDraft: (id: string) => request<ApiEnvelope<PlanningDraft>>(`/ai/planning-drafts/${id}`),
  acceptPlanningDraft: (id: string) => request<ApiEnvelope<PlanningDraft>>(`/ai/planning-drafts/${id}/acceptance`, {
    method: 'POST', data: { expectedStatus: 'draft', confirmedByUser: true },
  }),
  discardPlanningDraft: (id: string) => request<ApiEnvelope<PlanningDraft>>(`/ai/planning-drafts/${id}/discard`, {
    method: 'POST', data: { expectedStatus: 'draft', confirmedByUser: true },
  }),
  changeLedgerCategory: (id: string, category: string) => request<ApiEnvelope<{ entryId: string; originalCategory: string | null; displayCategory: string; updatedAt: string }>>(`/finance/ledger/${id}/category`, {
    method: 'PATCH', data: { category },
  }),
  offers: (plannedOn: string, categoryCode?: string | null) => request<ApiEnvelope<{ items: Offer[] }>>(`/offers?plannedOn=${encodeURIComponent(plannedOn)}${categoryCode ? `&categoryCode=${encodeURIComponent(categoryCode)}` : ''}`),
  offer: (id: string) => request<ApiEnvelope<Offer>>(`/offers/${id}`),
  offerQuote: (id: string, plannedOn: string) => request<ApiEnvelope<OfferQuote>>(`/offers/${id}/quote?plannedOn=${encodeURIComponent(plannedOn)}`),
  assessPurchase: (data: { periodId: string; budgetItemId: string; quoteId: string; expectedFinancialVersion: number; expectedPeriodVersion: number; expectedQuoteVersion: number; mode: 'preview' }) => request<ApiEnvelope<FundingAssessment>>('/finance/assessments', { method: 'POST', data }),
  createPurchaseIntent: (data: { periodId: string; budgetItemId: string; quoteId: string; assessmentId: string; expectedFinancialVersion: number; expectedPeriodVersion: number; expectedQuoteVersion: number }) => request<ApiEnvelope<PurchaseIntentProposal>>('/purchase-intents', { method: 'POST', data }),
  purchaseIntents: () => request<ApiEnvelope<{ intents: PurchaseIntent[] }>>('/purchase-intents'),
  purchaseIntent: (id: string) => request<ApiEnvelope<PurchaseIntent>>(`/purchase-intents/${id}`),
  confirmPurchaseIntent: (id: string, data: { acceptedAmountMinor: number; expectedFinancialVersion: number; expectedPeriodVersion: number; expectedQuoteVersion: number; confirmedByUser: true }) => request<ApiEnvelope<{ order: ConsumerOrder }>>(`/purchase-intents/${id}/confirm`, { method: 'POST', data }),
  rejectPurchaseIntent: (id: string) => request<ApiEnvelope<{ purchaseIntentId: string; status: string }>>(`/purchase-intents/${id}/rejections`, { method: 'POST', data: { expectedStatus: 'proposed' } }),
  orders: () => request<ApiEnvelope<{ orders: ConsumerOrder[] }>>('/orders'),
  order: (id: string) => request<ApiEnvelope<ConsumerOrder>>(`/orders/${id}`),
  orderAftercare: (id: string) => request<ApiEnvelope<OrderAftercare>>(`/orders/${id}/aftercare`),
  refundRecheck: (id: string) => request<ApiEnvelope<{ orderId: string; batchId: string; status: string;
    operationId: string | null; reused: boolean }>>(`/orders/${id}/refund-rechecks`, { method: 'POST', data: {} }),
  paymentReadiness: () => request<PaymentReadiness>('/payment-readiness'),
  runtimeStatus: () => request<ApiEnvelope<RuntimeStatus>>('/runtime-status'),
  paymentHandoff: (id: string) => request<PaymentHandoff>(`/orders/${id}/payment-handoffs`, { method: 'POST', data: {} }),
  paymentRecheck: (id: string) => request<PaymentRecheck>(`/orders/${id}/payment-rechecks`, { method: 'POST', data: {} }),
  operation: (id: string) => request<Operation>(`/operations/${id}`),
  aftercarePreview: (id: string, action: 'close' | 'cancel') => request<ApiEnvelope<AftercarePreview>>(`/orders/${id}/aftercare-previews`, { method: 'POST', data: { action } }),
  confirmAftercare: (id: string, data: { previewId: string; acceptedFeeMinor: number; acceptedRefundMinor: number; confirmedByUser: true }) => request<ApiEnvelope<AftercareConfirmation>>(`/orders/${id}/aftercare-confirmations`, { method: 'POST', data }),
  assessEmergency: (data: { periodId: string; amountMinor: number; plannedOn: string; reason: string; expectedFinancialVersion: number; expectedPeriodVersion: number }) => request<ApiEnvelope<Adjustment>>('/emergencies/assess', { method: 'POST', data }),
  adjustment: (id: string) => request<ApiEnvelope<AdjustmentDetail>>(`/adjustments/${id}`),
  confirmAdjustment: (id: string, data: { acceptedOptionId: string; expectedFinancialVersion: number; expectedPeriodVersion: number; confirmedByUser: true }) => request<ApiEnvelope<AdjustmentConfirmation>>(`/adjustments/${id}/confirm`, { method: 'POST', data }),
  periodEvents: (id: string) => request<ApiEnvelope<{ events: PeriodEvent[] }>>(`/budget-periods/${id}/events`),
  periodReview: (id: string) => request<ApiEnvelope<PeriodReview>>(`/budget-periods/${id}/review`),
  startAgent: (message: string, periodId: string | null, ledgerMonth: string | null = null) => request<ApiEnvelope<{ runId: string; reused: boolean; mode: string }>>('/ai/agent-runs', { method: 'POST', data: { message, periodId, ledgerMonth } }),
  agentRun: (id: string) => request<ApiEnvelope<import('./types').AgentRun>>(`/ai/agent-runs/${id}`),
  agentRuns: (cursor?: string) => request<ApiEnvelope<{ items: AgentRunSummary[]; nextCursor: string | null }>>(
    `/ai/agent-runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  ),
  cancelAgentRun: (id: string) => request<ApiEnvelope<import('./types').AgentRun>>(`/ai/agent-runs/${id}/cancel`, {
    method: 'POST', data: {}, idempotent: false,
  }),
};

export function goLogin() { Taro.reLaunch({ url: '/pages/login/index' }); }
