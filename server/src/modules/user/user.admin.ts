import { Router, type Request } from 'express';
import { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';

const profile = z.object({
  id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(200),
  department: z.string().trim().min(1).max(200).default('—'), title: z.string().max(200).optional(),
  region: z.string().max(200).optional(), email: z.string().email().optional(),
  deputyIds: z.array(z.string().min(1).max(200)).max(100).optional(),
}).strict();
const body = z.object({ users: z.array(profile).max(10000) }).strict().superRefine(({ users }, ctx) => {
  const ids = new Set(users.map((p) => p.id));
  if (ids.size !== users.length) ctx.addIssue({ code: 'custom', message: '使用者識別碼不可重複' });
  if (users.some((p) => p.deputyIds?.some((id) => !ids.has(id)))) ctx.addIssue({ code: 'custom', message: '代理人必須存在於同一租戶目錄' });
});
export const userAdminRouter = Router({ mergeParams: true });
userAdminRouter.use((req, _res, next) => {
  if (!tenantStore.getTenant(String(req.params.id))) throw AppError.notFound('租戶不存在');
  next();
});
userAdminRouter.get('/', (req: Request, res) => {
  res.json({ data: { users: tenantStore.getTenant(String(req.params.id))!.userDirectory ?? [] } });
});
userAdminRouter.put('/', validate({ body }), asyncHandler(async (req, res) => {
  const { users } = req.body as z.infer<typeof body>;
  tenantStore.updateTenant(String(req.params.id), { userDirectory: users });
  await tenantStore.persistCritical();
  res.json({ data: { users } });
}));
