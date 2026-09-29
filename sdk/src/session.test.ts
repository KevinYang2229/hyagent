import { afterEach, expect, it, vi } from 'vitest';
import { createOAAgent } from './index';

afterEach(() => vi.unstubAllGlobals());

/**
 * SSO 路徑改為 HyAgent Session（規格 §7.1）後，refresh 輪替整套移除：
 * 續期是「重新簽發一張 Assertion」，不是換 refresh token。
 */
it('assertion 換得不透明 Session，之後每次請求都帶它', async () => {
  const seen: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/sso/exchange')) {
      expect(JSON.parse(String(init?.body))).toEqual({ assertion: 'eyJ-assertion' });
      return Response.json({ data: { sessionToken: 'hyas_abc', expiresIn: 3600 } });
    }
    seen.push((init?.headers as Record<string, string>)?.authorization ?? '');
    return Response.json({ data: [] });
  });
  vi.stubGlobal('fetch', fetch);

  const client = createOAAgent({ apiBase: 'http://localhost', assertion: 'eyJ-assertion' });
  await client.authenticate();
  await client.conversations.get('one');

  expect(seen).toEqual(['Bearer hyas_abc']);
});

it('Session 遇 401 不嘗試 refresh——那條路徑在 SSO 上已不存在', async () => {
  let refreshes = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/sso/exchange')) {
      return Response.json({ data: { sessionToken: 'hyas_expired', expiresIn: 3600 } });
    }
    if (url.endsWith('/refresh')) {
      refreshes++;
      return Response.json({ data: { accessToken: 'new', refreshToken: 'next' } });
    }
    return new Response('{}', { status: 401 });
  });
  vi.stubGlobal('fetch', fetch);

  const client = createOAAgent({ apiBase: 'http://localhost', assertion: 'eyJ-assertion' });
  await client.authenticate();
  await expect(client.conversations.get('one')).rejects.toThrow();

  expect(refreshes).toBe(0);
});

/**
 * 續期（規格 §6.5 呼叫時機②、§6.3）：SSO 路徑沒有 refresh，續期一律是重走 token provider。
 * SDK 不掛背景定時器（見 index.ts 的 needsRenewal），改在需要 Session 的那個請求上判斷。
 */
function backend(opts: { issue: string[]; expiresIn: number }) {
  const calls = { exchange: 0, protected: 0, logout: 0 };
  const inits: RequestInit[] = [];
  /** 依序記下打了哪支、帶哪個 Bearer，例如 `logout hyas_1`。用來釘「先作廢再換發」的順序。 */
  const log: string[] = [];
  let valid = '';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    inits.push(init ?? {});
    const bearer = ((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    log.push(`${url.split('/').pop()} ${bearer}`.trim());
    if (url.endsWith('/sso/exchange')) {
      valid = opts.issue[Math.min(calls.exchange, opts.issue.length - 1)];
      calls.exchange++;
      return Response.json({ data: { sessionToken: valid, expiresIn: opts.expiresIn } });
    }
    if (url.endsWith('/logout')) {
      calls.logout++;
      return new Response(null, { status: 204 });
    }
    calls.protected++;
    return (init?.headers as Record<string, string>)?.authorization === `Bearer ${valid}`
      ? Response.json({ data: {} })
      : new Response('{}', { status: 401 });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, inits, log, revoke: () => { valid = '__revoked__'; } };
}

it('Session 剩不到 60 秒 → 下一個請求前先重走 provider', async () => {
  const { calls } = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 30 }); // 一發下來就在門檻內
  let issued = 0;
  const client = createOAAgent({
    apiBase: 'http://localhost',
    assertion: () => `assertion-${++issued}`,
  });

  await client.authenticate();
  await client.conversations.get('one');

  expect(calls.exchange).toBe(2); // 首次換發 + 續期
  expect(issued).toBe(2); // 每次都現簽一張新的，不重送同一張
  expect(calls.protected).toBe(1); // 續期發生在請求之前，沒有多餘的 401 往返
});

it('Session 有效期充裕時不會白白續期', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.authenticate();
  await client.conversations.get('one');
  await client.conversations.get('two');

  expect(calls.exchange).toBe(1);
});

it('Session 被後端作廢 → 401 當場重走 provider 並重試', async () => {
  const b = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.authenticate();
  b.revoke();
  await expect(client.conversations.get('one')).resolves.toEqual({});

  expect(b.calls.exchange).toBe(2);
  expect(b.calls.protected).toBe(2); // 第一次 401、換票後第二次成功
});

it('靜態字串形式的 assertion 不會被重送——它是一次性的', async () => {
  const b = backend({ issue: ['hyas_1'], expiresIn: 30 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: 'eyJ-static' });

  await client.authenticate();
  b.revoke();
  await expect(client.conversations.get('one')).rejects.toThrow();

  expect(b.calls.exchange).toBe(1);
  await expect(client.refreshIdentity()).resolves.toBe(false);
});

it('provider 回 null（使用者已從貴方系統登出）→ refreshIdentity 回 false，不打換發端點', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => null });

  await expect(client.refreshIdentity()).resolves.toBe(false);
  expect(calls.exchange).toBe(0);
});

it('logout 通知後端作廢 Session，之後的請求會重新換發', async () => {
  const { calls, inits } = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', key: 'pk_test', assertion: () => 'assertion' });

  await client.authenticate();
  await client.logout();

  expect(calls.logout).toBe(1);
  const logoutInit = inits[inits.length - 1];
  expect((logoutInit.headers as Record<string, string>).authorization).toBe('Bearer hyas_1');
  expect((logoutInit.headers as Record<string, string>)['x-api-key']).toBe('pk_test');

  await client.conversations.get('one');
  expect(calls.exchange).toBe(2);
});

it('logout 等在途的換發落地後一併作廢——否則登出會被那張換回來的 Session 蓋回去', async () => {
  const { calls, log } = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: async () => 'assertion' });

  void client.authenticate(); // 還沒換完就登出
  await client.logout();

  expect(log).toEqual(['exchange', 'logout hyas_1']);
  await client.conversations.get('one');
  expect(calls.exchange).toBe(2); // 登出後沒有殘留 Session，得重新換發
});

/**
 * 換人（規格 §6.3、§5.5）：先作廢舊的再換新的。只換不作廢，前一位的 Session 會在後端活到自然過期。
 */
it('refreshIdentity 先作廢舊 Session 再換新的', async () => {
  const { log } = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.authenticate();
  await expect(client.refreshIdentity()).resolves.toBe(true);
  await client.conversations.get('one');

  expect(log).toEqual(['exchange', 'logout hyas_1', 'exchange', 'one hyas_2']);
});

it('refreshIdentity 時 provider 回 null → 舊的照樣作廢，回 false', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  let loggedIn = true;
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => (loggedIn ? 'assertion' : null) });

  await client.authenticate();
  loggedIn = false;
  await expect(client.refreshIdentity()).resolves.toBe(false);

  expect(calls.logout).toBe(1);
});

/**
 * 內建 widget（規格 §6.3）：它的 Session 在面板網域，SDK 實例碰不到，只能轉請 `window.OAAgent`。
 * 以 `loadWidget()` 載入時整合方最自然的寫法就是 `oa.logout()`，漏轉等於沒登出，而且看不出來。
 */
function stubWidget(overrides: Partial<Record<'logout' | 'refreshIdentity', () => Promise<boolean>>> = {}) {
  const widget = {
    logout: vi.fn(overrides.logout ?? (async () => true)),
    refreshIdentity: vi.fn(overrides.refreshIdentity ?? (async () => true)),
  };
  vi.stubGlobal('window', { OAAgent: widget });
  return widget;
}

it('widget 橋接：logout 轉請面板作廢，並等它完成才 resolve', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  let ack!: (ok: boolean) => void;
  const widget = stubWidget({ logout: () => new Promise<boolean>((resolve) => (ack = resolve)) });
  const client = createOAAgent({ apiBase: 'http://localhost', key: 'pk_test', tokenUrl: '/api/mybot/identity' });

  let done = false;
  const pending = client.logout().then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  expect(widget.logout).toHaveBeenCalledTimes(1);
  expect(done).toBe(false); // 面板還沒回報，導頁就得再等

  ack(true);
  await pending;
  expect(calls.logout).toBe(0); // 本實例沒有自己的 Session，不必打後端
});

it('headless 與 widget 並存：logout 兩邊都作廢', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  const widget = stubWidget();
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.authenticate();
  await client.logout();

  expect(calls.logout).toBe(1);
  expect(widget.logout).toHaveBeenCalledTimes(1);
});

it('widget 的 logout 失敗（reject 或同步丟例外）不會讓 oa.logout() reject', async () => {
  backend({ issue: ['hyas_1'], expiresIn: 3600 });
  stubWidget({ logout: () => Promise.reject(new Error('panel gone')) });
  await expect(createOAAgent({ apiBase: 'http://localhost' }).logout()).resolves.toBeUndefined();

  stubWidget({
    logout: () => {
      throw new Error('boom');
    },
  });
  await expect(createOAAgent({ apiBase: 'http://localhost' }).logout()).resolves.toBeUndefined();
});

it('widget 橋接：refreshIdentity 轉給面板，回它的結果，不打換發端點', async () => {
  const { calls } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  const widget = stubWidget({ refreshIdentity: async () => false });
  const client = createOAAgent({ apiBase: 'http://localhost', tokenUrl: '/api/mybot/identity' });

  await expect(client.refreshIdentity()).resolves.toBe(false);
  expect(widget.refreshIdentity).toHaveBeenCalledTimes(1);
  expect(calls.exchange).toBe(0);

  widget.refreshIdentity.mockImplementation(async () => true);
  await expect(client.refreshIdentity()).resolves.toBe(true);
});

it('headless 與 widget 並存：refreshIdentity 兩邊都換成功才回 true', async () => {
  const { calls } = backend({ issue: ['hyas_1', 'hyas_2'], expiresIn: 3600 });
  stubWidget({ refreshIdentity: async () => false });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.authenticate();
  await expect(client.refreshIdentity()).resolves.toBe(false); // 面板沒換到，整體就不算換成功

  expect(calls.logout).toBe(1);
  expect(calls.exchange).toBe(2); // 本實例這側照樣先作廢再換
});

it('me() 帶著 Session 打 /api/auth/me，還沒換發時先走一次 provider', async () => {
  const { log } = backend({ issue: ['hyas_1'], expiresIn: 3600 });
  const client = createOAAgent({ apiBase: 'http://localhost', assertion: () => 'assertion' });

  await client.me();

  expect(log).toEqual(['exchange', 'me hyas_1']);
});
