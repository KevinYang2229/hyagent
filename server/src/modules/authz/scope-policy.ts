/**
 * 權限政策：全員基礎權限 + 群組（部門）/ 帳號授權表。
 *
 * BASE_SCOPES 涵蓋現有工具所需（oa:read 查額度、oa:write 送單），讓權限收緊後現有流程不壞。
 * 群組/帳號政策本階段為 in-memory（預設空，僅 BASE 生效），供 seed / 測試 / 未來 admin 寫入；
 * 磁碟持久化延後（沿用其他 store 之後接 Prisma 的模式）。
 */

/** 全員基礎權限：新能力（email:write 等）不在此，須另行授權。 */
export const BASE_SCOPES = ['oa:read', 'oa:write'];

const groupPolicy = new Map<string, string[]>();
const accountPolicy = new Map<string, string[]>();

export const scopePolicy = {
  /** 部門 → 額外授權 */
  groupScopes(department?: string): string[] {
    return department ? (groupPolicy.get(department) ?? []) : [];
  },
  /** 帳號 → 例外授權 */
  accountScopes(userId: string): string[] {
    return accountPolicy.get(userId) ?? [];
  },
  setGroupScopes(department: string, scopes: string[]): void {
    groupPolicy.set(department, scopes);
  },
  setAccountScopes(userId: string, scopes: string[]): void {
    accountPolicy.set(userId, scopes);
  },
  /** 清空群組/帳號政策（測試用；不影響 BASE_SCOPES 常數）。 */
  clear(): void {
    groupPolicy.clear();
    accountPolicy.clear();
  },
};
