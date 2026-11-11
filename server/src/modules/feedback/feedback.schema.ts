import { z } from 'zod';
import { idParamSchema } from '@/modules/conversation/conversation.schema';
import { FEEDBACK_REASONS } from './feedback.types';

export const replyParamSchema = idParamSchema.extend({ replyId: z.string().uuid().describe('AI 回覆 id（UUID），見對話訊息的 replyId') });

export const putFeedbackSchema = z
  .object({
    rating: z.enum(['up', 'down']).describe('up＝讚、down＝倒讚'),
    reason: z.enum(FEEDBACK_REASONS).optional().describe('倒讚原因：wrong 答錯、not_answered 沒回答到、outdated 資訊過時、inappropriate 不恰當、other 其他；僅 rating=down 可帶'),
    comment: z.string().trim().max(500).optional().describe('補充說明，最多 500 字；僅 rating=down 可帶'),
  })
  .strict()
  .refine((b) => b.rating === 'down' || (b.reason === undefined && b.comment === undefined), {
    message: '只有倒讚可以附原因與說明',
    path: ['rating'],
  });

export type PutFeedbackInput = z.infer<typeof putFeedbackSchema>;

export const adminFeedbackListQuerySchema = z.object({
  rating: z.enum(['up', 'down']).optional(),
  serviceId: z.string().trim().min(1).max(32).optional(),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  status: z.enum(['open', 'resolved']).optional(),
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const adminFeedbackStatsQuerySchema = z.object({
  days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30),
});

export const adminFeedbackParamSchema = z.object({ id: z.string().min(1), feedbackId: z.string().uuid() });

export const patchFeedbackSchema = z
  .object({
    status: z.enum(['open', 'resolved']).describe('處理狀態：open 待處理、resolved 已處理'),
    resolutionNote: z.string().trim().max(200).optional().describe('處理說明，最多 200 字'),
  })
  .strict();
