// 對應後端 auth / conversation / form / leave API。型別共用 @hyagent/shared（單一來源）。
import type {
  TaskCenterData,
  Applicant,
  Attachment,
  Definition,
  FieldOption,
  FieldSpec,
  LeaveBalance,
  ReportRef,
  SessionStatus,
  SubmissionInfo,
} from '@hyagent/shared';

export type {
  Applicant,
  Attachment,
  Definition,
  FieldOption,
  FieldSpec,
  LeaveBalance,
  ReportRef,
  SessionStatus,
  SubmissionInfo,
};

export interface TurnData {
  id?: string;
  status: SessionStatus;
  values: Record<string, unknown>;
  reply: string | null;
  submission?: SubmissionInfo;
  /** 後端動態產生的建議回覆（可一鍵送出）；可能為空陣列 */
  suggestions?: string[];
  /** 本回合啟動的報告（僅報告服務會帶） */
  report?: ReportRef;
}

/** 一種可下載格式：format 供 API 呼叫用，filename 是後端算好的實際檔名（含中文標題），供 <a download> 用 */
export interface ReportFile {
  format: string;
  filename: string;
}

export interface ReportData {
  id: string;
  status: 'queued' | 'outlining' | 'composing' | 'done' | 'empty' | 'failed';
  topic?: string;
  doneSections: number;
  totalSections?: number;
  /** 後端登錄表決定的可下載格式與檔名；前端不得自行寫死格式清單，也不得自己拼檔名
   * （下載的 blob: URL 沒有 header，瀏覽器只認 <a download> 的字面值） */
  files: ReportFile[];
  error?: string;
}

/** PATCH /:id/fields 的回傳（TurnData + 套用/退回明細） */
export interface UpdateFieldsData extends TurnData {
  applied: string[];
  rejected: { field: string; message: string }[];
}

export interface ConversationState {
  id: string;
  formId: string;
  status: SessionStatus;
  values: Record<string, unknown>;
  submission?: SubmissionInfo;
}

/** GET /forms 清單項目（供表單類型選單） */
export interface FormSummary {
  formId: string;
  title: string;
  description: string;
  /** 開場引導用的範例語句 */
  examples: string[];
}

interface LoginData {
  accessToken: string;
  refreshToken: string;
  user: Applicant;
}

import { embedConfig } from './embedConfig';
import i18n from './i18n';

// API 來源網域：dev 留空 → 走相對路徑由 Vite proxy 代理；
// production 設 VITE_API_BASE=https://<server-domain> 直接打後端（前後端分開部署）。
const API_ORIGIN = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

// 租戶公開金鑰（pk_…）：嵌入時由 widget 帶入，附在每個請求的 x-api-key 供後端解析租戶。
// 未帶（一般首方使用）則不附，後端落到預設租戶（向後相容）。
function apiKeyHeader(): Record<string, string> {
  return embedConfig.apiKey ? { 'x-api-key': embedConfig.apiKey } : {};
}

const BASE = `${API_ORIGIN}/api/conversations`;
const AUTH = `${API_ORIGIN}/api/auth`;

/** 帶 HTTP 狀態與後端錯誤碼的 API 錯誤，讓呼叫端能分辨 404 / 401 等情況 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---- token 管理（access + refresh，存 localStorage）----
const ACCESS_KEY = 'oa-access-token';
const REFRESH_KEY = 'oa-refresh-token';
let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

function setTokens(a: string, r: string): void {
  accessToken = a;
  refreshToken = r;
  localStorage.setItem(ACCESS_KEY, a);
  localStorage.setItem(REFRESH_KEY, r);
}
function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// refresh 用盡仍 401 時通知 App 導回登入頁
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function headers(userId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-user-id': userId || 'demo-user' };
}

function withAuth(init: RequestInit): RequestInit {
  const h = new Headers(init.headers);
  if (accessToken) h.set('authorization', `Bearer ${accessToken}`);
  // 嵌入時附租戶金鑰（每個受保護請求都需解析租戶）
  if (embedConfig.apiKey) h.set('x-api-key', embedConfig.apiKey);
  return { ...init, headers: h };
}

async function unwrap<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      json?.error?.message ?? json?.message ?? `錯誤 ${res.status}`,
      res.status,
      json?.error?.code,
    );
  }
  return json.data as T;
}

/** 用 refresh token 換新 token；成功回 true 並更新 token */
async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  const res = await fetch(`${AUTH}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const json = await res.json().catch(() => ({}));
  const data = json?.data;
  if (!data?.accessToken || !data?.refreshToken) return false;
  setTokens(data.accessToken, data.refreshToken);
  return true;
}

/** 受保護請求：自動帶 access token；遇 401 先嘗試 refresh 重試一次，仍失敗則登出 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetch(path, withAuth(init));
  if (res.status === 401 && refreshToken) {
    if (await tryRefresh()) res = await fetch(path, withAuth(init));
  }
  if (res.status === 401) {
    clearTokens();
    onUnauthorized();
  }
  return unwrap<T>(res);
}

export const auth = {
  /** 目前是否已登入（有 access token） */
  isAuthenticated: (): boolean => !!accessToken,

  /** 帳密登入 → 儲存 token、回使用者資料 */
  async login(username: string, password: string): Promise<Applicant> {
    const res = await fetch(`${AUTH}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await unwrap<LoginData>(res);
    setTokens(data.accessToken, data.refreshToken);
    return data.user;
  },

  /**
   * SSO handoff：以宿主簽發的終端使用者 token 換發本系統 token（嵌入情境免內部帳密登入）。
   * 需附租戶金鑰（x-api-key）讓後端以該租戶的 ssoSecret 驗章。
   */
  async ssoExchange(userToken: string): Promise<void> {
    const res = await fetch(`${AUTH}/sso/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiKeyHeader() },
      body: JSON.stringify({ userToken }),
    });
    const data = await unwrap<{ accessToken: string; refreshToken: string }>(res);
    setTokens(data.accessToken, data.refreshToken);
  },

  /** 取目前登入者資料（重整時還原登入狀態；401 會經 request 自動登出） */
  me(): Promise<Applicant> {
    return request<Applicant>(`${AUTH}/me`);
  },

  /** 登出（純前端清 token；JWT 無狀態） */
  logout(): void {
    clearTokens();
  },
};

export const api = {
  listTasks(): Promise<TaskCenterData> {
    return request<TaskCenterData>(`${API_ORIGIN}/api/tasks`);
  },
  getTask(id: string): Promise<ConversationState> {
    return request<ConversationState>(`${API_ORIGIN}/api/tasks/${encodeURIComponent(id)}`);
  },
  cancelTask(id: string): Promise<{ id: string; status: SessionStatus }> {
    return request(`${API_ORIGIN}/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  },
  /**
   * 健康檢查：探測後端 /api/healthz 是否可達。
   * server 能回應即代表 LLM provider 的 API key 已通過啟動驗證（AI 可正常呼叫）。
   * 公開端點、不需帶 token；任何網路/非 2xx 皆視為離線回 false。
   *
   * 走 /api 而非根路徑的 /healthz：Cloud Run 的 GFE 會攔截精確的 /healthz 自行回 404，
   * 請求進不到容器，指示燈會恆為離線。/api/* 不受影響（也順帶吃到 nginx 的同源代理）。
   */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${API_ORIGIN}/api/healthz`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  },

  /** 建立對話並起首輪；formId 省略時由 server 依首句意圖路由 */
  start(userId: string, message: string, formId?: string): Promise<TurnData> {
    const lang = i18n.language;
    return request<TurnData>(BASE, {
      method: 'POST',
      headers: headers(userId),
      body: JSON.stringify(formId ? { message, formId, lang } : { message, lang }),
    });
  },

  /** 列出可辦理的表單（供前端表單類型選單） */
  listForms(): Promise<FormSummary[]> {
    return request<FormSummary[]>(`${API_ORIGIN}/api/forms`);
  },

  /** 在既有對話送一則訊息，跑一輪 */
  sendMessage(userId: string, convId: string, message: string): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/messages`, {
      method: 'POST',
      headers: headers(userId),
      body: JSON.stringify({ message, lang: i18n.language }),
    });
  },

  /** 確認送出（不經 LLM，確認畫面按「送出」用）；回傳含 submission 的 turn */
  submit(userId: string, convId: string): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/submit`, {
      method: 'POST',
      headers: headers(userId),
    });
  },

  /** 確認畫面手動編輯欄位（不經 LLM，直接存回 session） */
  updateFields(
    userId: string,
    convId: string,
    fields: Record<string, unknown>,
  ): Promise<UpdateFieldsData> {
    return request<UpdateFieldsData>(`${BASE}/${convId}/fields`, {
      method: 'PATCH',
      headers: headers(userId),
      body: JSON.stringify({ fields }),
    });
  },

  /** 取消對話（後端把 status 設為 cancelled） */
  cancel(userId: string, convId: string): Promise<{ id: string; status: SessionStatus }> {
    return request<{ id: string; status: SessionStatus }>(`${BASE}/${convId}/cancel`, {
      method: 'POST',
      headers: headers(userId),
    });
  },

  /** 取對話完整狀態（含 formId） */
  getConversation(userId: string, convId: string): Promise<ConversationState> {
    return request<ConversationState>(`${BASE}/${convId}`, { headers: headers(userId) });
  },

  /** 取表單 Definition（schema-driven 渲染表單畫面） */
  getForm(formId: string): Promise<Definition> {
    return request<Definition>(`${API_ORIGIN}/api/forms/${formId}`);
  },

  /** 取各假別剩餘時數（畫面顯示「今年度剩餘 N 小時」） */
  getLeaveBalances(userId: string): Promise<LeaveBalance[]> {
    return request<LeaveBalance[]>(`${API_ORIGIN}/api/leave/balances`, {
      headers: headers(userId),
    });
  },

  /** 上傳一個附件（multipart），回傳後端產生的附件 metadata */
  uploadAttachment(userId: string, convId: string, file: File): Promise<Attachment> {
    const body = new FormData();
    body.append('file', file);
    // 不設 content-type：交給瀏覽器附上 multipart boundary
    return request<Attachment>(`${BASE}/${convId}/attachments`, {
      method: 'POST',
      headers: { 'x-user-id': userId || 'demo-user' },
      body,
    });
  },

  /** 刪除一個附件 */
  deleteAttachment(userId: string, convId: string, attachmentId: string): Promise<{ id: string }> {
    return request<{ id: string }>(`${BASE}/${convId}/attachments/${attachmentId}`, {
      method: 'DELETE',
      headers: headers(userId),
    });
  },
};

// request<T> 是 api.ts 內既有的私有輔助函式（自動帶 access token、401 時 refresh 重試），
// 已回傳 unwrap 後的 data，因此這裡直接回傳它的結果
export async function fetchReport(id: string): Promise<ReportData> {
  return request<ReportData>(`${API_ORIGIN}/api/reports/${id}`);
}

/**
 * 下載報告。
 *
 * 不能用 <a href="/api/reports/..."> 直接連——瀏覽器的一般導覽不會帶 Authorization header，
 * 而該路由掛了 requireAuth，點下去只會拿到 401。因此改為帶 token 取回 blob 後觸發下載。
 *
 * filename 必須由呼叫端帶入（來自狀態端點 ReportData.files[].filename），不可在此自行拼
 * `${id}.${format}`——下載走 blob: URL，blob 沒有 header，瀏覽器只採用 <a download> 的字面值，
 * 伺服器算好的 Content-Disposition（含中文標題的 RFC 5987 編碼）在這條路徑上根本不會被讀到。
 */
export async function downloadReport(id: string, format: string, filename: string): Promise<void> {
  const res = await fetch(
    `${API_ORIGIN}/api/reports/${id}/download?format=${encodeURIComponent(format)}`,
    withAuth({}),
  );
  if (!res.ok) throw new Error(`report ${id} 下載失敗`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
