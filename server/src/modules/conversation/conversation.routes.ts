import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { singleFileUpload } from '@/middlewares/upload';
import { asyncHandler } from '@/utils/async-handler';
import { feedbackController } from '@/modules/feedback/feedback.controller';
import { putFeedbackSchema, replyParamSchema } from '@/modules/feedback/feedback.schema';
import { conversationController } from './conversation.controller';
import {
  attachmentParamSchema,
  actionParamSchema,
  confirmBodySchema,
  idParamSchema,
  messageSchema,
  proposeBodySchema,
  startSchema,
  updateFieldsSchema,
} from './conversation.schema';

const router = Router();

// userId 取自 requireAuth 注入的 req.user.sub（見 app.ts 掛載順序）；
// controller 內的 x-user-id fallback 僅供未掛 requireAuth 的測試路徑使用。
router.post('/', validate({ body: startSchema }), asyncHandler(conversationController.start));

router.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(conversationController.get),
);

router.post(
  '/:id/messages',
  validate({ params: idParamSchema, body: messageSchema }),
  asyncHandler(conversationController.sendMessage),
);

router.patch(
  '/:id/fields',
  validate({ params: idParamSchema, body: updateFieldsSchema }),
  asyncHandler(conversationController.updateFields),
);

// 確認送出（不經 LLM）：確認畫面按「送出」用
router.post(
  '/:id/submit',
  validate({ params: idParamSchema }),
  asyncHandler(conversationController.submit),
);

router.post(
  '/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(conversationController.cancel),
);

// 寫入動作確認卡片（不經 LLM）：確認才由後端執行；取消即作廢
// 不經 AI 直接提議寫入動作（app「建立補貨單」等按鈕用）；仍需確認才執行
router.post(
  '/:id/actions/propose',
  validate({ params: idParamSchema, body: proposeBodySchema }),
  asyncHandler(conversationController.proposeAction),
);

router.post(
  '/:id/actions/:actionId/confirm',
  validate({ params: actionParamSchema, body: confirmBodySchema }),
  asyncHandler(conversationController.confirmAction),
);

router.post(
  '/:id/actions/:actionId/cancel',
  validate({ params: actionParamSchema }),
  asyncHandler(conversationController.cancelAction),
);

// 附件：上傳（multipart，欄位名 file）／刪除
router.post(
  '/:id/attachments',
  validate({ params: idParamSchema }),
  singleFileUpload('file'),
  asyncHandler(conversationController.uploadAttachment),
);

router.delete(
  '/:id/attachments/:attachmentId',
  validate({ params: attachmentParamSchema }),
  asyncHandler(conversationController.deleteAttachment),
);

// AI 回覆評價：不呼叫 LLM、不計入用量；但掛在 /api/conversations 下，租戶超過月配額時與對話一樣回 429
router.put(
  '/:id/replies/:replyId/feedback',
  validate({ params: replyParamSchema, body: putFeedbackSchema }),
  asyncHandler(feedbackController.put),
);
router.delete(
  '/:id/replies/:replyId/feedback',
  validate({ params: replyParamSchema }),
  asyncHandler(feedbackController.remove),
);

export const conversationRouter = router;
