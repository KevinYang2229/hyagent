/**
 * 權限解析：某 principal 的有效權限 = 去重(BASE ∪ 租戶 grantedScopes ∪ 群組(該租戶) ∪ 帳號(該租戶))。
 * BASE 讓現有工具（oa:read/oa:write）對全員永遠可用；其餘須由租戶/部門/帳號政策明確授權。
 * department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant, isGuestPrincipal, memberPermissionDepartment, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { BASE_SCOPE_IDS, isKbScope, isMcpScope } from './scope-catalog';
import { scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

/**
 * 給所有人（含訪客）的 scopes：租戶層 grantedScopes ∪ 套用給所有人的角色。
 * kb:／mcp: 只能走部門/帳號層，這裡防禦性濾掉（寫入端已擋，防舊資料）。
 */
function tenantGrantedScopes(tenantId: string): string[] {
  return [
    ...(tenantStore.getTenant(tenantId)?.grantedScopes ?? []),
    ...scopePolicy.tenantBundleScopes(tenantId),
  ].filter((s) => !isMcpScope(s) && !isKbScope(s));
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const { tenantId, userId } = principal;
  // 訪客（公開 widget、免登入訪客 Session）只走訪客那一份：不取得「所有登入員工」與「未指定部門」的角色
  if (isGuestPrincipal(userId)) return resolveGuestScopes(tenantId);
  const tenantScopes = tenantGrantedScopes(tenantId);
  // 沒有部門的登入帳號用獨立的「未指定部門」桶，不與網站訪客（'—'）共用
  const department = memberPermissionDepartment(getApplicant(userId, tenantId).department);
  const groupScopes = scopePolicy.groupScopes(tenantId, department);
  const accountScopes = scopePolicy.accountScopes(tenantId, userId);
  // 套餐（bundle）展開：部門/帳號被指派的具名 scope 集合，與零散 scope 聯集
  const groupBundleScopes = scopePolicy.groupBundleScopes(tenantId, department);
  const accountBundleScopes = scopePolicy.accountBundleScopes(tenantId, userId);
  // 所有登入員工的角色（通用服務群組）：只給有 userId 的登入者，訪客走 resolveGuestScopes 拿不到
  const memberBundleScopes = scopePolicy.memberBundleScopes(tenantId);
  return [
    ...new Set([
      ...BASE_SCOPE_IDS,
      ...tenantScopes,
      ...groupScopes,
      ...accountScopes,
      ...groupBundleScopes,
      ...accountBundleScopes,
      ...memberBundleScopes,
    ]),
  ];
}

/** Guest lookup never fabricates a user ID that could collide with an account. */
export function resolveGuestScopes(tenantId: string): string[] {
  return [...new Set([
    ...BASE_SCOPE_IDS,
    ...tenantGrantedScopes(tenantId),
    ...scopePolicy.groupScopes(tenantId, UNKNOWN_DEPARTMENT),
    ...scopePolicy.groupBundleScopes(tenantId, UNKNOWN_DEPARTMENT),
  ])];
}

/**
 * 某人目前擁有的角色 ids，與 resolveScopes 同一套規則（給前台「我的助理能力」顯示角色名稱用）：
 * 訪客＝所有人＋網站訪客桶；登入成員＝所有人＋所有登入員工＋所屬部門（沒有部門時為「未指定部門」）＋直接指派。
 */
export function resolveRoleIds(principal: ScopePrincipal): string[] {
  const { tenantId, userId } = principal;
  const policy = scopePolicy.getPolicy(tenantId);
  const own = (map: Record<string, string[]> | undefined, key: string): string[] =>
    map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : [];
  const everyone = policy.tenantBundles ?? [];
  if (isGuestPrincipal(userId)) return [...new Set([...everyone, ...own(policy.groupBundles, UNKNOWN_DEPARTMENT)])];
  const department = memberPermissionDepartment(getApplicant(userId, tenantId).department);
  return [...new Set([
    ...everyone,
    ...(policy.memberBundles ?? []),
    ...own(policy.groupBundles, department),
    ...own(policy.accountBundles, userId),
  ])];
}
