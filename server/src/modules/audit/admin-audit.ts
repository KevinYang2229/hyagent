/**
 * 後台設定變更稽核：掛在 requireAdmin 之後，管理 API 每一個有副作用的請求（POST/PUT/PATCH/DELETE）
 * 於回應送出後記一筆。集中在這一層做，新增管理端點時不會漏記。
 *
 * - 只記路徑、欄位名、上傳檔名與來源 IP；**不記 body 內容**（政策、金鑰、prompt 等都可能敏感）
 * - 租戶層動作記在該租戶；平台層動作與「刪除租戶」記在平台桶——刪租戶會級聯清掉該租戶稽核，
 *   記在租戶桶等於刪除的同時銷毀證據
 * - 成功與失敗都記：被拒的變更嘗試同樣是稽核要看的
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { auditStore } from './audit.store';

/** 平台層稽核的 bucket key（租戶 id 為 hex 或 default，不會撞名） */
export const PLATFORM_AUDIT_TENANT = '_platform';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** service 已自行記稽核（含欄位語意）的路徑，避免同一動作記兩筆 */
const SELF_AUDITED = [/^\/tenants\/[^/]+\/llm-config$/];

const TENANT_PATH = /^\/tenants\/([^/]+)(\/.*)?$/;

/** requireAdmin 寫入 res.locals.adminActor，區分 admin JWT 與機器對機器的 x-admin-key */
export type AdminActor = 'admin' | 'admin-api-key';

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
  if (SELF_AUDITED.some((re) => re.test(path))) {
    next();
    return;
  }
  const method = req.method;
  const fields = fieldNames(req.body);

  res.on('finish', () => {
    try {
      const ok = res.statusCode < 400;
      const parts = [`${method} ${path}`];
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
