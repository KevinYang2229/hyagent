/** 後端 API 函式：路徑一律不含 /api（由 client 補上）。 */
import type { Applicant, NotificationFeed, PendingActionView, ReplyFeedbackInput } from '@hyagent/shared';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { ApiError } from './errors';
import type { ApiClient, GuestSession } from './client';
import type { InvokeResult, LoginResult, StartData, TurnData, UploadFile } from './types';

/** Expo 57 fetch 接受 Blob 或提供 bytes() 的 File，不能直接上傳 URI 物件。 */
function fileForm(field: string, file: UploadFile, extra: Record<string, string> = {}): () => FormData | Promise<FormData> {
  return () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    if (Platform.OS === 'web') {
      return fetch(file.uri).then(async (response) => {
        if (!response.ok) throw new Error('無法讀取錄音或照片，請再試一次。');
        const source = await response.blob();
        // MediaRecorder 常含 codecs 參數；上傳保留實際格式並移除參數。
        const type = (source.type || file.type).split(';')[0].trim();
        const blob = source.slice(0, source.size, type);
        const extension = type === 'audio/webm' ? 'webm' : type === 'audio/mp4' ? 'm4a' : type === 'audio/wav' ? 'wav' : undefined;
        form.append(field, blob, extension ? `speech.${extension}` : file.name);
        return form;
      });
    }
    const localFile = new File(file.uri);
    if (!localFile.exists || localFile.size === 0) {
      throw new ApiError('錄音或照片檔案無法讀取，請重新拍攝或錄音。', 0, 'UPLOAD_FILE_UNREADABLE');
    }
    // 直接交給 Expo fetch 讀取 File.bytes()；File.slice() 會建立 RN 不支援的 ArrayBuffer Blob。
    form.append(field, {
      name: file.name,
      type: file.type,
      bytes: () => localFile.bytes(),
    } as unknown as Blob);
    return form;
  };
}

const TURN_TIMEOUT_MS = 90_000;

export function createEndpoints(api: ApiClient) {
  return {
    login: (username: string, password: string) =>
      api.request<LoginResult>('/auth/login', { method: 'POST', json: { username, password }, auth: false }),
    me: () => api.request<Applicant>('/auth/me'),
    /** 免登入訪客 Session（租戶須開啟訪客使用） */
    guestSession: () => api.request<GuestSession>('/auth/guest', { method: 'POST', auth: false }),

    startConversation: (message?: string, signal?: AbortSignal) =>
      api.request<StartData>('/conversations', { method: 'POST', json: message ? { message } : {}, timeoutMs: TURN_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
    sendMessage: (id: string, message: string, signal?: AbortSignal) =>
      api.request<TurnData>(`/conversations/${id}/messages`, { method: 'POST', json: { message }, timeoutMs: TURN_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
    proposeAction: (id: string, toolId: string, input: Record<string, unknown>) =>
      api.request<{ pendingAction: PendingActionView }>(`/conversations/${id}/actions/propose`, { method: 'POST', json: { toolId, input } }),
    confirmAction: (id: string, actionId: string, input?: Record<string, unknown>) =>
      api.request<TurnData>(`/conversations/${id}/actions/${actionId}/confirm`, {
        method: 'POST',
        json: input ? { input } : {},
        timeoutMs: TURN_TIMEOUT_MS,
      }),
    cancelAction: (id: string, actionId: string) =>
      api.request<TurnData>(`/conversations/${id}/actions/${actionId}/cancel`, { method: 'POST', json: {} }),

    /** 評價 AI 回覆（建立或更新）；伺服器依 replyId 取問答快照 */
    setFeedback: (convId: string, replyId: string, input: ReplyFeedbackInput) =>
      api.request<ReplyFeedbackInput>(`/conversations/${convId}/replies/${replyId}/feedback`, { method: 'PUT', json: input }),
    /** 撤回評價（冪等，回 204） */
    clearFeedback: (convId: string, replyId: string) =>
      api.request<void>(`/conversations/${convId}/replies/${replyId}/feedback`, { method: 'DELETE' }),

    /** 影像辨識：mode 與回應格式由各 App 的領域決定（例如門市的 shelf／coupon）。 */
    analyzeImage: <T = unknown>(mode: string, file: UploadFile) =>
      api.request<T>('/vision/analyze', { method: 'POST', form: fileForm('image', file, { mode }), timeoutMs: TURN_TIMEOUT_MS }),
    transcribe: (file: UploadFile) =>
      api.request<{ text: string }>('/speech/transcribe', { method: 'POST', form: fileForm('audio', file), timeoutMs: 60_000 }),
    invokeTool: <T>(toolId: string, input: Record<string, unknown> = {}) =>
      api.request<InvokeResult<T>>(`/tools/${encodeURIComponent(toolId)}/invoke`, { method: 'POST', json: { input } }),
    notifications: () => api.request<NotificationFeed>('/notifications'),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
