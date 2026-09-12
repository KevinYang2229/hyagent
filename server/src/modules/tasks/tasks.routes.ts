import { Router } from 'express';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';
import { validate } from '@/middlewares/validate';
import { idParamSchema } from '@/modules/conversation/conversation.schema';
import { conversationController } from '@/modules/conversation/conversation.controller';
import { getTaskSession, listTasks } from './tasks.service';

export const tasksRouter = Router();

tasksRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user || !req.tenant || (req.user.tenantId && req.user.tenantId !== req.tenant.id)) {
    throw AppError.unauthorized('Invalid task identity');
  }
  next();
});

tasksRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ data: await listTasks(req.tenant!.id, req.user!.sub) });
}));

tasksRouter.use('/:id', validate({ params: idParamSchema }), (req, _res, next) => {
  getTaskSession(req.tenant!.id, req.user!.sub, String(req.params.id));
  next();
});
tasksRouter.get('/:id', asyncHandler(conversationController.get));
tasksRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const session = getTaskSession(req.tenant!.id, req.user!.sub, String(req.params.id));
  if (!['collecting', 'confirming', 'failed'].includes(session.status)) {
    throw AppError.conflict('目前任務狀態無法取消');
  }
  await conversationController.cancel(req, res);
}));
