/**
 * 部門顯示名稱格式化。
 *
 * 兩個系統保留的權限對象，值必須與 server 端 `user/user.directory.ts` 同步
 * （本 repo 前後端共用常數的既有作法：兩處各自持有字面值）：
 * - '—'（UNKNOWN_DEPARTMENT）：網站訪客——公開 widget 與免登入訪客 Session。
 * - '__unassigned__'（UNASSIGNED_DEPARTMENT）：已登入但沒有部門的帳號。目錄裡這類帳號的部門
 *   仍存成 '—'，只在權限上對應到此桶，不再與網站訪客共用。
 */
export const UNKNOWN_DEPARTMENT = '—';
export const UNASSIGNED_DEPARTMENT = '__unassigned__';

/** 部門顯示名稱：系統桶顯示為易懂的中文，其餘部門原樣顯示 */
export function formatDepartment(dep: string): string {
  if (dep === UNKNOWN_DEPARTMENT) return '網站訪客（未登入）';
  if (dep === UNASSIGNED_DEPARTMENT) return '未指定部門（已登入）';
  return dep;
}
