/**
 * 使用者評價 AI 回覆。只收 replyId：問答由伺服器從 session 的回覆紀錄取出做快照，
 * 前台送不進任意文字。對話歸屬沿用 conversationStore.get（跨租戶 404、他人 403）。
 */
import type { Request, Response } from 'express';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { findReply } from '@/modules/conversation/reply-record';
import { AppError } from '@/utils/app-error';
import type { PutFeedbackInput } from './feedback.schema';
import { feedbackStore } from './feedback.store';

function principal(req: Request): { tenantId: string; userId: string } {
  return { tenantId: req.tenant?.id ?? 'default', userId: req.user?.sub ?? '' };
}

export const feedbackController = {
  async put(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = principal(req);
    const session = conversationStore.get(String(req.params.id), tenantId, userId);
    const reply = findReply(session, String(req.params.replyId));
    if (!reply) throw AppError.notFound('這則回覆已無法評價');
    const { rating, reason, comment } = req.body as PutFeedbackInput;
    const saved = feedbackStore.upsert({
      tenantId,
      userId,
      sessionId: session.id,
      reply,
      rating,
      ...(reason ? { reason } : {}),
      ...(comment ? { comment } : {}),
    });
    res.status(200).json({
      data: {
        rating: saved.rating,
        ...(saved.reason ? { reason: saved.reason } : {}),
        ...(saved.comment ? { comment: saved.comment } : {}),
      },
    });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = principal(req);
    const session = conversationStore.get(String(req.params.id), tenantId, userId);
    feedbackStore.remove(tenantId, session.id, String(req.params.replyId), userId);
    res.status(204).end();
  },
};
