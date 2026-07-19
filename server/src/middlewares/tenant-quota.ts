/**
 * 每租戶月度 LLM token 配額守門（兩層守門的第二層；第一層為 tenant-rate-limit）。
 *
 * 讀 tenant.quotaMonthlyLlmTokens（0 或未設＝不限），對照 usage 的當月分桶，
 * 超過即 429——防長期累積把平台金鑰的成本燒穿；rate limit 防的是突發轟炸。
 * 須掛在 resolveTenant 之後（才有 req.tenant）、掛在會觸發 LLM 的路由（conversations）。
 */
import type { NextFunction, Request, Response } from 'express';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';

export function tenantMonthlyQuota(req: Request, _res: Response, next: NextFunction): void {
  const tenant = req.tenant;
  const quota = tenant?.quotaMonthlyLlmTokens;
  if (tenant && quota && quota > 0) {
    const used = usageStore.currentMonthLlmTokens(tenant.id);
    if (used >= quota) {
      next(
        AppError.tooManyRequests(
          `此租戶本月 AI 用量已達上限（${used.toLocaleString()} / ${quota.toLocaleString()} tokens），請下月再試或聯繫管理員調整配額`,
        ),
      );
      return;
    }
  }
  next();
}
