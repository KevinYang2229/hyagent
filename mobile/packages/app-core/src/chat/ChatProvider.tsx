/**
 * 對話：一個 App 工作階段一個對話；第一句建立對話，之後沿用。
 * 寫入動作的確認／取消也在這裡；執行成功後呼叫 onActionConfirmed，讓 App 自己決定要刷新哪些資料。
 */
import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { ReplyFeedbackInput } from '@hyagent/shared';
import type { Endpoints } from '@hyagent/app-core/api/endpoints';
import { ApiError, errorMessage } from '@hyagent/app-core/api/errors';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';
import { useSignedOutReset } from '@hyagent/app-core/auth/useSignedOutReset';
import { chatReducer, initialChatState } from './chatReducer';
import type { ChatState } from './types';

export type ConfirmOutcome =
  | { kind: 'done'; ok: boolean }
  | { kind: 'invalid'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'gone' };

interface ChatContextValue {
  state: ChatState;
  /** 回覆中呼叫會排隊（最多 MAX_QUEUED 句）並回 true；空白或佇列已滿回 false。 */
  send(text: string): Promise<boolean>;
  newConversation(): void;
  cancelSend(): void;
  propose(toolId: string, input: Record<string, unknown>): Promise<void>;
  confirm(input?: Record<string, unknown>): Promise<ConfirmOutcome>;
  cancel(): Promise<void>;
  /** 評價 AI 回覆；undefined＝撤回。樂觀更新，失敗還原並回 false。 */
  rate(messageId: string, next: ReplyFeedbackInput | undefined): Promise<boolean>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** 回覆中最多可排隊的句子數 */
export const MAX_QUEUED = 3;

export function ChatProvider({
  children,
  api: injected,
  onActionConfirmed,
}: {
  children: ReactNode;
  api?: Endpoints;
  /** 寫入動作執行成功後呼叫（例如刷新列表、亮紅點） */
  onActionConfirmed?: () => void;
}) {
  const fromAuth = useApiOptional();
  const api = injected ?? fromAuth!;
  // 用 ref 保存最新的回呼，confirm 不必因回呼換身分而重建
  const onConfirmedRef = useRef(onActionConfirmed);
  onConfirmedRef.current = onActionConfirmed;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // 同步旗標：dispatch 要等重新渲染才生效，同一個 tick 內連送兩次靠它擋
  const sendingRef = useRef(false);
  const sendController = useRef<AbortController | null>(null);
  // 同步的對話 id（state 要等重新渲染才更新）
  const convIdRef = useRef<string | null>(null);
  // 進行中的「建立對話」：send 的第一句與 propose 的空對話共用，避免開出兩個對話
  const startRef = useRef<Promise<string | null> | null>(null);
  // 世代：登出重置後，舊請求的結果要丟掉
  const genRef = useRef(0);
  // 回覆中又送來的句子（語音、首頁帶問題、優惠券問 AI）先排隊，這一輪結束後依序送出
  const queueRef = useRef<string[]>([]);
  const sendRef = useRef<(text: string) => Promise<boolean>>(async () => false);

  const resetAll = useCallback(() => {
    genRef.current += 1;
    sendController.current?.abort();
    sendController.current = null;
    sendingRef.current = false;
    queueRef.current = [];
    startRef.current = null;
    convIdRef.current = null;
    dispatch({ type: 'reset' });
  }, []);

  // 登入狀態離開 signedIn（登出、換人）就清掉對話；沒有 AuthProvider（測試注入 api）時略過
  useSignedOutReset(resetAll);

  /** 建立對話（text 有值時連同第一句；沒有則開空對話）。回傳對話 id，世代已變則回 null。 */
  const startWith = useCallback(
    (text?: string, signal?: AbortSignal): Promise<string | null> => {
      const gen = genRef.current;
      const p = (async () => {
        const d = text === undefined ? await api.startConversation() : await api.startConversation(text, signal);
        if (gen !== genRef.current) return null;
        convIdRef.current = d.id;
        if (text === undefined) dispatch({ type: 'conversationStarted', conversationId: d.id });
        else dispatch({ type: 'turnReceived', conversationId: d.id, turn: d });
        return d.id;
      })();
      startRef.current = p;
      const clear = () => {
        if (startRef.current === p) startRef.current = null;
      };
      p.then(clear, clear);
      return p;
    },
    [api],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return false;
      if (sendingRef.current) {
        // 不丟掉：排隊等這一輪結束；佇列滿了才拒絕
        if (queueRef.current.length >= MAX_QUEUED) return false;
        queueRef.current.push(text);
        return true;
      }
      sendingRef.current = true;
      const controller = new AbortController();
      sendController.current = controller;
      const gen = genRef.current;
      dispatch({ type: 'userSent', text });
      try {
        // 若 propose 正在開空對話，等它完成再沿用同一個對話
        if (startRef.current) await startRef.current.catch(() => null);
        if (gen !== genRef.current) return false;
        const id = convIdRef.current;
        if (!id) {
          await startWith(text, controller.signal);
        } else {
          try {
            const d = await api.sendMessage(id, text, controller.signal);
            if (gen !== genRef.current) return false;
            dispatch({ type: 'turnReceived', turn: d });
          } catch (e) {
            // 對話已不存在（例如伺服器資料重置）：重開一個對話再送
            if (!(e instanceof ApiError && e.status === 404) || gen !== genRef.current) throw e;
            convIdRef.current = null;
            dispatch({ type: 'conversationLost' });
            await startWith(text, controller.signal);
          }
        }
        return gen === genRef.current;
      } catch (e) {
        if (gen !== genRef.current) return false;
        dispatch({ type: 'sendFailed', message: errorMessage(e) });
        return false;
      } finally {
        if (gen === genRef.current) {
          sendingRef.current = false;
          sendController.current = null;
          // 同一個 tick 接著送下一句，使用者泡泡在送出時才出現
          const next = queueRef.current.shift();
          if (next !== undefined) void sendRef.current(next);
        }
      }
    },
    [api, startWith],
  );
  sendRef.current = send;

  const cancelSend = useCallback(() => {
    if (!sendingRef.current) return;
    genRef.current += 1;
    sendController.current?.abort();
    sendController.current = null;
    sendingRef.current = false;
    // 取消回覆也一併放棄排隊中的句子，避免取消後又自動送出
    queueRef.current = [];
    startRef.current = null;
    // 舊回合可能仍在伺服器執行；下一次使用新對話，避免兩個回合互相干擾。
    convIdRef.current = null;
    dispatch({ type: 'sendCancelled' });
  }, []);

  const newConversation = resetAll;

  const propose = useCallback(
    async (toolId: string, input: Record<string, unknown>) => {
      const gen = genRef.current;
      // 取得可用的對話 id：有進行中的建立就等它；仍沒有才自己開空對話
      const ensureId = async (): Promise<string | null> => {
        if (startRef.current) await startRef.current.catch(() => null);
        return convIdRef.current ?? (await startWith());
      };
      let id = await ensureId();
      if (!id || gen !== genRef.current) return;
      let result;
      try {
        result = await api.proposeAction(id, toolId, input);
      } catch (e) {
        // 對話 id 已失效：重開一個空對話，只重試一次
        if (!(e instanceof ApiError && e.status === 404) || gen !== genRef.current) throw e;
        convIdRef.current = null;
        dispatch({ type: 'conversationLost' });
        id = await ensureId();
        if (!id || gen !== genRef.current) return;
        result = await api.proposeAction(id, toolId, input);
      }
      if (gen !== genRef.current) return;
      dispatch({ type: 'actionProposed', conversationId: id, action: result.pendingAction });
    },
    [api, startWith],
  );

  const confirm = useCallback(
    async (input?: Record<string, unknown>): Promise<ConfirmOutcome> => {
      const { conversationId: id, pending } = stateRef.current;
      if (!id || !pending) return { kind: 'gone' };
      try {
        const turn = await api.confirmAction(id, pending.id, input);
        const ok = turn.actionOk !== false;
        dispatch({ type: 'actionFinished', text: turn.reply ?? '' });
        if (ok) onConfirmedRef.current?.();
        return { kind: 'done', ok };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 422 && e.code === 'ACTION_INPUT_INVALID') return { kind: 'invalid', message: e.message };
          if (e.status === 409 || e.status === 404) {
            dispatch({ type: 'actionGone', message: e.code === 'ACTION_EXPIRED' ? '這個動作已逾時失效，請重新提出。' : '這個動作已處理過或已不存在。' });
            return { kind: 'gone' };
          }
        }
        return { kind: 'unavailable', message: errorMessage(e) };
      }
    },
    [api],
  );

  const cancel = useCallback(async () => {
    const { conversationId: id, pending } = stateRef.current;
    if (!id || !pending) return;
    try {
      const turn = await api.cancelAction(id, pending.id);
      dispatch({ type: 'actionFinished', text: turn.reply ?? '' });
    } catch (e) {
      dispatch({ type: 'actionGone', message: e instanceof ApiError && (e.status === 409 || e.status === 404) ? '這個動作已處理過或已不存在。' : errorMessage(e) });
    }
  }, [api]);

  const rate = useCallback(
    async (messageId: string, next: ReplyFeedbackInput | undefined): Promise<boolean> => {
      const msg = stateRef.current.messages.find((m) => m.id === messageId);
      if (!msg || msg.role !== 'agent' || !msg.replyId || !msg.conversationId) return false;
      const previous = msg.feedback;
      dispatch({ type: 'feedbackSet', messageId, feedback: next });
      try {
        if (next) await api.setFeedback(msg.conversationId, msg.replyId, next);
        else await api.clearFeedback(msg.conversationId, msg.replyId);
        return true;
      } catch {
        dispatch({ type: 'feedbackSet', messageId, feedback: previous });
        return false;
      }
    },
    [api],
  );

  const value = useMemo(
    () => ({ state, send, cancelSend, newConversation, propose, confirm, cancel, rate }),
    [state, send, cancelSend, newConversation, propose, confirm, cancel, rate],
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

/** MessageBubble 用：不在 ChatProvider 內（如預覽頁）時回 null，評價按鈕不顯示 */
export function useChatOptional(): ChatContextValue | null {
  return useContext(ChatContext);
}

/** 測試用：直接提供 context 值 */
export const ChatContextForTest = ChatContext;
