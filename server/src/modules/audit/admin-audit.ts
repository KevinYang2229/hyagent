/**
 * 後台設定變更稽核：掛在 requireAdmin 之後，管理 API 每一個有副作用的請求（POST/PUT/PATCH/DELETE）
 * 於回應送出後記一筆。集中在這一層做，新增管理端點時不會漏記。
 *
 * - 只記路徑、欄位名、上傳檔名與來源 IP；**不記 body 內容**（政策、金鑰、prompt 等都可能敏感）
 * - 租戶層動作記在該租戶；平台層動作與「刪除租戶」記在平台桶——刪租戶會級聯清掉該租戶稽核，
 *   記在租戶桶等於刪除的同時銷毀證據
 * - 成功與失敗都記：被拒的變更嘗試同樣是稽核要看的；掛在 authorizeAdmin 之前，
 *   租戶管理者被權限擋下（403）的嘗試也會記到
 * - 租戶管理者的操作：userId 為 `tenant-admin:<accountId>`，summary 開頭加上 `帳號 <username>｜`
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '@/lib/logger';
import type { AdminPrincipal } from '@/middlewares/require-admin';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { auditStore } from './audit.store';

/** 平台層稽核的 bucket key（租戶 id 為 hex 或 default，不會撞名） */
export const PLATFORM_AUDIT_TENANT = '_platform';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** service 已自行記稽核（含欄位語意）的路徑，避免同一動作記兩筆 */
const SELF_AUDITED = [/^\/tenants\/[^/]+\/llm-config$/];

const TENANT_PATH = /^\/tenants\/([^/]+)(\/.*)?$/;

/**
 * requireAdmin 寫入 res.locals.adminActor：admin JWT、機器對機器的 x-admin-key，
 * 或租戶管理者（冒號後為 accountId）。字串聯集，既有持久化的 'admin'／'admin-api-key' 仍然有效。
 */
export type AdminActor = 'admin' | 'admin-api-key' | `tenant-admin:${string}`;

/** authorizeAdmin 拒絕時寫入 res.locals 的旗標；SELF_AUDITED 路徑的 service 沒機會執行，改由這層補記 */
export const ADMIN_AUTHZ_DENIED = 'adminAuthzDenied';

function bucketFor(method: string, path: string): string {
  const m = TENANT_PATH.exec(path);
  if (!m) return PLATFORM_AUDIT_TENANT;
  const isTenantDelete = method === 'DELETE' && !m[2];
  const tenantId = decodeURIComponent(m[1]);
  // 租戶不存在（建錯 id、或剛被刪）時記平台桶，不憑空開一個租戶 bucket
  return isTenantDelete || !tenantStore.getTenant(tenantId) ? PLATFORM_AUDIT_TENANT : tenantId;
}

function fieldNames(body: unknown): string[] {
  return body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
}

export function adminAuditTrail(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) {
    next();
    return;
  }
  // req.path 是相對於 adminRouter 的路徑；進入子路由後會被改寫，所以在這裡先取
  const path = req.path;
  const selfAudited = SELF_AUDITED.some((re) => re.test(path));
  const method = req.method;
  const fields = fieldNames(req.body);

  res.on('finish', () => {
    // 自行記稽核的路徑：只有被授權層擋下（service 沒執行）時才由這裡記
    if (selfAudited && res.locals[ADMIN_AUTHZ_DENIED] !== true) return;
    try {
      const ok = res.statusCode < 400;
      const principal = res.locals.adminPrincipal as AdminPrincipal | undefined;
      const parts: string[] = [];
      if (principal?.kind === 'tenant-admin') parts.push(`帳號 ${principal.account.username}`);
      parts.push(`${method} ${path}`);
      if (fields.length > 0) parts.push(`欄位：${fields.join('、')}`);
      if (req.file?.originalname) parts.push(`檔案：${req.file.originalname}`);
      if (req.ip) parts.push(`來源 ${req.ip}`);
      auditStore.record(bucketFor(method, path), {
        toolId: 'admin.config',
        userId: (res.locals.adminActor as AdminActor | undefined) ?? 'admin',
        at: new Date().toISOString(),
        ok,
        summary: parts.join('｜'),
        ...(ok ? {} : { error: `HTTP ${res.statusCode}` }),
      });
    } catch (err) {
      // 旁路：稽核失敗不影響已送出的回應
      logger.warn({ err, path }, 'admin audit record failed (ignored)');
    }
  });
  next();
}
