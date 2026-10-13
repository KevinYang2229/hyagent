/** 對話狀態轉換（純函式）：訊息串、對話 id、目前待確認的寫入動作。 */
import type { PendingActionView, ReplyFeedbackInput } from '@hyagent/shared';
import type { TurnData } from '@hyagent/app-core/api/types';
import { nextId, type ChatMessage, type ChatState } from './types';

export type ChatAction =
  | { type: 'reset' }
  | { type: 'sendCancelled' }
  | { type: 'userSent'; text: string }
  | { type: 'turnReceived'; conversationId?: string; turn: TurnData }
  | { type: 'conversationStarted'; conversationId: string }
  | { type: 'sendFailed'; message: string }
  | { type: 'conversationLost' }
  | { type: 'actionProposed'; conversationId: string; action: PendingActionView }
  | { type: 'actionFinished'; text: string }
  | { type: 'actionGone'; message: string }
  | { type: 'feedbackSet'; messageId: string; feedback?: ReplyFeedbackInput };

export const initialChatState: ChatState = { conversationId: null, messages: [], pending: null, sending: false };

function system(text: string, tone: 'info' | 'error'): Extract<ChatMessage, { role: 'system' }> {
  return { id: nextId(), role: 'system', text, tone, at: Date.now() };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'userSent':
      return { ...state, sending: true, messages: [...state.messages, { id: nextId(), role: 'user', text: action.text, at: Date.now() }] };
    case 'turnReceived': {
      const t = action.turn;
      const convId = action.conversationId ?? state.conversationId ?? undefined;
      const messages: ChatMessage[] = t.reply
        ? [...state.messages, {
            id: nextId(), role: 'agent', text: t.reply, blocks: t.blocks, suggestions: t.suggestions,
            // 評價要送到這則回覆所屬的對話：對話重開後 state.conversationId 會變
            ...(t.replyId && convId ? { replyId: t.replyId, conversationId: convId } : {}),
            at: Date.now(),
          }]
        : state.messages;
      // 後端在新回合會作廢上一輪未確認的動作：沒帶就清掉
      return { ...state, sending: false, conversationId: action.conversationId ?? state.conversationId, messages, pending: t.pendingAction ?? null };
    }
    case 'conversationStarted':
      // 只記對話 id，不動 sending（可能有另一個送出正在進行）
      return { ...state, conversationId: action.conversationId };
    case 'sendCancelled':
      return { ...state, sending: false, conversationId: null, pending: null, messages: [...state.messages, { ...system('已取消回覆。', 'info'), hideActions: true }] };
    case 'sendFailed':
      return { ...state, sending: false, messages: [...state.messages, system(action.message, 'error')] };
    case 'conversationLost':
      return { ...state, conversationId: null, pending: null };
    case 'actionProposed':
      return { ...state, conversationId: action.conversationId, pending: action.action };
    case 'actionFinished':
      return {
        ...state,
        pending: null,
        messages: action.text ? [...state.messages, { id: nextId(), role: 'agent', text: action.text, at: Date.now() }] : state.messages,
      };
    case 'actionGone':
      return { ...state, pending: null, messages: [...state.messages, system(action.message, 'info')] };
    case 'feedbackSet':
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId || m.role !== 'agent') return m;
          const { feedback: _old, ...rest } = m;
          return action.feedback ? { ...rest, feedback: action.feedback } : rest;
        }),
      };
    default:
      return state;
  }
}
