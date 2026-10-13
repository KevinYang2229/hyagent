import { z } from 'zod';
import { idParamSchema } from '@/modules/conversation/conversation.schema';
import { FEEDBACK_REASONS } from './feedback.types';

export const replyParamSchema = idParamSchema.extend({ replyId: z.string().uuid() });

export const putFeedbackSchema = z
  .object({
    rating: z.enum(['up', 'down']),
    reason: z.enum(FEEDBACK_REASONS).optional(),
    comment: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.rating === 'down' || (b.reason === undefined && b.comment === undefined), {
    message: '只有倒讚可以附原因與說明',
    path: ['rating'],
  });

export type PutFeedbackInput = z.infer<typeof putFeedbackSchema>;
