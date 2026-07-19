/**
 * 權限解析：某 principal 的有效權限 = 去重(BASE ∪ 租戶 grantedScopes ∪ 群組(該租戶) ∪ 帳號(該租戶))。
 * BASE 讓現有工具（oa:read/oa:write）對全員永遠可用；其餘須由租戶/部門/帳號政策明確授權。
 * department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { BASE_SCOPE_IDS } from './scope-catalog';
import { scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const { tenantId, userId } = principal;
  const tenantScopes = tenantStore.getTenant(tenantId)?.grantedScopes ?? [];
  const department = getApplicant(userId).department;
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
