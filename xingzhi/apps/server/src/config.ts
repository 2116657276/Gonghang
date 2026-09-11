import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const paymentModeValue = process.env.PAYMENT_MODE ?? 'simulation';
if (paymentModeValue !== 'simulation' && paymentModeValue !== 'sandbox') {
  throw new Error('PAYMENT_MODE 只能是 simulation 或 sandbox。');
}
const paymentMode: 'simulation' | 'sandbox' = paymentModeValue;

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgresql://localhost:5432/xingzhi_dev'),
  port: Number(process.env.PORT ?? 8787),
  webOrigin: required('WEB_ORIGIN', 'http://localhost:5173'),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  paymentMode,
  alipaySandbox: {
    appId: process.env.ALIPAY_SANDBOX_APP_ID,
    privateKey: process.env.ALIPAY_SANDBOX_PRIVATE_KEY,
    publicKey: process.env.ALIPAY_SANDBOX_PUBLIC_KEY,
    sellerId: process.env.ALIPAY_SANDBOX_SELLER_ID,
    gateway: process.env.ALIPAY_SANDBOX_GATEWAY,
    notifyUrl: process.env.ALIPAY_SANDBOX_NOTIFY_URL,
    returnUrl: process.env.ALIPAY_SANDBOX_RETURN_URL,
  },
};
