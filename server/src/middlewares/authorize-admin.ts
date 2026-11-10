/**
 * authorizeAdmin：掛在 requireAdmin、adminAuditTrail 之後，依分頁權限把關租戶管理者。
 *
 * - super 與 x-admin-key 直接放行（行為不變）
 * - 租戶管理者交給 decideTenantAdmin 判斷（規則表見 admin-account/admin-route-policy.ts）；
 *   規則表沒列到的路由一律 403
 * - req.path 相對於 adminRouter（與規則表的 pattern 同基準）；必須掛在 adminRouter 這一層，
 *   不能掛進子 router（子 router 內 req.path 會被改寫）
 * - multipart 上傳路由此時 req.body 尚未解析；那些路由不是 tenantPatch，不讀 body，沒有影響
 */
import type { NextFunction, Request, Response } from 'express';
import { decideTenantAdmin } from '@/modules/admin-account/admin-route-policy';
import { ADMIN_AUTHZ_DENIED } from '@/modules/audit/admin-audit';
import { AppError } from '@/utils/app-error';
import type { AdminPrincipal } from './require-admin';

export function authorizeAdmin(req: Request, res: Response, next: NextFunction): void {
  const principal = res.locals.adminPrincipal as AdminPrincipal | undefined;
  // requireAdmin 一定會寫入 principal；缺少代表掛載順序錯誤，安全起見拒絕
  if (!principal) throw AppError.unauthorized('需要有效的管理金鑰或登入');
  if (principal.kind !== 'tenant-admin') {
    next();
    return;
  }
  const decision = decideTenantAdmin({
    method: req.method,
    path: req.path,
    body: req.body,
    tenantId: principal.account.tenantId,
    permissions: principal.account.permissions,
  });
  if (!decision.allow) {
    res.locals[ADMIN_AUTHZ_DENIED] = true;
    throw AppError.forbidden(decision.reason);
  }
  next();
}
