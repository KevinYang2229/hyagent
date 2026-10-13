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
    status: z.enum(['open', 'resolved']),
    resolutionNote: z.string().trim().max(200).optional(),
  })
  .strict();
