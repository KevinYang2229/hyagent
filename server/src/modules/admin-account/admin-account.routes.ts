/**
 * 租戶管理者帳號管理（超級管理者專用）：掛在 /api/admin/tenants/:id/admin-accounts。
 * 授權由 authorizeAdmin 依規則表把關（租戶管理者一律 403），這裡不再檢查身分。
 * 回應一律用 PublicAdminAccount，不含 passwordHash／credentialVersion。
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { adminAccountStore, toPublicAccount } from './admin-account.store';
import { hashPassword } from './password';
import { createAccountSchema, patchAccountSchema, resetPasswordSchema } from './admin-account.schema';

export const adminAccountRouter = Router({ mergeParams: true });

adminAccountRouter.use((req, _res, next) => {
  if (!tenantStore.getTenant(String(req.params.id))) throw AppError.notFound('租戶不存在');
  next();
});

/** 帳號必須屬於 :id 這個租戶，否則一律當作不存在（不洩漏別的租戶有這個帳號） */
function accountOf(req: Request) {
  const account = adminAccountStore.get(String(req.params.accountId));
  if (!account || account.tenantId !== String(req.params.id)) throw AppError.notFound('找不到此帳號');
  return account;
}

adminAccountRouter.get('/', (req: Request, res) => {
  res.json({ data: adminAccountStore.listByTenant(String(req.params.id)).map(toPublicAccount) });
});

adminAccountRouter.post('/', validate({ body: createAccountSchema }), asyncHandler(async (req, res) => {
  const { username, displayName, password } = req.body as z.infer<typeof createAccountSchema>;
  // 先檢查重複再雜湊，省下無謂的 bcrypt；store.create 仍會再檢查一次
  if (adminAccountStore.getByUsername(username)) throw AppError.conflict('帳號名稱已被使用');
  const passwordHash = await hashPassword(password);
  const account = adminAccountStore.create({ tenantId: String(req.params.id), username, displayName, passwordHash });
  res.status(201).json({ data: toPublicAccount(account) });
}));

adminAccountRouter.patch('/:accountId', validate({ body: patchAccountSchema }), (req, res) => {
  const account = accountOf(req);
  const { displayName, status, permissions } = req.body as z.infer<typeof patchAccountSchema>;
  // 停用要讓舊 token 立即失效（requireAdmin 也會因停用而擋下，這裡一併升版本）
  const bumpCredential = status !== undefined && status !== account.status && status === 'disabled';
  const next = adminAccountStore.update(account.id, { displayName, status, permissions, bumpCredential });
  res.json({ data: toPublicAccount(next!) });
});

adminAccountRouter.put('/:accountId/password', validate({ body: resetPasswordSchema }), asyncHandler(async (req, res) => {
  const account = accountOf(req);
  const passwordHash = await hashPassword((req.body as z.infer<typeof resetPasswordSchema>).password);
  adminAccountStore.update(account.id, { passwordHash, bumpCredential: true });
  res.json({ data: { id: account.id } });
}));

adminAccountRouter.delete('/:accountId', (req, res) => {
  const account = accountOf(req);
  adminAccountStore.remove(account.id);
  res.json({ data: { id: account.id } });
});
