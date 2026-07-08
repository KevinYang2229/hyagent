/**
 * Scope 目錄：全系統可辨識的能力清單（單一來源）。
 * base=true 為全員基礎（BASE，不可授予/取消）；base=false 為可授予能力（grantable）。
 * admin UI 據此渲染、後端據此驗證（授予範圍只能是 grantable，杜絕目錄外與 '*'）。
 */
import { AppError } from '@/utils/app-error';

export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  base: boolean;
}

export const SCOPE_CATALOG: ScopeDef[] = [
  { id: 'oa:read', label: '查詢額度', description: '查詢假別剩餘時數等唯讀資料', base: true },
  { id: 'oa:write', label: '送出表單', description: '將表單送至 OA 系統', base: true },
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

/** 驗證一組 scope 皆為可授予；否則丟 400（BASE、'*'、目錄外皆不可授予）。 */
export function assertGrantableScopes(ids: string[]): void {
  const bad = ids.filter((id) => !GRANTABLE_SCOPE_IDS.has(id));
  if (bad.length > 0) throw AppError.badRequest(`不可授予的 scope：${bad.join('、')}`);
}
