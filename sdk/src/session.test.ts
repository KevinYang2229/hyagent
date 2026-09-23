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
  let valid = '';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    inits.push(init ?? {});
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
  return { calls, inits, revoke: () => { valid = '__revoked__'; } };
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
