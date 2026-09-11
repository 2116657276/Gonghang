import { AlipaySdk } from 'alipay-sdk';
import { config } from '../config.js';
import { AppError } from '../domain/errors.js';

const requiredSandboxFields = [
  ['ALIPAY_SANDBOX_APP_ID', 'appId'],
  ['ALIPAY_SANDBOX_PRIVATE_KEY', 'privateKey'],
  ['ALIPAY_SANDBOX_PUBLIC_KEY', 'publicKey'],
  ['ALIPAY_SANDBOX_SELLER_ID', 'sellerId'],
  ['ALIPAY_SANDBOX_GATEWAY', 'gateway'],
  ['ALIPAY_SANDBOX_RETURN_URL', 'returnUrl'],
] as const;

export const paymentHandoffLifetimeMs = 15 * 60 * 1000;

export type SandboxReadiness = {
  mode: 'simulation' | 'sandbox';
  ready: boolean;
  missing: string[];
};

export function sandboxReadiness(): SandboxReadiness {
  const missing = requiredSandboxFields
    .filter(([, key]) => !config.alipaySandbox[key])
    .map(([name]) => name);
  return {
    mode: config.paymentMode,
    ready: config.paymentMode === 'sandbox' && missing.length === 0,
    missing: config.paymentMode === 'sandbox' ? missing : [],
  };
}

function requiredSandboxConfig(): {
  appId: string;
  privateKey: string;
  publicKey: string;
  sellerId: string;
  gateway: string;
  notifyUrl?: string;
  returnUrl: string;
} {
  const readiness = sandboxReadiness();
  if (readiness.mode !== 'sandbox') {
    throw new AppError(409, 'PAYMENT_SANDBOX_DISABLED', '当前仍为本地模拟模式，官方沙箱付款没有启用。');
  }
  if (!readiness.ready) {
    throw new AppError(409, 'PAYMENT_SANDBOX_NOT_READY', '沙箱配置尚未齐全，系统没有发送任何外部支付请求。', { missing: readiness.missing });
  }
  const gateway = new URL(config.alipaySandbox.gateway!);
  if (gateway.protocol !== 'https:' || !['openapi-sandbox.dl.alipaydev.com', 'openapi.alipaydev.com'].includes(gateway.hostname)
    || gateway.pathname !== '/gateway.do' || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new AppError(409, 'PAYMENT_GATEWAY_REJECTED', '只允许已明确列出的支付宝沙箱网关。');
  }
  return {
    appId: config.alipaySandbox.appId!,
    privateKey: config.alipaySandbox.privateKey!,
    publicKey: config.alipaySandbox.publicKey!,
    sellerId: config.alipaySandbox.sellerId!,
    gateway: config.alipaySandbox.gateway!,
    notifyUrl: config.alipaySandbox.notifyUrl,
    returnUrl: config.alipaySandbox.returnUrl!,
  };
}

function client() {
  const sandbox = requiredSandboxConfig();
  return new AlipaySdk({
    appId: sandbox.appId,
    privateKey: sandbox.privateKey,
    alipayPublicKey: sandbox.publicKey,
    gateway: sandbox.gateway,
    signType: 'RSA2',
    timeout: 15_000,
  });
}

function asYuan(amountMinor: number) {
  return (amountMinor / 100).toFixed(2);
}

export function yuanToMinor(value: string): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return;
  const [integer, fraction = ''] = value.split('.');
  const amount = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : undefined;
}

export function createAlipayHandoff(input: {
  businessNumber: string;
  amountMinor: number;
  subject: string;
}) {
  const sandbox = requiredSandboxConfig();
  const pageParams = {
    bizContent: {
      outTradeNo: input.businessNumber,
      totalAmount: asYuan(input.amountMinor),
      subject: input.subject.slice(0, 120),
      productCode: 'FAST_INSTANT_TRADE_PAY',
      timeoutExpress: '15m',
    },
    returnUrl: sandbox.returnUrl,
    ...(sandbox.notifyUrl ? { notifyUrl: sandbox.notifyUrl } : {}),
  };
  const handoffUrl = client().pageExecute('alipay.trade.page.pay', 'GET', pageParams);
  return { handoffUrl, expiresAt: new Date(Date.now() + paymentHandoffLifetimeMs) };
}

export type AlipayTradeQueryResult = {
  code?: string;
  msg?: string;
  subCode?: string;
  subMsg?: string;
  outTradeNo?: string;
  tradeNo?: string;
  totalAmount?: string;
  tradeStatus?: string;
  sellerId?: string;
  traceId?: string;
};

export async function queryAlipayTrade(businessNumber: string): Promise<AlipayTradeQueryResult> {
  const result = await client().exec('alipay.trade.query', {
    bizContent: { outTradeNo: businessNumber },
  }, { validateSign: true });
  return {
    code: result.code,
    msg: result.msg,
    subCode: result.subCode,
    subMsg: result.subMsg,
    outTradeNo: result.outTradeNo,
    tradeNo: result.tradeNo,
    totalAmount: result.totalAmount,
    tradeStatus: result.tradeStatus,
    sellerId: result.sellerId,
    traceId: result.traceId,
  };
}

export function verifyAlipayNotification(rawPayload: Record<string, string>) {
  try {
    return client().checkNotifySignV2(rawPayload);
  } catch {
    return false;
  }
}


export type RefundQueryResult = {
  code?: string; subCode?: string; outTradeNo?: string; outRequestNo?: string;
  refundAmount?: string; refundStatus?: string;
};

export async function closeAlipayTrade(businessNumber: string) {
  const result = await client().exec('alipay.trade.close', {
    bizContent: { outTradeNo: businessNumber },
  }, { validateSign: true });
  return { code: result.code as string | undefined, subCode: result.subCode as string | undefined,
    outTradeNo: result.outTradeNo as string | undefined };
}

export async function refundAlipayTrade(businessNumber: string, refundNumber: string, amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new AppError(422, 'INVALID_REFUND_AMOUNT', '退款金额必须为正整数分。');
  const result = await client().exec('alipay.trade.refund', {
    bizContent: { outTradeNo: businessNumber, outRequestNo: refundNumber, refundAmount: asYuan(amountMinor) },
  }, { validateSign: true });
  // refundFee is cumulative. A specific batch is confirmed by refund query.
  return { code: result.code as string | undefined, subCode: result.subCode as string | undefined,
    outTradeNo: result.outTradeNo as string | undefined, fundChange: result.fundChange as string | undefined };
}

export async function queryAlipayRefund(businessNumber: string, refundNumber: string): Promise<RefundQueryResult> {
  const result = await client().exec('alipay.trade.fastpay.refund.query', {
    bizContent: { outTradeNo: businessNumber, outRequestNo: refundNumber },
  }, { validateSign: true });
  return { code: result.code, subCode: result.subCode, outTradeNo: result.outTradeNo,
    outRequestNo: result.outRequestNo, refundAmount: result.refundAmount, refundStatus: result.refundStatus };
}

export function refundQueryConfirmed(result: RefundQueryResult, orderNumber: string, refundNumber: string, amountMinor: number) {
  return result.code === '10000' && result.refundStatus === 'REFUND_SUCCESS'
    && result.outTradeNo === orderNumber && result.outRequestNo === refundNumber
    && typeof result.refundAmount === 'string' && yuanToMinor(result.refundAmount) === amountMinor;
}
