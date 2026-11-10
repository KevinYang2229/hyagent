/**
 * 後台租戶管理者的分頁權限型別（前後端共用）。
 *
 * 「總覽」一律可見；「資料庫查詢」只有超級管理者能用，兩者都不列入權限設定。
 */
export const ADMIN_TAB_KEYS = [
  'settings',
  'ai',
  'sso',
  'users',
  'directorySync',
  'knowledge',
  'forms',
  'permissions',
  'appearance',
  'webhook',
  'usage',
  'feedback',
  'reports',
  'audit',
] as const;

export type AdminTabKey = (typeof ADMIN_TAB_KEYS)[number];

export type AdminTabLevel = 'hidden' | 'read' | 'write';

/** 沒設定的分頁視為 hidden。 */
export type AdminTabPermissions = Partial<Record<AdminTabKey, AdminTabLevel>>;

export function tabLevel(p: AdminTabPermissions, tab: AdminTabKey): AdminTabLevel {
  return p[tab] ?? 'hidden';
}

/** `GET /admin/me` 的回應：目前登入者是超級管理者或某租戶的管理者。 */
export type AdminMe =
  | { kind: 'super' }
  | {
      kind: 'tenant-admin';
      accountId: string;
      username: string;
      displayName: string;
      tenantId: string;
      permissions: AdminTabPermissions;
    };
