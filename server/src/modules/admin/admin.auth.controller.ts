/**
 * 後台登入：
 *  - 沒帶 username 或 username 為 admin：以 ADMIN_PASSWORD 換發 super 的 admin JWT。
 *  - 其他 username：租戶管理者帳號，換發 audience 不同的 tenant-admin JWT。
 * 安全預設：ADMIN_PASSWORD 未設時 super 登入停用（回 403），避免空密碼即可登入。
 *
 * 另含 GET /me、PUT /me/password（掛在 requireAdmin 之後）。
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AdminMe } from '@hyagent/shared';
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';
import { signAdminToken, signTenantAdminToken } from '@/utils/jwt';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import type { AdminAccount } from '@/modules/admin-account/admin-account.types';
import { DUMMY_HASH, hashPassword, verifyPassword } from '@/modules/admin-account/password';
import type { AdminPrincipal } from '@/middlewares/require-admin';
import type { AdminLoginInput, ChangeMyPasswordInput } from './admin.schema';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function toMe(a: AdminAccount): AdminMe {
  return {
    kind: 'tenant-admin',
    accountId: a.id,
    username: a.username,
    displayName: a.displayName,
    tenantId: a.tenantId,
    permissions: a.permissions,
  };
}

const BAD_CREDENTIALS = '帳號或密碼錯誤';

export const adminAuthController = {
  async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body as AdminLoginInput;

    if (username === undefined || username.toLowerCase() === 'admin') {
      if (!env.ADMIN_PASSWORD) {
        throw AppError.forbidden('後台登入未啟用（未設定 ADMIN_PASSWORD）');
      }
      if (!safeEqual(password, env.ADMIN_PASSWORD)) {
        throw AppError.unauthorized('密碼錯誤');
      }
      const me: AdminMe = { kind: 'super' };
      res.status(200).json({ data: { token: signAdminToken(), me } });
      return;
    }

    const account = adminAccountStore.getByUsername(username);
    // 帳號不存在也跑一次 bcrypt，避免以回應時間探測帳號是否存在
    const ok = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
    if (!account || account.status !== 'active' || !ok) {
      throw AppError.unauthorized(BAD_CREDENTIALS);
    }
    const updated = adminAccountStore.update(account.id, { lastLoginAt: new Date().toISOString() }) ?? account;
    const token = signTenantAdminToken({
      accountId: updated.id,
      tenantId: updated.tenantId,
      credentialVersion: updated.credentialVersion,
    });
    res.status(200).json({ data: { token, me: toMe(updated) } });
  },

  async me(_req: Request, res: Response): Promise<void> {
    const principal = res.locals.adminPrincipal as AdminPrincipal | undefined;
    if (!principal) throw AppError.unauthorized('需要有效的管理金鑰或登入');
    const me: AdminMe = principal.kind === 'tenant-admin' ? toMe(principal.account) : { kind: 'super' };
    res.status(200).json({ data: me });
  },

  async changeMyPassword(req: Request, res: Response): Promise<void> {
    const principal = res.locals.adminPrincipal as AdminPrincipal | undefined;
    if (!principal) throw AppError.unauthorized('需要有效的管理金鑰或登入');
    if (principal.kind !== 'tenant-admin') {
      throw AppError.badRequest('超級管理者密碼由伺服器設定 ADMIN_PASSWORD 管理');
    }
    const { currentPassword, newPassword } = req.body as ChangeMyPasswordInput;
    if (!(await verifyPassword(currentPassword, principal.account.passwordHash))) {
      throw AppError.unauthorized('目前密碼錯誤');
    }
    const updated = adminAccountStore.update(principal.account.id, {
      passwordHash: await hashPassword(newPassword),
      bumpCredential: true,
    });
    if (!updated) throw AppError.unauthorized('帳號已不存在');
    const token = signTenantAdminToken({
      accountId: updated.id,
      tenantId: updated.tenantId,
      credentialVersion: updated.credentialVersion,
    });
    res.status(200).json({ data: { token } });
  },
};
