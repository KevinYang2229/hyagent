/**
 * requireAdmin：保護管理 API。通過條件為以下任一：
 *   1. x-admin-key header 等於 env.ADMIN_API_KEY（機器對機器，向後相容）
 *   2. Authorization: Bearer <admin JWT>（role=admin，後台登入換發）
 *   3. Authorization: Bearer <tenant-admin JWT>（租戶管理者登入換發）：每個請求都從 store 重新載入帳號，
 *      帳號須存在、啟用中，且 tenantId、credentialVersion 與 token 相符；停用／刪除／改密碼後舊 token 立即失效。
 *      能做什麼由之後的 authorizeAdmin 依分頁權限把關。
 *
 * 安全預設：ADMIN_API_KEY 與 ADMIN_PASSWORD 都未設時，管理 API 一律 403（停用）。
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config/env';
import type { AdminActor } from '@/modules/audit/admin-audit';
import { AppError } from '@/utils/app-error';
import { verifyAdminToken, verifyTenantAdminToken } from '@/utils/jwt';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import type { AdminAccount } from '@/modules/admin-account/admin-account.types';

/** requireAdmin 通過後寫入 res.locals.adminPrincipal，供授權與 /me 使用 */
export type AdminPrincipal =
  | { kind: 'super' }
  | { kind: 'api-key' }
  | { kind: 'tenant-admin'; account: AdminAccount };

/** 驗證租戶管理者 token 並載入當下的帳號；任何不符都回 undefined（由呼叫端統一回 401）。 */
function tenantAdminFromToken(token: string): AdminAccount | undefined {
  let payload;
  try {
    payload = verifyTenantAdminToken(token);
  } catch {
    return undefined;
  }
  const account = adminAccountStore.get(payload.sub);
  if (
    !account ||
    account.status !== 'active' ||
    account.tenantId !== payload.tenantId ||
    account.credentialVersion !== payload.credentialVersion
  ) {
    return undefined;
  }
  return account;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_API_KEY && !env.ADMIN_PASSWORD) {
    throw AppError.forbidden('管理 API 未啟用（未設定 ADMIN_API_KEY / ADMIN_PASSWORD）');
  }

  // 模式 1：x-admin-key
  const key = req.header('x-admin-key');
  if (key && env.ADMIN_API_KEY && key === env.ADMIN_API_KEY) {
    res.locals.adminActor = 'admin-api-key' satisfies AdminActor;
    res.locals.adminPrincipal = { kind: 'api-key' } satisfies AdminPrincipal;
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
        res.locals.adminPrincipal = { kind: 'super' } satisfies AdminPrincipal;
        next();
        return;
      }
    } catch {
      // 不是 super token，改試租戶管理者 token
    }
    const account = tenantAdminFromToken(token);
    if (account) {
      res.locals.adminActor = `tenant-admin:${account.id}` satisfies AdminActor;
      res.locals.adminPrincipal = { kind: 'tenant-admin', account } satisfies AdminPrincipal;
      next();
      return;
    }
  }

  throw AppError.unauthorized('需要有效的管理金鑰或登入');
}
