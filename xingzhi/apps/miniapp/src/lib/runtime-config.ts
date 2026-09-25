import { ApiError } from './errors';

export const isH5Runtime = process.env.TARO_ENV === 'h5';

export function apiBase(): string {
  if (isH5Runtime) return '';
  const configured = process.env.TARO_APP_API_BASE?.trim().replace(/\/+$/, '');
  if (!configured) {
    throw new ApiError('微信小程序尚未配置可访问的 API 地址。', 0, 'API_BASE_NOT_CONFIGURED');
  }
  const isLocalTesting = configured === 'http://127.0.0.1:8877'
    || configured === 'http://localhost:8877'
    || /^http:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/.test(configured);
  if (process.env.NODE_ENV === 'production' && !configured.startsWith('https://') && !isLocalTesting) {
    throw new ApiError('微信小程序发布构建必须使用 HTTPS API 地址。', 0, 'API_BASE_NOT_CONFIGURED');
  }
  return configured;
}
