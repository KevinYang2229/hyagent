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
export const guestRateLimit = makeAuthRateLimit(env.AUTH_GUEST_RATE_LIMIT_MAX);

/**
 * 自助改密碼（PUT /me/password）的失敗次數限制：依帳號計數（掛在 requireAdmin 之後，
 * 拿得到 adminPrincipal），只算失敗的請求，避免有效 token 被拿來暴力猜目前密碼。
 */
export const adminChangePasswordRateLimit = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_ADMIN_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (_req, res) => {
    const principal = (res.locals as { adminPrincipal?: { kind: string; account?: { id: string } } }).adminPrincipal;
    return principal?.kind === 'tenant-admin' && principal.account ? `tenant-admin:${principal.account.id}` : 'super';
  },
  message: { error: { code: 'RATE_LIMITED', message: '密碼嘗試次數過多，請稍後再試' } },
});
