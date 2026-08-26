/**
 * 部門顯示名稱格式化。
 *
 * '—' 是帳號未建檔時的部門桶（含公開 widget 訪客——訪客沒有帳號，
 * resolveScopes 一律把他們歸進這桶）。這個值必須與 server 端
 * `user/user.directory.ts` 的 UNKNOWN_DEPARTMENT 常數同步；兩處各自持有
 * 一份字面值是本 repo 對「前後端共用常數」的既有作法（比照
 * knowledge/scope-catalog 的 KB_SCOPE_PREFIX 在前端的對應寫法）。
 */
export const UNKNOWN_DEPARTMENT = '—';

/** 部門顯示名稱：訪客桶顯示為易懂的中文，其餘部門原樣顯示 */
export function formatDepartment(dep: string): string {
  return dep === UNKNOWN_DEPARTMENT ? '訪客／未建檔帳號' : dep;
}
