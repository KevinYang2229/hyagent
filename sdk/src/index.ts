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

export interface OAAgentOptions {
  /** 租戶公開金鑰 pk_…（多租戶資料隔離；省略則後端落到預設租戶） */
  key?: string;
  /** SSO handoff：宿主後端簽發的終端使用者 token，首次請求前自動換發本系統 token */
  userToken?: string;
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
  /** 以宿主 token 換發本系統 token（headless 用；widget 流程會自動處理） */
  authenticate(): Promise<void>;
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
  /** 動態注入 widget.js（帶上本 SDK 的 key / userToken 等設定） */
  loadWidget(): void;
}

export function createOAAgent(options: OAAgentOptions = {}): OAAgentClient {
  const apiBase = (options.apiBase ?? '').replace(/\/+$/, '');
  const CONV = `${apiBase}/api/conversations`;
  const FORMS = `${apiBase}/api/forms`;
  const AUTH = `${apiBase}/api/auth`;

  let tokens: Tokens | null = null;

  function baseHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (options.key) h['x-api-key'] = options.key;
    if (tokens?.accessToken) h['authorization'] = `Bearer ${tokens.accessToken}`;
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

  async function ssoExchange(): Promise<void> {
    if (!options.userToken) return;
    const res = await fetch(`${AUTH}/sso/exchange`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({ userToken: options.userToken }),
    });
    tokens = await unwrap<Tokens>(res);
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

  /** 受保護請求：自動帶 token；無 token 時先用 SSO 換發；遇 401 嘗試 refresh 一次 */
  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!tokens && options.userToken) await ssoExchange();
    const send = () => fetch(url, { ...init, headers: { ...baseHeaders(!(init.body instanceof FormData)), ...(init.headers as Record<string, string>) } });
    const sentToken = tokens?.accessToken;
    let res = await send();
    if (res.status === 401 && (tokens?.accessToken !== sentToken || await tryRefresh())) res = await send();
    return unwrap<T>(res);
  }

  return {
    async authenticate(): Promise<void> {
      await ssoExchange();
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
      const src = options.widgetSrc ?? `${apiBase}/widget.js`;
      if (document.querySelector(`script[src="${src}"]`)) return;
      const el = document.createElement('script');
      el.src = src;
      if (options.key) el.setAttribute('data-key', options.key);
      if (options.userToken) el.setAttribute('data-user-token', options.userToken);
      document.body.appendChild(el);
    },
  };
}
