/**
 * Scope 目錄：全系統可辨識的能力清單（單一來源）。
 * base=true 為全員基礎（BASE，不可授予/取消）；base=false 為可授予能力（grantable）。
 * admin UI 據此渲染、後端據此驗證（授予範圍只能是 grantable，杜絕目錄外與 '*'）。
 */
import { AppError } from '@/utils/app-error';
import { listDefinitions } from '@/modules/form/form.registry';

export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  base: boolean;
}

export const SCOPE_CATALOG: ScopeDef[] = [
  { id: 'oa:read', label: '查詢額度', description: '查詢假別剩餘時數等唯讀資料', base: true },
  { id: 'oa:write', label: '送出表單', description: '將表單送至 OA 系統', base: true },
  { id: 'service:form', label: '填表申請', description: '使用填寫並送出表單的對話服務', base: false },
  { id: 'service:knowledge', label: '知識庫問答', description: '使用公司規章 / FAQ 問答服務', base: false },
  { id: 'service:agent', label: '智慧代理', description: '使用跨工具多步驟的智慧代理服務', base: false },
  { id: 'email:write', label: '寄送 Email', description: '代寄通知信 / 邀請信', base: false },
  { id: 'calendar:read', label: '讀取行事曆', description: '查詢空檔 / 會議', base: false },
  { id: 'calendar:write', label: '建立行事曆', description: '建立會議 / 邀請', base: false },
  { id: 'erp:read', label: '讀取 ERP', description: '查詢庫存 / 訂單 / 人事等', base: false },
];

export const BASE_SCOPE_IDS: string[] = SCOPE_CATALOG.filter((s) => s.base).map((s) => s.id);
export const GRANTABLE_SCOPES: ScopeDef[] = SCOPE_CATALOG.filter((s) => !s.base);
export const GRANTABLE_SCOPE_IDS: Set<string> = new Set(GRANTABLE_SCOPES.map((s) => s.id));

export function isGrantableScope(id: string): boolean {
  return GRANTABLE_SCOPE_IDS.has(id);
}

/** 驗證一組 scope 皆可授予；form:<id> 需該租戶存在此表單。BASE / '*' / 目錄外一律 400。 */
export function assertGrantableScopes(ids: string[], tenantId?: string): void {
  const validFormIds = tenantId
    ? new Set(listDefinitions(tenantId).map((d) => formScopeId(d.formId)))
    : new Set<string>();
  const ok = (id: string): boolean =>
    GRANTABLE_SCOPE_IDS.has(id) || validFormIds.has(id);
  const bad = ids.filter((id) => !ok(id));
  if (bad.length > 0) throw AppError.badRequest(`不可授予的 scope：${bad.join('、')}`);
}

export const SERVICE_SCOPE_IDS: Set<string> = new Set([
  'service:form',
  'service:knowledge',
  'service:agent',
]);

/** 表單 scope id：form:<formId>。 */
export function formScopeId(formId: string): string {
  return `form:${formId}`;
}

/** 某租戶可授予的能力：靜態 grantable + 該租戶各表單的 form:<id>（label 用表單標題）。 */
export function tenantGrantableScopes(tenantId: string): ScopeDef[] {
  const forms: ScopeDef[] = listDefinitions(tenantId).map((d) => ({
    id: formScopeId(d.formId),
    label: d.data.title ?? d.formId,
    description: `使用「${d.data.title ?? d.formId}」表單`,
    base: false,
  }));
  return [...GRANTABLE_SCOPES, ...forms];
}
