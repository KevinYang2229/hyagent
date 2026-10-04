/** 對話狀態轉換（純函式）：訊息串、對話 id、目前待確認的寫入動作。 */
import type { PendingActionView } from '@hyagent/shared';
import type { TurnData } from '@/api/types';
import { nextId, type ChatMessage, type ChatState } from './types';

export type ChatAction =
  | { type: 'reset' }
  | { type: 'userSent'; text: string }
  | { type: 'turnReceived'; conversationId?: string; turn: TurnData }
  | { type: 'sendFailed'; message: string }
  | { type: 'conversationLost' }
  | { type: 'actionProposed'; conversationId: string; action: PendingActionView }
  | { type: 'actionFinished'; text: string }
  | { type: 'actionGone'; message: string };

export const initialChatState: ChatState = { conversationId: null, messages: [], pending: null, sending: false };

function system(text: string, tone: 'info' | 'error'): ChatMessage {
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
      const messages: ChatMessage[] = t.reply
        ? [...state.messages, { id: nextId(), role: 'agent', text: t.reply, blocks: t.blocks, suggestions: t.suggestions, at: Date.now() }]
        : state.messages;
      // 後端在新回合會作廢上一輪未確認的動作：沒帶就清掉
      return { ...state, sending: false, conversationId: action.conversationId ?? state.conversationId, messages, pending: t.pendingAction ?? null };
    }
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
    default:
      return state;
  }
}
