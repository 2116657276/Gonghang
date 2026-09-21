export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const fallbackMessages: Record<string, string> = {
  INVALID_CREDENTIALS: '账号或密码不正确。',
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  SESSION_EXPIRED: '登录状态已过期，请重新登录。',
  FORBIDDEN: '当前账号没有执行此操作的权限。',
  INVALID_ORIGIN: '当前请求来源未被允许。',
  VERSION_CONFLICT: '页面数据已经发生变化，请刷新后重新确认。',
  FINANCIAL_VERSION_CONFLICT: '账户资金事实已经更新，请刷新后重新确认。',
  PERIOD_VERSION_CONFLICT: '预算周期已经更新，请刷新后重新确认。',
  PERIOD_NOT_ENDED: '本预算周期尚未结束，到期后才能归档。',
  PERIOD_CLOSE_BLOCKED: '仍有待确认、支付、退款或复核事项，请先处理完再归档。',
  QUOTE_STALE: '报价已经失效，请重新获取报价。',
  PURCHASE_INTENT_EXPIRED: '购买确认已过期，请返回候选页重新报价。',
  IDEMPOTENCY_CONFLICT: '本次提交内容与原请求不一致，请重新确认。',
  ACCOUNT_REVOKED: '当前账户授权已经撤回，无法继续新的资金操作。',
  FINANCE_SCOPE_REVOKED: '账户授权已经撤回，不能继续新的资金操作。',
  EXTERNAL_ACCOUNT_REAUTHORIZATION_REQUIRED: '真实账户需要重新完成银行授权，当前演示环境不能代替银行确认。',
  PROVIDER_RESULT_UNKNOWN: '渠道结果暂时无法确认，请稍后主动复核。',
  PAYMENT_SANDBOX_NOT_READY: '支付宝沙箱配置尚未就绪，请在环境说明中查看状态。',
  PAYMENT_QUERY_FAILED: '暂时无法取得支付结果，请稍后重试。',
  REFUND_RECHECK_UNAVAILABLE: '当前退款没有可主动复核的渠道批次，请查看处理记录。',
  RESOURCE_FORBIDDEN: '该记录不存在，或当前账号无权查看。',
  MODEL_NOT_CONFIGURED: 'AI 服务暂未配置，结构化规划功能仍可继续使用。',
  API_BASE_NOT_CONFIGURED: '微信小程序尚未配置可访问的 API 地址。',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试。',
};

export function parseApiError(data: unknown, status: number): ApiError {
  const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const rawError = body.error;
  const nested = rawError && typeof rawError === 'object' ? rawError as Record<string, unknown> : undefined;
  const code = typeof nested?.code === 'string'
    ? nested.code
    : typeof rawError === 'string' ? rawError : undefined;
  const message = typeof nested?.message === 'string'
    ? nested.message
    : typeof body.message === 'string'
      ? body.message
      : code && fallbackMessages[code]
        ? fallbackMessages[code]
        : status >= 500 ? '服务暂时不可用，请稍后重试。' : '请求没有完成，请重新确认。';
  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : undefined;
  return new ApiError(message, status, code, correlationId);
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError) return `${reason.message}${reason.correlationId ? `（问题编号：${reason.correlationId}）` : ''}`;
  if (reason instanceof Error && reason.message) return reason.message;
  return '操作没有完成，请稍后重试。';
}
