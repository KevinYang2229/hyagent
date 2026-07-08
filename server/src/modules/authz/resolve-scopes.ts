/**
 * 權限解析（RBAC seam）。
 *
 * Phase 0：一律回萬用字元 ['*'] ＝全通過，行為與現況（登入即可用）相同。
 * Phase 2 收緊時改為 union(租戶 grantedScopes, 群組 groupPolicy[department], 帳號 accountPolicy[userId])，
 * 上層（toolRegistry.invoke 的檢查點）無需改動。
 */
export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(_principal: ScopePrincipal): string[] {
  return ['*'];
}
