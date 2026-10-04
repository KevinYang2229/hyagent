/**
 * 對話：一個 App 工作階段一個對話；第一句建立對話，之後沿用。
 * 寫入動作的確認／取消也在這裡，成功後讓今日重點與補貨單重新取資料、任務分頁亮紅點。
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { Endpoints } from '@/api/endpoints';
import { ApiError, errorMessage } from '@/api/errors';
import { useApi } from '@/auth/AuthProvider';
import { useTaskBadge } from '@/tasks/TaskBadge';
import { chatReducer, initialChatState } from './chatReducer';
import type { ChatState } from './types';

export type ConfirmOutcome =
  | { kind: 'done'; ok: boolean }
  | { kind: 'invalid'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'gone' };

interface ChatContextValue {
  state: ChatState;
  send(text: string): Promise<boolean>;
  newConversation(): void;
  propose(toolId: string, input: Record<string, unknown>): Promise<void>;
  confirm(input?: Record<string, unknown>): Promise<ConfirmOutcome>;
  cancel(): Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children, api: injected }: { children: ReactNode; api?: Endpoints }) {
  const fromAuth = useApiOptional();
  const api = injected ?? fromAuth!;
  const queryClient = useQueryClient();
  const badge = useTaskBadge();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // 同步旗標：dispatch 要等重新渲染才生效，同一個 tick 內連送兩次靠它擋
  const sendingRef = useRef(false);

  const startWith = useCallback(
    async (text: string) => {
      const d = await api.startConversation(text);
      dispatch({ type: 'turnReceived', conversationId: d.id, turn: d });
    },
    [api],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sendingRef.current) return false;
      sendingRef.current = true;
      dispatch({ type: 'userSent', text });
      try {
        const id = stateRef.current.conversationId;
        if (!id) {
          await startWith(text);
        } else {
          try {
            const d = await api.sendMessage(id, text);
            dispatch({ type: 'turnReceived', turn: d });
          } catch (e) {
            // 對話已不存在（例如伺服器資料重置）：重開一個對話再送
            if (!(e instanceof ApiError && e.status === 404)) throw e;
            dispatch({ type: 'conversationLost' });
            await startWith(text);
          }
        }
        return true;
      } catch (e) {
        dispatch({ type: 'sendFailed', message: errorMessage(e) });
        return false;
      } finally {
        sendingRef.current = false;
      }
    },
    [api, startWith],
  );

  const newConversation = useCallback(() => dispatch({ type: 'reset' }), []);

  const propose = useCallback(
    async (toolId: string, input: Record<string, unknown>) => {
      let id = stateRef.current.conversationId;
      if (!id) {
        const d = await api.startConversation();
        id = d.id;
        dispatch({ type: 'turnReceived', conversationId: id, turn: d });
      }
      const { pendingAction } = await api.proposeAction(id, toolId, input);
      dispatch({ type: 'actionProposed', conversationId: id, action: pendingAction });
    },
    [api],
  );

  const confirm = useCallback(
    async (input?: Record<string, unknown>): Promise<ConfirmOutcome> => {
      const { conversationId: id, pending } = stateRef.current;
      if (!id || !pending) return { kind: 'gone' };
      try {
        const turn = await api.confirmAction(id, pending.id, input);
        const ok = turn.actionOk !== false;
        dispatch({ type: 'actionFinished', text: turn.reply ?? '' });
        if (ok) {
          badge.bump();
          void queryClient.invalidateQueries({ queryKey: ['todaySummary'] });
          void queryClient.invalidateQueries({ queryKey: ['replenishments'] });
        }
        return { kind: 'done', ok };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 422 && e.code === 'ACTION_INPUT_INVALID') return { kind: 'invalid', message: e.message };
          if (e.status === 409) {
            dispatch({ type: 'actionGone', message: e.code === 'ACTION_EXPIRED' ? '這個動作已逾時失效，請重新提出。' : '這個動作已處理過或已不存在。' });
            return { kind: 'gone' };
          }
        }
        return { kind: 'unavailable', message: errorMessage(e) };
      }
    },
    [api, badge, queryClient],
  );

  const cancel = useCallback(async () => {
    const { conversationId: id, pending } = stateRef.current;
    if (!id || !pending) return;
    try {
      const turn = await api.cancelAction(id, pending.id);
      dispatch({ type: 'actionFinished', text: turn.reply ?? '' });
    } catch (e) {
      dispatch({ type: 'actionGone', message: e instanceof ApiError && e.status === 409 ? '這個動作已處理過或已不存在。' : errorMessage(e) });
    }
  }, [api]);

  const value = useMemo(
    () => ({ state, send, newConversation, propose, confirm, cancel }),
    [state, send, newConversation, propose, confirm, cancel],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** 測試可直接注入 api，不需要 AuthProvider */
function useApiOptional(): Endpoints | null {
  try {
    return useApi();
  } catch {
    return null;
  }
}

export function useChat(): ChatContextValue {
  const v = useContext(ChatContext);
  if (!v) throw new Error('useChat 必須在 ChatProvider 內使用');
  return v;
}
