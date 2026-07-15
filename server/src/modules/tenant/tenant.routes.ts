import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { putLlmConfigSchema } from './llm-config.schema';
import { tenantSelfController } from './tenant.self.controller';

const router = Router();

router.get('/llm-config', asyncHandler(tenantSelfController.getLlmConfig));
router.put(
  '/llm-config',
  validate({ body: putLlmConfigSchema }),
  asyncHandler(tenantSelfController.putLlmConfig),
);

export const tenantSelfRouter = router;
