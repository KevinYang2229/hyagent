import type { FeedbackRating, FeedbackReason } from '@hyagent/shared';
import type { ReplyTrace } from '@/modules/conversation/conversation.types';

export type { FeedbackRating, FeedbackReason };

/** 執行期清單（zod 與統計用）；必須與 shared 的 FeedbackReason 一致 */
export const FEEDBACK_REASONS = ['wrong', 'not_answered', 'outdated', 'inappropriate', 'other'] as const satisfies readonly FeedbackReason[];

export type FeedbackStatus = 'open' | 'resolved';

/** 一筆評價＋評價當下的回覆快照。快照與 session 分開保存：對話被清掉後評價仍在 */
export interface ReplyFeedback {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  replyId: string;
  serviceId: string;
  question: string;
  answer: string;
  trace?: ReplyTrace;
  rating: FeedbackRating;
  reason?: FeedbackReason;
  comment?: string;
  status: FeedbackStatus;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackFilter {
  rating?: FeedbackRating;
  serviceId?: string;
  reason?: FeedbackReason;
  status?: FeedbackStatus;
}

export interface FeedbackStats {
  days: number;
  total: number;
  up: number;
  down: number;
  /** 待處理的倒讚 */
  openDown: number;
  byService: Record<string, { up: number; down: number }>;
  byReason: Record<FeedbackReason, number>;
}
