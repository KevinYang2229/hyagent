import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { invokeBodySchema, invokeParamSchema, toolInvokeController } from './tool-invoke.controller';

export const toolInvokeRouter = Router();

toolInvokeRouter.post(
  '/:toolId/invoke',
  validate({ params: invokeParamSchema, body: invokeBodySchema }),
  asyncHandler(toolInvokeController.invoke),
);
