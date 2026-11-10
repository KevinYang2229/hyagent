/** 租戶管理者帳號型別。 */
import type { AdminTabPermissions } from '@hyagent/shared';

export interface AdminAccount {
  id: string;
  tenantId: string;
  /** 全平台唯一，一律小寫儲存 */
  username: string;
  displayName: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  permissions: AdminTabPermissions;
  /** 停用、重設密碼、改密碼時加 1，讓舊 token 失效 */
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/** 對外（API 回傳、稽核）一律用這個型別，不含密碼雜湊與憑證版本 */
export type PublicAdminAccount = Omit<AdminAccount, 'passwordHash' | 'credentialVersion'>;

export function toPublicAccount(a: AdminAccount): PublicAdminAccount {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, credentialVersion, ...rest } = a;
  return rest;
}
