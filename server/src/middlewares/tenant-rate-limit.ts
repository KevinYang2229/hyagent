/**
 * 速率限制（兩層守門的第一層；第二層為 tenant-quota 月配額）：防突發轟炸。
 *
 * 計數 key＝`${tenantId}:${使用者}`——同租戶內的不同使用者各自一桶，單一使用者狂刷
 * 不會吃光整個租戶的額度。使用者取 JWT sub（掛在 requireAuth 之後），未認證流量
 * （如 /api/tenant 的 sk_ 自助端點）退回以租戶為粒度。沿用 env 的 RATE_LIMIT_* 設定。
 * 須掛在 resolveTenant 之後（才有 req.tenant）。
 */
import rateLimit from 'express-rate-limit';
import { env } from '@/config/env';

/** factory：測試可注入小額度驗證計數行為；正式入口用下方以 env 建好的實例 */
export function makeTenantRateLimit(opts: { windowMs: number; limit: number }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${req.tenant?.id ?? 'default'}:${req.user?.sub ?? 'tenant'}`,
  });
}

export const tenantRateLimit = makeTenantRateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
});
