/**
 * API 請求包裝：組網址、帶 token、逾時、錯誤轉 ApiError。
 * 401 時以 refresh token 換發一次（同時多個請求共用同一次換發），成功後重送；失敗則清 token 並通知登出。
 * 上傳用 form 工廠：重送時重新建立 FormData，不重用已送出的 body。
 */
import { ApiError } from './errors';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  json?: unknown;
  form?: () => FormData;
  /** false：不帶 token、401 不換發（登入、換發本身） */
  auth?: boolean;
  timeoutMs?: number;
}

export interface ApiClient {
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
}

export interface ApiClientDeps {
  baseUrl: () => string;
  tokens: TokenStore;
  fetchFn?: typeof fetch;
  onAuthLost?: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  let refreshing: Promise<boolean> | null = null;

  async function send(path: string, opts: RequestOptions, accessToken?: string): Promise<Response> {
    const base = deps.baseUrl();
    if (!base) throw new ApiError('尚未設定伺服器位址', 0, 'NO_SERVER');
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form();
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (accessToken && opts.auth !== false) headers.Authorization = `Bearer ${accessToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await fetchFn(`${base}/api${path}`, {
        method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string }).name === 'AbortError';
      throw new ApiError(aborted ? '連線逾時，請再試一次' : '無法連線到伺服器，請檢查網路', 0, aborted ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 換發 token。只有 refresh token 被明確拒絕（401／403）或本機沒有 token 才算失敗並登出；
   * 網路、逾時、5xx 等暫時性錯誤保留 token 並丟 ApiError，讓呼叫端可重試。
   * 清 token 與通知登出都在這裡（單一共用的換發結果）做一次，同時等待的請求不會重複觸發。
   */
  async function doRefresh(): Promise<boolean> {
    const tokens = await deps.tokens.get();
    if (!tokens) return false;
    const res = await send('/auth/refresh', { method: 'POST', json: { refreshToken: tokens.refreshToken }, auth: false });
    if (res.status === 401 || res.status === 403) {
      await deps.tokens.clear();
      deps.onAuthLost?.();
      return false;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new ApiError(body?.error?.message ?? `伺服器錯誤（${res.status}）`, res.status, body?.error?.code, body?.error?.details);
    }
    const body = (await res.json().catch(() => null)) as { data?: Tokens } | null;
    if (!body?.data?.accessToken || !body.data.refreshToken) {
      throw new ApiError('換發回應格式不正確', res.status, 'BAD_REFRESH_RESPONSE');
    }
    await deps.tokens.set({ accessToken: body.data.accessToken, refreshToken: body.data.refreshToken });
    return true;
  }

  function refreshOnce(): Promise<boolean> {
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as
      | { data?: T; error?: { code?: string; message?: string; details?: unknown } }
      | null;
    if (!res.ok) {
      throw new ApiError(body?.error?.message ?? `伺服器錯誤（${res.status}）`, res.status, body?.error?.code, body?.error?.details);
    }
    return body?.data as T;
  }

  return {
    async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const tokens = opts.auth === false ? null : await deps.tokens.get();
      let res = await send(path, opts, tokens?.accessToken);
      if (res.status === 401 && tokens) {
        // 別的請求可能已換發完成：token 已不同就直接用新的重送，不再換發
        const current = await deps.tokens.get();
        const ok = current && current.accessToken !== tokens.accessToken ? true : await refreshOnce();
        if (ok) {
          const next = await deps.tokens.get();
          res = await send(path, opts, next?.accessToken);
        }
      }
      return parse<T>(res);
    },
  };
}
