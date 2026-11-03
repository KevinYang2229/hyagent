import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';
import { toErrorResponse } from '@/lib/assertion';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { AdminActor } from '@/modules/audit/admin-audit';
import type { KeyOperator } from '@/modules/tenant/tenant.types';
import { addPublicKeySchema, revokePublicKeySchema, tenantKeyParamSchema } from '@/modules/admin/admin.schema';

/** 目錄同步設定與專用金鑰（掛在 /api/admin/tenants/:id/directory-sync，管理員驗證由上層 router 負責）。 */
export const directorySyncAdminRouter = Router({ mergeParams: true });

const idParam = z.object({ id: z.string().trim().min(1) });
const patchBody = z
  .object({ ssoAutoProvision: z.boolean().optional(), directorySyncEnabled: z.boolean().optional() })
  .strict();

directorySyncAdminRouter.use((req, _res, next) => {
  if (!tenantStore.getTenant(String(req.params.id))) throw AppError.notFound('租戶不存在');
  next();
});

function view(tenantId: string) {
  const t = tenantStore.getTenant(tenantId)!;
  return {
    ssoAutoProvision: t.ssoAutoProvision ?? false,
    directorySyncEnabled: t.directorySyncEnabled ?? false,
    keys: tenantStore.listDirectorySyncKeys(tenantId),
    status: t.directorySyncStatus ?? null,
  };
}

function operator(req: Request, res: Response): KeyOperator {
  return {
    via: (res.locals.adminActor as AdminActor | undefined) ?? 'admin',
    ...(req.ip ? { ip: req.ip } : {}),
  };
}

/** 金鑰規則違反（HyAgentTokenError）轉成與登入金鑰相同的錯誤回應；其餘照常往外丟。 */
async function withKeyErrors(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) throw err;
    res.status(status).json(body);
  }
}

directorySyncAdminRouter.get('/', (req: Request, res) => {
  res.json({ data: view(String(req.params.id)) });
});

directorySyncAdminRouter.patch(
  '/',
  validate({ params: idParam, body: patchBody }),
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.id);
    tenantStore.updateTenant(tenantId, req.body as z.infer<typeof patchBody>);
    await tenantStore.persistCritical();
    res.json({ data: view(tenantId) });
  }),
);

directorySyncAdminRouter.post(
  '/keys',
  validate({ params: idParam, body: addPublicKeySchema }),
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.id);
    await withKeyErrors(res, async () => {
      const result = tenantStore.addDirectorySyncKey(tenantId, req.body, operator(req, res))!;
      await tenantStore.persistCritical();
      res.status(result.created ? 201 : 200).json({ data: result });
    });
  }),
);

directorySyncAdminRouter.post(
  '/keys/:kid/revoke',
  validate({ params: tenantKeyParamSchema, body: revokePublicKeySchema }),
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.id);
    const kid = String(req.params.kid);
    const { reason } = req.body as z.infer<typeof revokePublicKeySchema>;
    if (!tenantStore.listDirectorySyncKeys(tenantId).some((k) => k.kid === kid)) {
      throw AppError.notFound('查無此 kid');
    }
    await withKeyErrors(res, async () => {
      const op = operator(req, res);
      const key = tenantStore.revokeDirectorySyncKey(tenantId, kid, reason, op)!;
      await tenantStore.persistCritical();
      logger.info({ tenantId, kid, reason, operator: op }, 'directory sync key revoked');
      res.json({ data: { key } });
    });
  }),
);
