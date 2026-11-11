import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/utils/async-handler';
import { validate } from '@/middlewares/validate';
import { AppError } from '@/utils/app-error';
import { listNotifications, markNotificationsRead } from './notifications.service';

const markReadBody = z.object({
  ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100)
    .describe('要標為已讀的通知 id（GET /api/notifications 回傳），一次 1–100 筆'),
}).strict();

export const notificationsRouter = Router();
notificationsRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user || !req.tenant || (req.user.tenantId && req.user.tenantId !== req.tenant.id)) throw AppError.unauthorized('Invalid notification identity');
  next();
});
notificationsRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ data: await listNotifications(req.tenant!.id, req.user!.sub) });
}));
notificationsRouter.post('/read', validate({ body: markReadBody }), asyncHandler(async (req, res) => {
  await markNotificationsRead(req.tenant!.id, req.user!.sub, req.body.ids as string[]);
  res.json({ data: { ok: true } });
}));
