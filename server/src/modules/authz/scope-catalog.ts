/**
 * Scope 目錄：全系統可辨識的能力清單（單一來源）。
 * base=true 為全員基礎（BASE，不可授予/取消）；base=false 為可授予能力（grantable）。
 * admin UI 據此渲染、後端據此驗證（授予範圍只能是 grantable，杜絕目錄外與 '*'）。
 */
import { AppError } from '@/utils/app-error';
import { listDefinitions } from '@/modules/form/form.registry';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

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
  // 刻意不列入 SERVICE_SCOPE_IDS：報告成本高，需 admin 明確授予後才開通，不隨新租戶預設開通。
  { id: 'service:report', label: '知識庫報告', description: '依知識庫檢索產生可下載的報告', base: false },
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

/** 知識庫可見性標籤的 scope 前綴 */
export const KB_SCOPE_PREFIX = 'kb:';

/** labelId → scope id */
export function kbScopeId(labelId: string): string {
  return `${KB_SCOPE_PREFIX}${labelId}`;
}

export function isKbScope(id: string): boolean {
  return id.startsWith(KB_SCOPE_PREFIX);
}

/**
 * labelId 限 [a-z0-9-]+。scope id 以冒號分段，label 內含冒號會讓 kb: 前綴的比對
 * 出現歧義——而該比對正是 assertTenantGrantable 這道安全檢查所依賴的。
 */
const LABEL_ID_RE = /^[a-z0-9-]+$/;

export function assertValidLabelId(labelId: string): void {
  if (!LABEL_ID_RE.test(labelId)) {
    throw AppError.badRequest(`標籤 id 只允許小寫英數與連字號：${labelId}`);
  }
}

/** 驗證一組 scope 皆可授予；form:<id> 需該租戶存在此表單、kb:<id> 需該租戶存在此標籤。BASE / '*' / 目錄外一律 400。 */
export function assertGrantableScopes(ids: string[], tenantId?: string): void {
  const validFormIds = tenantId
    ? new Set(listDefinitions(tenantId).map((d) => formScopeId(d.formId)))
    : new Set<string>();
  const validLabelIds = tenantId
    ? new Set((tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => kbScopeId(l.id)))
    : new Set<string>();
  const validMcpIds = tenantId ? tenantMcpScopeIds(tenantId) : new Set<string>();
  const ok = (id: string): boolean =>
    GRANTABLE_SCOPE_IDS.has(id) || validFormIds.has(id) || validLabelIds.has(id) || validMcpIds.has(id);
  const bad = ids.filter((id) => !ok(id));
  if (bad.length > 0) throw AppError.badRequest(`不可授予的 scope：${bad.join('、')}`);
}

/**
 * 租戶層（Tenant.grantedScopes）授予驗證。
 *
 * resolveScopes 會把 grantedScopes 併給該租戶**所有人，包含訪客身分**。
 * 該欄位語意是「這租戶買了哪些能力」，誤操作門檻很低——把 kb:hr 放進去，
 * 等於對公開 widget 開放人事文件。訪客的可見範圍改走部門指派（見 resolve-scopes），
 * 故此處無需任何白名單例外。
 *
 * tenantId 為選填：僅用來延續 assertGrantableScopes 對 form:<id> 的租戶歸屬驗證，
 * 與 kb: 前綴的拒絕邏輯（安全邊界）無關，不構成白名單例外。
 */
export function assertTenantGrantable(ids: string[], tenantId?: string): void {
  const kb = ids.filter(isKbScope);
  if (kb.length > 0) {
    throw AppError.badRequest(
      `租戶層不可授予知識庫標籤（會併給所有人含訪客）：${kb.join('、')}。請改於部門或帳號層指派。`,
    );
  }
  assertGrantableScopes(ids, tenantId);
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

/** MCP server scope：mcp:<serverId>。 */
export function mcpServerScopeId(serverId: string): string {
  return `mcp:${serverId}`;
}

/** 此租戶可授予的 MCP scope：共用 server 與該租戶專屬 server（不看啟用狀態，停用時仍可預先授權）。 */
function tenantMcpScopeIds(tenantId: string): Set<string> {
  return new Set(mcpStore.list().filter((s) => mcpStore.belongsTo(s, tenantId)).map((s) => mcpServerScopeId(s.id)));
}

/** 某租戶可授予的能力：靜態 grantable + 該租戶各表單的 form:<id>（label 用表單標題）。 */
export function tenantGrantableScopes(tenantId: string): ScopeDef[] {
  const forms: ScopeDef[] = listDefinitions(tenantId).map((d) => ({
    id: formScopeId(d.formId),
    label: d.data.title ?? d.formId,
    description: `使用「${d.data.title ?? d.formId}」表單`,
    base: false,
  }));
  const labels: ScopeDef[] = (tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => ({
    id: kbScopeId(l.id),
    label: l.label,
    description: `檢索「${l.label}」分類的知識庫內容`,
    base: false,
  }));
  const mcp: ScopeDef[] = mcpStore
    .list()
    .filter((s) => mcpStore.belongsTo(s, tenantId))
    .map((s) => ({
      id: mcpServerScopeId(s.id),
      label: s.name,
      description: s.description || `使用外部服務「${s.name}」`,
      base: false,
    }));
  return [...GRANTABLE_SCOPES, ...forms, ...labels, ...mcp];
}
