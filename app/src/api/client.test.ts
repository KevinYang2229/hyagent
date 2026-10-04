import { createApiClient, type TokenStore, type Tokens } from './client';
import { normalizeServerUrl } from './config';
import { ApiError } from './errors';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function memoryTokens(initial: Tokens | null = { accessToken: 'a1', refreshToken: 'r1' }): TokenStore & { value: Tokens | null } {
  const s = {
    value: initial,
    async get() { return s.value; },
    async set(t: Tokens) { s.value = t; },
    async clear() { s.value = null; },
  };
  return s;
}

const auth = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

describe('normalizeServerUrl', () => {
  it.each([
    ['http://192.168.1.5:3000/', 'http://192.168.1.5:3000'],
    ['  https://api.example.com//  ', 'https://api.example.com'],
    ['192.168.1.5:3000', 'http://192.168.1.5:3000'],
    ['', ''],
  ])('%s → %s', (raw, out) => expect(normalizeServerUrl(raw)).toBe(out));
});

describe('createApiClient', () => {
  it('組出 /api 路徑、帶 Bearer、回傳 data', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    const api = createApiClient({ baseUrl: () => 'http://h', tokens: memoryTokens(), fetchFn: f.fn });
    await expect(api.request('/x', { method: 'POST', json: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(f.calls[0].url).toBe('http://h/api/x');
    expect(auth(f.calls[0].init)).toBe('Bearer a1');
    expect(f.calls[0].init.body).toBe('{"a":1}');
  });

  it('auth:false 不帶 token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: 1 } }));
    const api = createApiClient({ baseUrl: () => 'http://h', tokens: memoryTokens(), fetchFn: f.fn });
    await api.request('/auth/login', { method: 'POST', json: {}, auth: false });
    expect(auth(f.calls[0].init)).toBeUndefined();
  });

  it('錯誤回應轉成 ApiError（狀態、code、訊息）', async () => {
    const f = fakeFetch(() => ({ status: 422, body: { error: { code: 'ACTION_INPUT_INVALID', message: '數量太大' } } }));
    const api = createApiClient({ baseUrl: () => 'http://h', tokens: memoryTokens(), fetchFn: f.fn });
    const err = await api.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'ACTION_INPUT_INVALID', message: '數量太大' });
  });

  it('網路失敗 → ApiError status 0 / NETWORK；沒設定伺服器 → NO_SERVER', async () => {
    const down = jest.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: () => 'http://h', tokens: memoryTokens(), fetchFn: down });
    await expect(api.request('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    const none = createApiClient({ baseUrl: () => '', tokens: memoryTokens(), fetchFn: down });
    await expect(none.request('/x')).rejects.toMatchObject({ status: 0, code: 'NO_SERVER' });
  });

  it('401 → 換發一次後用新 token 重試；上傳類請求重新建立 FormData', async () => {
    const tokens = memoryTokens();
    const f = fakeFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { data: { accessToken: 'a2', refreshToken: 'r2' } } };
      return auth(init) === 'Bearer a2' ? { status: 200, body: { data: 'ok' } } : { status: 401, body: { error: { code: 'UNAUTHORIZED' } } };
    });
    const form = jest.fn(() => ({ fake: 'form' }) as unknown as FormData);
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn });
    await expect(api.request('/upload', { method: 'POST', form })).resolves.toBe('ok');
    expect(form).toHaveBeenCalledTimes(2);
    expect(tokens.value).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(JSON.parse(f.calls.find((c) => c.url.endsWith('/auth/refresh'))!.init.body as string)).toEqual({ refreshToken: 'r1' });
  });

  it('兩個請求同時 401 → 只換發一次，兩個都成功', async () => {
    let refreshes = 0;
    const tokens = memoryTokens();
    const f = fakeFetch(async (url, init) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return { status: 200, body: { data: { accessToken: 'a2', refreshToken: 'r2' } } };
      }
      return auth(init) === 'Bearer a2' ? { status: 200, body: { data: url } } : { status: 401 };
    });
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn });
    const [a, b] = await Promise.all([api.request('/a'), api.request('/b')]);
    expect([a, b]).toEqual(['http://h/api/a', 'http://h/api/b']);
    expect(refreshes).toBe(1);
  });

  it('換發失敗 → 清掉 token、通知登出、丟 401', async () => {
    const tokens = memoryTokens();
    const onAuthLost = jest.fn();
    const f = fakeFetch(() => ({ status: 401 }));
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn, onAuthLost });
    await expect(api.request('/x')).rejects.toMatchObject({ status: 401 });
    expect(tokens.value).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('換發遇到網路錯誤 → 保留 token、不登出、丟 NETWORK', async () => {
    const tokens = memoryTokens();
    const onAuthLost = jest.fn();
    const fn = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) throw new TypeError('Network request failed');
      return { status: 401, ok: false, json: async () => null } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: fn, onAuthLost });
    await expect(api.request('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    expect(tokens.value).toEqual({ accessToken: 'a1', refreshToken: 'r1' });
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('換發回 500 → 保留 token、不登出、丟 500', async () => {
    const tokens = memoryTokens();
    const onAuthLost = jest.fn();
    const f = fakeFetch((url) => (url.endsWith('/auth/refresh') ? { status: 500 } : { status: 401 }));
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn, onAuthLost });
    await expect(api.request('/x')).rejects.toMatchObject({ status: 500 });
    expect(tokens.value).toEqual({ accessToken: 'a1', refreshToken: 'r1' });
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('兩個請求同時 401 且換發被拒 → 只登出一次，兩個都丟 401', async () => {
    const tokens = memoryTokens();
    const onAuthLost = jest.fn();
    const f = fakeFetch(async (url) => {
      if (url.endsWith('/auth/refresh')) await new Promise((r) => setTimeout(r, 5));
      return { status: 401 };
    });
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn, onAuthLost });
    const results = await Promise.allSettled([api.request('/a'), api.request('/b')]);
    expect(results.map((r) => r.status === 'rejected' && (r.reason as ApiError).status)).toEqual([401, 401]);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(tokens.value).toBeNull();
  });

  it('401 回來時 token 已被別的請求換發 → 直接用新 token 重送，不再換發', async () => {
    const tokens = memoryTokens();
    let refreshes = 0;
    const f = fakeFetch(async (url, init) => {
      if (url.endsWith('/auth/refresh')) { refreshes++; return { status: 200, body: { data: { accessToken: 'a2', refreshToken: 'r2' } } }; }
      if (url.endsWith('/slow')) {
        await new Promise((r) => setTimeout(r, 20));
        return auth(init) === 'Bearer a2' ? { status: 200, body: { data: 'slow-ok' } } : { status: 401 };
      }
      return auth(init) === 'Bearer a2' ? { status: 200, body: { data: 'fast-ok' } } : { status: 401 };
    });
    const api = createApiClient({ baseUrl: () => 'http://h', tokens, fetchFn: f.fn });
    const [slow, fast] = await Promise.all([api.request('/slow'), api.request('/fast')]);
    expect([slow, fast]).toEqual(['slow-ok', 'fast-ok']);
    expect(refreshes).toBe(1);
  });
});
