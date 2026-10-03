// 對應後端 auth / conversation / form / leave API。型別共用 @hyagent/shared（單一來源）。
import type { KnowledgeFeed } from './knowledgePrompt';
import type {
  TaskCenterData,
  MySkillsView,
  NotificationFeed,
  Applicant,
  Attachment,
  Definition,
  DisplayBlock,
  FieldOption,
  FieldSpec,
  LeaveBalance,
  PendingActionView,
  ReportRef,
  SessionStatus,
  SubmissionInfo,
} from '@hyagent/shared';

export type {
  Applicant,
  Attachment,
  Definition,
  DisplayBlock,
  FieldOption,
  FieldSpec,
  LeaveBalance,
  PendingActionView,
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
  /** 本回合產生的待確認寫入動作（畫確認卡片） */
  pendingAction?: PendingActionView;
  /** 本回合的畫面區塊（表格等） */
  blocks?: DisplayBlock[];
  /** 確認端點回傳：執行是否成功 */
  actionOk?: boolean;
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

import { debugLog, maskToken } from './debugLog';
import { embedConfig } from './embedConfig';
import { embedderOrigin } from './hostBridge';
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

// ---- 憑證管理：兩種形式並存 ----
//
// HyAgent Session（Widget 走的路，規格 §7.1）：不透明字串，存 sessionStorage。
//   規格明訂「SDK 僅保存在 HyAgent 網域的記憶體 / sessionStorage」——用 localStorage 會讓
//   Session 跨分頁與跨瀏覽器工作階段留存，超出宿主自家登入的存續範圍（§10.5）。
//   沒有 refresh：到期就重走 token provider 換一張新的 Assertion（§6.5 呼叫時機②）。
//
// access + refresh JWT（帳密登入路徑）：維持原樣，存 localStorage。規格不涵蓋此路徑。
const SESSION_KEY = 'oa-session-token';
// Session 到期時刻（epoch ms）。跟著 token 存 sessionStorage：面板重整後不重走握手，
// 沒有它就不知道什麼時候該續期，Session 會一路撐到 401 才被發現。
const SESSION_EXPIRES_KEY = 'oa-session-expires';
const ACCESS_KEY = 'oa-access-token';
const REFRESH_KEY = 'oa-refresh-token';
let sessionToken: string | null = sessionStorage.getItem(SESSION_KEY);
let sessionExpiresAt: number | null = readSessionExpiry();
let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

function readSessionExpiry(): number | null {
  const at = Number(sessionStorage.getItem(SESSION_EXPIRES_KEY));
  return Number.isFinite(at) && at > 0 ? at : null;
}

function setSessionToken(token: string, expiresIn?: number): void {
  sessionToken = token;
  sessionStorage.setItem(SESSION_KEY, token);
  sessionExpiresAt = typeof expiresIn === 'number' && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
  if (sessionExpiresAt) sessionStorage.setItem(SESSION_EXPIRES_KEY, String(sessionExpiresAt));
  else sessionStorage.removeItem(SESSION_EXPIRES_KEY);
  // 兩種憑證不並存：換到 Session 後，帳密登入留下的 JWT 不該還躺在 localStorage 裡
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  scheduleRenewal();
}
function setTokens(a: string, r: string): void {
  accessToken = a;
  refreshToken = r;
  localStorage.setItem(ACCESS_KEY, a);
  localStorage.setItem(REFRESH_KEY, r);
}
function clearTokens(): void {
  sessionToken = null;
  sessionExpiresAt = null;
  accessToken = null;
  refreshToken = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_EXPIRES_KEY);
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  scheduleRenewal();
}

// ---- Session 續期（規格 §6.5 呼叫時機②、§7.1）----
//
// SSO 路徑沒有 refresh token：續期＝到期前 60 秒重走 token provider 拿一張新的 Assertion，
// 再換一個新的 Session。provider 由 App 在嵌入模式下註冊為 hostBridge.requestIdentity()，
// 與首次取票走的是同一條 postMessage 協定，宿主頁不需要為續期多寫任何東西。
//
// 未嵌入（第一方直接開面板）時沒有 provider，這整段等於停用——那條路徑走帳密登入的 JWT。
const RENEW_LEAD_MS = 60_000;

let identityProvider: (() => Promise<string | null>) | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let renewInFlight: Promise<boolean> | null = null;

/** 註冊續期用的 token provider；傳 null 取消（例如面板卸載）。 */
export function setIdentityProvider(fn: (() => Promise<string | null>) | null): void {
  identityProvider = fn;
  scheduleRenewal();
}

function scheduleRenewal(): void {
  if (renewTimer !== null) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }
  if (!identityProvider || !sessionToken || sessionExpiresAt === null) return;
  renewTimer = setTimeout(() => {
    renewTimer = null;
    void renewSession();
  }, Math.max(sessionExpiresAt - Date.now() - RENEW_LEAD_MS, 0));
}

/** 單一飛行：同時湧入的請求共用一次換發，避免一次燒掉好幾張一次性的 Assertion。 */
function renewSession(): Promise<boolean> {
  if (!renewInFlight) {
    renewInFlight = performRenewal().finally(() => {
      renewInFlight = null;
    });
  }
  return renewInFlight;
}

async function performRenewal(): Promise<boolean> {
  if (!identityProvider) return false;
  try {
    const assertion = await identityProvider();
    // 拿不到票＝使用者已從宿主網站登出，或宿主端點失敗。兩者都不該重試到天荒地老：
    // 讓它落到 401 → onUnauthorized，由使用者自己決定要不要重新登入。
    if (!assertion) return false;
    await auth.ssoExchange(assertion);
    return true;
  } catch {
    return false;
  }
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
  // Session 優先：有它就代表這是 Widget 的 SSO 路徑
  const bearer = sessionToken ?? accessToken;
  if (bearer) h.set('authorization', `Bearer ${bearer}`);
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
let refreshInFlight: Promise<boolean> | null = null;
function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    const rotate = async () => {
      // Another tab may already have rotated the shared localStorage credentials.
      const storedAccess = localStorage.getItem(ACCESS_KEY);
      const storedRefresh = localStorage.getItem(REFRESH_KEY);
      if (!storedAccess || !storedRefresh) return false;
      if (storedRefresh !== refreshToken) {
        setTokens(storedAccess, storedRefresh);
        return true;
      }
      return performRefresh();
    };
    const rotation = navigator.locks
      ? navigator.locks.request('hyagent-refresh-token', rotate)
      : rotate();
    refreshInFlight = Promise.resolve(rotation).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function performRefresh(): Promise<boolean> {
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

/** 受保護請求：自動帶憑證；Session 快到期先續期，遇 401 依憑證形式各重試一次，仍失敗則登出 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 續期的主要機制是 scheduleRenewal() 的定時器，這裡是補網：背景分頁的 setTimeout 會被
  // 瀏覽器節流到分鐘級，筆電闔上更是整段不跑——醒來時定時器還沒燒到，Session 卻早就過期了。
  if (sessionToken && identityProvider && sessionExpiresAt !== null && Date.now() >= sessionExpiresAt - RENEW_LEAD_MS) {
    await renewSession();
  }
  const sentToken = accessToken;
  const sentSession = sessionToken;
  let res = await fetch(path, withAuth(init));
  // 帳密登入的 JWT：refresh 一次再重試
  if (res.status === 401 && !sessionToken && refreshToken) {
    if (accessToken !== sentToken || await tryRefresh()) res = await fetch(path, withAuth(init));
  }
  // Session：沒有 refresh，改重走 token provider（規格 §7.1）。撤銷 kid、依 sub 作廢、
  // file 模式重啟都會讓 Session 提早失效——使用者在宿主網站仍登入的話，這裡換一張就接回去了，
  // 不必先把人丟回登入頁再讓他想辦法。
  if (res.status === 401 && sessionToken && identityProvider) {
    if (sessionToken !== sentSession || await renewSession()) res = await fetch(path, withAuth(init));
  }
  if (res.status === 401) {
    clearTokens();
    onUnauthorized();
  }
  return unwrap<T>(res);
}

export const auth = {
  /** 目前是否已登入（有 access token） */
  isAuthenticated: (): boolean => !!sessionToken || !!accessToken,

  /** 帳密登入 → 儲存 token、回使用者資料 */
  async login(username: string, password: string): Promise<Applicant> {
    const res = await fetch(`${AUTH}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiKeyHeader() },
      body: JSON.stringify({ username, password }),
    });
    const data = await unwrap<LoginData>(res);
    setTokens(data.accessToken, data.refreshToken);
    return data.user;
  },

  /**
   * Identity Assertion → HyAgent Session（規格 §5.3、§7.1）。
   *
   * 租戶由 Assertion 的 `iss` 決定，不是 API Key——後者只影響外觀設定與 CORS。
   * 回來的 sessionToken 是不透明字串，前端**不得**解析其內容（§7.1）。
   */
  async ssoExchange(assertion: string): Promise<void> {
    // embedOrigin：規格 §8.6 的來源檢查。換發請求由本面板發出，因此它的 Origin header
    // 恆為 HyAgent 自己的網域，無從分辨是誰把我們嵌起來——真正的答案在 document.referrer，
    // 由瀏覽器設定、嵌入方無法偽造。後端拿它比對租戶白名單，讀不到就拒絕。
    const embedOrigin = embedderOrigin();
    debugLog('③ 以 Assertion 換發 HyAgent Session', { assertion: maskToken(assertion), embedOrigin });
    const res = await fetch(`${AUTH}/sso/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiKeyHeader() },
      body: JSON.stringify({ assertion, embedOrigin }),
    });
    // user 是後端從 Assertion claims 取出的 sub / name，本流程不使用（登入者資料一律以
    // /me 為準），但它是「這張票換到誰」最直接的證據，除錯時印出來。
    const data = await unwrap<{
      sessionToken: string;
      expiresIn: number;
      user?: { sub: string; name?: string };
    }>(res);
    debugLog('④ 換發成功', {
      user: data.user ?? '(後端未回傳)',
      sessionToken: maskToken(data.sessionToken),
      expiresIn: `${data.expiresIn} 秒`,
    });
    // expiresIn 逐租戶可設（300～28800 秒），不能在前端寫死——續期時機由它決定。
    setSessionToken(data.sessionToken, data.expiresIn);
  },

  /** 取目前登入者資料（重整時還原登入狀態；401 會經 request 自動登出） */
  me(): Promise<Applicant> {
    return request<Applicant>(`${AUTH}/me`);
  },

  /**
   * 登出：清掉本地憑證，並通知後端作廢 Session（規格 §7.2、SDK §6.3 的 logout()）。
   *
   * Session 是伺服器端有狀態的，只清瀏覽器這一側等於留一張仍可用的票在後端直到過期。
   * 帳密登入的 JWT 無狀態，沒有要通知的對象，維持純前端清除。
   */
  logout(): void {
    const token = sessionToken;
    clearTokens();
    if (!token) return;
    // keepalive：這支常緊接著 reload 或關閉分頁被呼叫，少了它請求會被瀏覽器當場取消，
    // Session 就留在後端直到自然過期。回應內容不重要，失敗也不該擋住 UI。
    void fetch(`${AUTH}/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...apiKeyHeader() },
      keepalive: true,
    }).catch(() => {});
  },
};

export const api = {
  mySkills: () => request<MySkillsView>(`${API_ORIGIN}/api/skills`),
  /**
   * 登入者視角的知識庫開場資料（開關＋推薦句）。
   * 免登入的 /widget/config 只能用訪客部門判斷開關，指派給一般部門的授權它看不到；
   * 登入後改用這支覆蓋，判準與對話守門同一套。
   */
  knowledgeFeed: () => request<KnowledgeFeed>(`${API_ORIGIN}/api/knowledge/suggested-prompts`),
  listNotifications(): Promise<NotificationFeed> {
    return request<NotificationFeed>(`${API_ORIGIN}/api/notifications`);
  },
  markNotificationsRead(ids: string[]): Promise<{ ok: boolean }> {
    return request(`${API_ORIGIN}/api/notifications/read`, { method: 'POST', body: JSON.stringify({ ids }) });
  },
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

  /** 確認卡片「確認」：不經 LLM；input 為使用者修改後的參數（省略＝照原參數） */
  confirmAction(userId: string, convId: string, actionId: string, input?: Record<string, unknown>): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/actions/${actionId}/confirm`, {
      method: 'POST',
      headers: headers(userId),
      body: JSON.stringify(input ? { input } : {}),
    });
  },

  /** 確認卡片「取消」 */
  cancelAction(userId: string, convId: string, actionId: string): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/actions/${actionId}/cancel`, {
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
