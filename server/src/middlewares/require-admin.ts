/**
 * requireAdmin：保護管理 API。通過條件為以下任一：
 *   1. x-admin-key header 等於 env.ADMIN_API_KEY（機器對機器，向後相容）
 *   2. Authorization: Bearer <admin JWT>（role=admin，後台登入換發）
 *
 * 安全預設：ADMIN_API_KEY 與 ADMIN_PASSWORD 都未設時，管理 API 一律 403（停用）。
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config/env';
import type { AdminActor } from '@/modules/audit/admin-audit';
import { AppError } from '@/utils/app-error';
import { verifyAdminToken } from '@/utils/jwt';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_API_KEY && !env.ADMIN_PASSWORD) {
    throw AppError.forbidden('管理 API 未啟用（未設定 ADMIN_API_KEY / ADMIN_PASSWORD）');
  }

  // 模式 1：x-admin-key
  const key = req.header('x-admin-key');
  if (key && env.ADMIN_API_KEY && key === env.ADMIN_API_KEY) {
    res.locals.adminActor = 'admin-api-key' satisfies AdminActor;
    next();
    return;
  }

  // 模式 2：admin Bearer JWT
  const auth = req.header('authorization') ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = verifyAdminToken(token);
      if (payload.role === 'admin' && payload.via === 'password' && !payload.tenantId) {
        res.locals.adminActor = 'admin' satisfies AdminActor;
        next();
        return;
      }
    } catch {
      // 落到下方統一拒絕
    }
  }

  throw AppError.unauthorized('需要有效的管理金鑰或登入');
}
