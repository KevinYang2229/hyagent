import rateLimit from 'express-rate-limit';
import { env } from '@/config/env';

/** IP based: changing usernames, tenant keys or forged user headers cannot reset the quota. */
export function makeAuthRateLimit(limit: number, windowMs = env.AUTH_RATE_LIMIT_WINDOW_MS) {
  return rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: '登入請求過於頻繁，請稍後再試' } },
  });
}
export const loginRateLimit = makeAuthRateLimit(env.AUTH_LOGIN_RATE_LIMIT_MAX);
export const adminLoginRateLimit = makeAuthRateLimit(env.AUTH_ADMIN_RATE_LIMIT_MAX);
export const ssoRateLimit = makeAuthRateLimit(env.AUTH_SSO_RATE_LIMIT_MAX);
export const refreshRateLimit = makeAuthRateLimit(env.AUTH_REFRESH_RATE_LIMIT_MAX);
