/** 後端 API 函式：路徑一律不含 /api（由 client 補上）。 */
import type { Applicant, NotificationFeed, PendingActionView } from '@hyagent/shared';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { ApiError } from './errors';
import type { ApiClient } from './client';
import type { CouponResult, InvokeResult, LoginResult, ShelfResult, StartData, TurnData, UploadFile } from './types';

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

    analyzeImage: (mode: 'shelf' | 'coupon', file: UploadFile) =>
      api.request<ShelfResult | CouponResult>('/vision/analyze', { method: 'POST', form: fileForm('image', file, { mode }), timeoutMs: TURN_TIMEOUT_MS }),
    transcribe: (file: UploadFile) =>
      api.request<{ text: string }>('/speech/transcribe', { method: 'POST', form: fileForm('audio', file), timeoutMs: 60_000 }),
    invokeTool: <T>(toolId: string, input: Record<string, unknown> = {}) =>
      api.request<InvokeResult<T>>(`/tools/${encodeURIComponent(toolId)}/invoke`, { method: 'POST', json: { input } }),
    notifications: () => api.request<NotificationFeed>('/notifications'),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
