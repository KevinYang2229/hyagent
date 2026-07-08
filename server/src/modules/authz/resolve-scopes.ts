/**
 * 權限解析：某 principal 的有效權限 = 去重(基礎 ∪ 租戶 ∪ 群組 ∪ 帳號)。
 *
 * BASE_SCOPES 讓現有工具（oa:read/oa:write）對全員永遠可用，權限收緊不影響既有流程；
 * 新能力（email:write / calendar:* / erp:* 等）不在 BASE，須由租戶 grantedScopes、
 * 群組（部門）或帳號政策明確授權。department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { BASE_SCOPES, scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const tenantScopes = tenantStore.getTenant(principal.tenantId)?.grantedScopes ?? [];
  const department = getApplicant(principal.userId).department;
  const groupScopes = scopePolicy.groupScopes(department);
  const accountScopes = scopePolicy.accountScopes(principal.userId);
  return [...new Set([...BASE_SCOPES, ...tenantScopes, ...groupScopes, ...accountScopes])];
}
