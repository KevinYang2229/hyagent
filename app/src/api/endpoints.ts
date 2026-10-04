/** 後端 API 函式：路徑一律不含 /api（由 client 補上）。 */
import type { Applicant, NotificationFeed, PendingActionView } from '@hyagent/shared';
import type { ApiClient } from './client';
import type { CouponResult, InvokeResult, LoginResult, ShelfResult, StartData, TurnData, UploadFile } from './types';

/** RN 的 FormData 以 { uri, name, type } 表示檔案 */
function fileForm(field: string, file: UploadFile, extra: Record<string, string> = {}): () => FormData {
  return () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append(field, file as unknown as Blob);
    return form;
  };
}

const TURN_TIMEOUT_MS = 90_000;

export function createEndpoints(api: ApiClient) {
  return {
    login: (username: string, password: string) =>
      api.request<LoginResult>('/auth/login', { method: 'POST', json: { username, password }, auth: false }),
    me: () => api.request<Applicant>('/auth/me'),

    startConversation: (message?: string) =>
      api.request<StartData>('/conversations', { method: 'POST', json: message ? { message } : {}, timeoutMs: TURN_TIMEOUT_MS }),
    sendMessage: (id: string, message: string) =>
      api.request<TurnData>(`/conversations/${id}/messages`, { method: 'POST', json: { message }, timeoutMs: TURN_TIMEOUT_MS }),
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
