/**
 * 權限解析：某 principal 的有效權限 = 去重(BASE ∪ 租戶 grantedScopes ∪ 群組(該租戶) ∪ 帳號(該租戶))。
 * BASE 讓現有工具（oa:read/oa:write）對全員永遠可用；其餘須由租戶/部門/帳號政策明確授權。
 * department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { BASE_SCOPE_IDS, isMcpScope } from './scope-catalog';
import { scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

/** 租戶層 grantedScopes 會併給所有人含訪客：mcp: 只能走部門/帳號層，這裡防禦性濾掉（寫入端已擋，防舊資料）。 */
function tenantGrantedScopes(tenantId: string): string[] {
  return (tenantStore.getTenant(tenantId)?.grantedScopes ?? []).filter((s) => !isMcpScope(s));
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const { tenantId, userId } = principal;
  if (!userId) return resolveGuestScopes(tenantId);
  const tenantScopes = tenantGrantedScopes(tenantId);
  const department = getApplicant(userId, tenantId).department;
  const groupScopes = scopePolicy.groupScopes(tenantId, department);
  const accountScopes = scopePolicy.accountScopes(tenantId, userId);
  // 套餐（bundle）展開：部門/帳號被指派的具名 scope 集合，與零散 scope 聯集
  const groupBundleScopes = scopePolicy.groupBundleScopes(tenantId, department);
  const accountBundleScopes = scopePolicy.accountBundleScopes(tenantId, userId);
  return [
    ...new Set([
      ...BASE_SCOPE_IDS,
      ...tenantScopes,
      ...groupScopes,
      ...accountScopes,
      ...groupBundleScopes,
      ...accountBundleScopes,
    ]),
  ];
}

/** Guest lookup never fabricates a user ID that could collide with an account. */
export function resolveGuestScopes(tenantId: string): string[] {
  return [...new Set([
    ...BASE_SCOPE_IDS,
    ...tenantGrantedScopes(tenantId),
    ...scopePolicy.groupScopes(tenantId, '—'),
    ...scopePolicy.groupBundleScopes(tenantId, '—'),
  ])];
}
