import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { reportController } from './report.controller';
import { downloadQuerySchema, reportIdParamSchema } from './report.schema';

const router = Router();

router.get(
  '/:id',
  validate({ params: reportIdParamSchema }),
  asyncHandler(reportController.get),
);

router.get(
  '/:id/download',
  validate({ params: reportIdParamSchema, query: downloadQuerySchema }),
  asyncHandler(reportController.download),
);

export const reportRouter = router;
