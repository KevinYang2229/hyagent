import type { DisplayBlock, PendingActionView, ReplyFeedbackInput } from '@hyagent/shared';

export type ChatMessage =
  | { id: string; role: 'user'; text: string; at: number }
  | { id: string; role: 'agent'; text: string; blocks?: DisplayBlock[]; suggestions?: string[]; replyId?: string; conversationId?: string; feedback?: ReplyFeedbackInput; at: number }
  | { id: string; role: 'system'; text: string; tone: 'info' | 'error'; hideActions?: boolean; at: number };

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  pending: PendingActionView | null;
  sending: boolean;
}

let seq = 0;
export function nextId(): string {
  seq += 1;
  return `m${Date.now().toString(36)}${seq.toString(36)}`;
}
