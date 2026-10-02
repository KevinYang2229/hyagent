import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { singleFileUpload } from '@/middlewares/upload';
import { asyncHandler } from '@/utils/async-handler';
import { conversationController } from './conversation.controller';
import {
  attachmentParamSchema,
  actionParamSchema,
  idParamSchema,
  messageSchema,
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
router.post(
  '/:id/actions/:actionId/confirm',
  validate({ params: actionParamSchema }),
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

export const conversationRouter = router;
