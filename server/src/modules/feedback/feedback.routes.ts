import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { feedbackController } from './feedback.controller';
import { putFeedbackSchema, replyParamSchema } from './feedback.schema';

const router = Router({ mergeParams: true });

// AI 回覆評價：不呼叫 LLM、不計入用量，所以獨立掛載在 /api/conversations/:id/replies 下、不套月配額（見 app.ts）
router.put(
  '/:replyId/feedback',
  validate({ params: replyParamSchema, body: putFeedbackSchema }),
  asyncHandler(feedbackController.put),
);
router.delete(
  '/:replyId/feedback',
  validate({ params: replyParamSchema }),
  asyncHandler(feedbackController.remove),
);

export const feedbackRouter = router;
