/**
 * @hyagent/sdk — HyAgent 整合 SDK（瀏覽器端）。
 *
 * 提供兩種整合方式，共用同一組租戶設定（公開金鑰 + 選用 SSO token）：
 *   1) headless REST：開發者自建 UI，直接呼叫對話 / 表單 API。
 *   2) widget 橋接：程式化開關內建 widget（OAAgent.open/close）、訂閱事件（form:submitted…）。
 *
 * 設計上不依賴框架，型別重用 @hyagent/shared（單一來源）。
 */
import type { Definition, SessionStatus, SubmissionInfo } from '@hyagent/shared';

/**
 * Token Provider：需要身分時現取一張 Assertion（規格 §5.2、§6.5）。
 *
 * 回 null 代表「使用者沒登入貴方系統」，SDK 視同匿名，不重試。
 * 每次呼叫都**必須**回當下新簽發的那一張：Assertion 一次性，重用會被 `TOKEN_REPLAYED` 拒絕。
 */
export type AssertionProvider = () => string | null | Promise<string | null>;

export interface OAAgentOptions {
  /** 租戶公開金鑰 pk_…（多租戶資料隔離；省略則後端落到預設租戶） */
  key?: string;
  /**
   * Identity Assertion（規格 §4）：貴方後端以私鑰簽發的短效憑證，首次請求前自動換發 Session。
   *
   * 兩種形式：
   *
   * - **字串**：一次性用法。它有效期 60 秒且只能換一次，SDK 不會重送同一張，
   *   Session 到期後就沒有身分可續了（`refreshIdentity()` 回 false）。
   * - **函式**（token provider，建議）：SDK 在 Session 到期前 60 秒與收到 `401` 時自動重新呼叫，
   *   長時間執行的頁面因此不需要整個重建 client。
   *
   * 兩者都僅供 headless REST 用法。內建 widget 不吃靜態憑證（規格 §6.5），請改用 tokenUrl。
   */
  assertion?: string | AssertionProvider;
  /**
   * 內建 widget 的 Token Provider 端點（宿主自家的 Identity Endpoint）。
   * widget 需要身分時才同源帶 cookie 向這裡取一張當下新簽發的憑證，
   * 經 postMessage 交給面板（規格 §6.5、§6.6）。
   */
  tokenUrl?: string;
  /** API 來源網域；預設同源（widget 同源部署時免設） */
  apiBase?: string;
  /** 內建 widget 的載入網址；呼叫 loadWidget() 時注入 <script> 用 */
  widgetSrc?: string;
}

export interface TurnData {
  id?: string;
  status: SessionStatus;
  values: Record<string, unknown>;
  reply: string | null;
  submission?: SubmissionInfo;
  suggestions?: string[];
}

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

export interface FormSummary {
  formId: string;
  title: string;
  description: string;
  examples: string[];
}

/** widget 事件（widget.js 以 DOM CustomEvent 'oa-agent:<type>' 發出） */
export type OAAgentEventType = 'open' | 'close' | 'submitted';

export class OAAgentError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'OAAgentError';
    this.status = status;
    this.code = code;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

declare global {
  interface Window {
    OAAgent?: {
      open?: () => void;
      close?: () => void;
      toggle?: () => void;
      onEvent?: (data: { type: string; [k: string]: unknown }) => void;
    };
  }
}

export interface OAAgentClient {
  /**
   * 以宿主 token 換發本系統 token（headless 用；widget 流程會自動處理）。
   *
   * 與 `refreshIdentity()` 是同一個動作，差別只在這支不回報成敗——
   * 需要分辨「使用者未登入貴方系統」（provider 回 null）與連線錯誤時，用 `refreshIdentity()`。
   */
  authenticate(): Promise<void>;
  /**
   * 重走 token provider 換一張新的 Session（規格 §6.3）。
   *
   * 平時不需要自己呼叫——SDK 會在到期前 60 秒與收到 `401` 時自動做同一件事。
   * 留這支是給「貴方系統的登入者換人了」這類 SDK 看不到的時刻用。
   * 回 `false` 代表 provider 沒給票（視同未登入），或 `assertion` 是已用掉的靜態字串。
   */
  refreshIdentity(): Promise<boolean>;
  /**
   * 結束 Session（規格 §6.3、§7.2）：通知後端作廢，並清掉本地憑證。
   *
   * Session 是伺服器端有狀態的，只清本地等於留一張仍可用的票在後端直到過期。
   */
  logout(): Promise<void>;
  conversations: {
    create(input?: { formId?: string; message?: string }): Promise<TurnData>;
    sendMessage(id: string, message: string): Promise<TurnData>;
    submit(id: string): Promise<TurnData>;
    updateFields(id: string, fields: Record<string, unknown>): Promise<UpdateFieldsData>;
    get(id: string): Promise<ConversationState>;
    cancel(id: string): Promise<{ id: string; status: SessionStatus }>;
  };
  forms: {
    list(): Promise<FormSummary[]>;
    get(formId: string): Promise<Definition>;
  };
  /** 訂閱 widget 事件；回傳取消訂閱函式 */
  on(event: OAAgentEventType, handler: (detail: unknown) => void): () => void;
  /** 程式化控制內建 widget（需 widget.js 已載入，或先呼叫 loadWidget） */
  open(): void;
  close(): void;
  toggle(): void;
  /** 動態注入 widget.js（帶上本 SDK 的 key / tokenUrl 等設定） */
  loadWidget(): void;
}

export function createOAAgent(options: OAAgentOptions = {}): OAAgentClient {
  const apiBase = (options.apiBase ?? '').replace(/\/+$/, '');
  const CONV = `${apiBase}/api/conversations`;
  const FORMS = `${apiBase}/api/forms`;
  const AUTH = `${apiBase}/api/auth`;

  let tokens: Tokens | null = null;
  /** HyAgent Session（不透明字串）。與帳密登入的 JWT 二擇一，不並存。 */
  let sessionToken: string | null = null;
  /** Session 到期時刻（epoch ms）；null＝後端沒回 expiresIn，那就只能等 401 才知道。 */
  let sessionExpiresAt: number | null = null;
  /** 靜態字串形式的 assertion 只能換一次：同一張送第二次必被 `TOKEN_REPLAYED` 拒絕。 */
  let staticAssertionUsed = false;

  /** 規格 §6.5 呼叫時機②：到期前 60 秒重走 token provider。 */
  const RENEW_LEAD_MS = 60_000;

  function baseHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (options.key) h['x-api-key'] = options.key;
    const bearer = sessionToken ?? tokens?.accessToken;
    if (bearer) h['authorization'] = `Bearer ${bearer}`;
    return h;
  }

  async function unwrap<T>(res: Response): Promise<T> {
    const json = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string; code?: string };
      message?: string;
    };
    if (!res.ok) {
      throw new OAAgentError(
        json?.error?.message ?? json?.message ?? `錯誤 ${res.status}`,
        res.status,
        json?.error?.code,
      );
    }
    return json.data as T;
  }

  /** 取下一張 Assertion：函式形式每次現取，字串形式只給一次。 */
  function nextAssertion(): Promise<string | null> {
    const source = options.assertion;
    if (typeof source === 'function') return Promise.resolve(source());
    if (!source || staticAssertionUsed) return Promise.resolve(null);
    // 換發成功才記為已用掉（見 performExchange）：網路錯誤或 5xx 時那張票根本沒送達後端，
    // 這時就作廢它等於平白讓呼叫端少一次重試機會。
    return Promise.resolve(source);
  }

  /** 續期可行的前提：拿得到新票。靜態字串用掉就沒有下一張了。 */
  function canRenew(): boolean {
    return typeof options.assertion === 'function';
  }

  let exchangeInFlight: Promise<boolean> | null = null;
  /** 單一飛行：同時湧入的請求共用一次換發，不會一口氣燒掉好幾張一次性的 Assertion。 */
  function exchangeIdentity(): Promise<boolean> {
    if (!exchangeInFlight) {
      exchangeInFlight = performExchange().finally(() => {
        exchangeInFlight = null;
      });
    }
    return exchangeInFlight;
  }

  /** Identity Assertion → HyAgent Session（規格 §5.3、§7.1）。 */
  async function performExchange(): Promise<boolean> {
    const assertion = await nextAssertion();
    if (!assertion) return false;
    const res = await fetch(`${AUTH}/sso/exchange`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({ assertion }),
    });
    const data = await unwrap<{ sessionToken: string; expiresIn?: number }>(res);
    // Session 不透明、也沒有 refresh：續期＝重走簽發流程（規格 §7.1）。
    // expiresIn 逐租戶可設（300～28800 秒），因此續期時機只能由回應決定，不能在 SDK 寫死。
    sessionToken = data.sessionToken;
    sessionExpiresAt =
      typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : null;
    if (typeof options.assertion === 'string') staticAssertionUsed = true;
    return true;
  }

  /**
   * 到期前 60 秒起就該換（規格 §6.5 呼叫時機②）。
   *
   * 用「請求前檢查」而不是背景定時器：SDK 也跑在 Node 裡，一個長駐 timer 會讓行程關不掉；
   * 而瀏覽器分頁進背景時 setTimeout 本來就會被節流到分鐘級，定時器並不比這個可靠。
   * 真正需要新 Session 的時刻就是下一個請求，那時換最準，也不會在閒置分頁上白燒票。
   */
  function needsRenewal(): boolean {
    return !!sessionToken && sessionExpiresAt !== null && Date.now() >= sessionExpiresAt - RENEW_LEAD_MS;
  }

  let refreshInFlight: Promise<boolean> | null = null;
  function tryRefresh(): Promise<boolean> {
    if (!refreshInFlight) refreshInFlight = performRefresh().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function performRefresh(): Promise<boolean> {
    if (!tokens?.refreshToken) return false;
    const res = await fetch(`${AUTH}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.key ? { 'x-api-key': options.key } : {}) },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => ({}))) as { data?: Tokens };
    if (!json.data?.accessToken) return false;
    tokens = json.data;
    return true;
  }

  /**
   * 受保護請求：自動帶憑證；無憑證時先用 Assertion 換發 Session；遇 401 各重試一次。
   *
   * 兩條路徑的重試方式不同：JWT 走 refresh，Session 沒有 refresh（規格 §7.1），
   * 改為重走 token provider——撤銷 `kid`、依 `sub` 作廢都會讓 Session 提早失效，
   * 使用者在貴方系統仍登入的話，換一張就接回去了。
   */
  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!sessionToken && !tokens && options.assertion) await exchangeIdentity();
    else if (needsRenewal() && canRenew()) await exchangeIdentity();
    const send = () => fetch(url, { ...init, headers: { ...baseHeaders(!(init.body instanceof FormData)), ...(init.headers as Record<string, string>) } });
    const sentToken = tokens?.accessToken;
    const sentSession = sessionToken;
    let res = await send();
    if (res.status === 401 && !sessionToken && (tokens?.accessToken !== sentToken || await tryRefresh())) {
      res = await send();
    }
    if (res.status === 401 && sessionToken && canRenew() && (sessionToken !== sentSession || await exchangeIdentity())) {
      res = await send();
    }
    return unwrap<T>(res);
  }

  return {
    async authenticate(): Promise<void> {
      await exchangeIdentity();
    },

    refreshIdentity(): Promise<boolean> {
      return exchangeIdentity();
    },

    async logout(): Promise<void> {
      const token = sessionToken;
      sessionToken = null;
      sessionExpiresAt = null;
      tokens = null;
      // 帳密登入的 JWT 無狀態，沒有要通知的對象；Session 則必須讓後端作廢。
      if (!token) return;
      await fetch(`${AUTH}/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...(options.key ? { 'x-api-key': options.key } : {}) },
      }).catch(() => {
        // 網路不通時本地已清乾淨，剩下那張票會自己過期——不值得讓呼叫端收到例外
      });
    },

    conversations: {
      create(input = {}): Promise<TurnData> {
        const body: Record<string, unknown> = {};
        if (input.message) body.message = input.message;
        if (input.formId) body.formId = input.formId;
        return request<TurnData>(CONV, { method: 'POST', body: JSON.stringify(body) });
      },
      sendMessage(id, message): Promise<TurnData> {
        return request<TurnData>(`${CONV}/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        });
      },
      submit(id): Promise<TurnData> {
        return request<TurnData>(`${CONV}/${id}/submit`, { method: 'POST' });
      },
      updateFields(id, fields): Promise<UpdateFieldsData> {
        return request<UpdateFieldsData>(`${CONV}/${id}/fields`, {
          method: 'PATCH',
          body: JSON.stringify({ fields }),
        });
      },
      get(id): Promise<ConversationState> {
        return request<ConversationState>(`${CONV}/${id}`);
      },
      cancel(id): Promise<{ id: string; status: SessionStatus }> {
        return request<{ id: string; status: SessionStatus }>(`${CONV}/${id}/cancel`, {
          method: 'POST',
        });
      },
    },

    forms: {
      list(): Promise<FormSummary[]> {
        return request<FormSummary[]>(FORMS);
      },
      get(formId): Promise<Definition> {
        return request<Definition>(`${FORMS}/${formId}`);
      },
    },

    on(event, handler): () => void {
      const name = `oa-agent:${event}`;
      const listener = (e: Event) => handler((e as CustomEvent).detail);
      window.addEventListener(name, listener);
      return () => window.removeEventListener(name, listener);
    },

    open(): void {
      window.OAAgent?.open?.();
    },
    close(): void {
      window.OAAgent?.close?.();
    },
    toggle(): void {
      window.OAAgent?.toggle?.();
    },

    loadWidget(): void {
      // 對外路徑固定 /sdk/widget.js（規格 §7.2 定稿）：不含版本號的單一可變路徑，
      // 由 HyAgent 就地更新推送修補，快取上限 5 分鐘。
      const src = options.widgetSrc ?? `${apiBase}/sdk/widget.js`;
      if (document.querySelector(`script[src="${src}"]`)) return;
      const el = document.createElement('script');
      el.src = src;
      if (options.key) el.setAttribute('data-key', options.key);
      // 靜態 token 不再注入：Assertion 只有 60 秒有效且一次性，寫死在 script 標籤上的那張
      // 到使用者真的點開面板時多半已失效或已用過（規格 §6.5）。widget 改向 tokenUrl 現取。
      if (options.tokenUrl) el.setAttribute('data-token-url', options.tokenUrl);
      document.body.appendChild(el);
    },
  };
}
