/**
 * 租戶管理者檢視單一租戶（GET / PATCH /tenants/:id 的回應）時，只帶出看得到的分頁所需的欄位。
 *
 * - 每個欄位都要在 TENANT_VIEW_FIELDS 明確歸類：'always' 一律帶出；分頁陣列表示其中任一分頁 ≥ read 才帶出。
 * - 表的型別是 Record<keyof 檢視, …>：Tenant 新增欄位而沒在這裡歸類，tsc 會失敗；
 *   執行期沒列在表上的欄位（例如儲存資料裡殘留的舊欄位）一律不帶出。
 * - 超級管理者與 x-admin-key 不經過這層，回應不變。
 */
import type { AdminTabPermissions } from '@hyagent/shared';
import { tabLevel, type AdminTabKey } from '@/modules/admin-account/admin-route-policy';
import type { Tenant } from '@/modules/tenant/tenant.types';
import type { resolveAssertionSettings } from '@/modules/tenant/tenant-keys';

/** publicTenant 回傳的完整檢視：拿掉內部欄位、補上計算欄位 */
export type TenantView = Omit<Tenant, 'userDirectory' | 'llmConfig' | 'directoryTombstones' | 'directorySyncKeys'> & {
  assertionSettings: ReturnType<typeof resolveAssertionSettings>;
  activeKeyCount: number;
};

type FieldGroup = 'always' | readonly AdminTabKey[];

export const TENANT_VIEW_FIELDS: Record<keyof TenantView, FieldGroup> = {
  id: 'always',
  name: 'always',
  createdAt: 'always',
  // 總覽一律可見，它用 activeKeyCount 判斷能否登入
  activeKeyCount: 'always',
  // 基本設定
  allowedOrigins: ['settings'],
  guestAccess: ['settings'],
  egressPolicy: ['settings'],
  // 配額：用量頁顯示，基本設定頁也唯讀顯示
  quotaMonthlyLlmTokens: ['usage', 'settings'],
  // 自動登入（SSO）
  publicKeys: ['sso'],
  assertionSettings: ['sso'],
  clockSkewSeconds: ['sso'],
  assertionLifetimeSeconds: ['sso'],
  sessionExpiresIn: ['sso'],
  // 人員同步；與 /directory-sync 路由一致，使用者目錄可讀者也看得到
  ssoAutoProvision: ['directorySync', 'users'],
  directorySyncEnabled: ['directorySync', 'users'],
  directorySyncStatus: ['directorySync', 'users'],
  // 外觀
  appearance: ['appearance'],
  // 知識庫
  knowledgeLabels: ['knowledge'],
  knowledgeAccessLogRetentionDays: ['knowledge'],
  // 角色與授權（政策相關）
  grantedScopes: ['permissions'],
  scopesMigrated: ['permissions'],
  unassignedDepartmentMigrated: ['permissions'],
  disabledServices: ['permissions'],
  disabledForms: ['permissions'],
};

export function filterTenantViewForTenantAdmin(
  view: TenantView,
  permissions: AdminTabPermissions,
): Partial<TenantView> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    const group = Object.prototype.hasOwnProperty.call(TENANT_VIEW_FIELDS, key)
      ? TENANT_VIEW_FIELDS[key as keyof TenantView]
      : undefined;
    if (group === undefined) continue; // 沒歸類的欄位一律不帶
    if (group === 'always' || group.some((t) => tabLevel(permissions, t) !== 'hidden')) out[key] = value;
  }
  return out as Partial<TenantView>;
}
