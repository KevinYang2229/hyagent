// @vitest-environment jsdom
/**
 * HyAgent Session 的續期與結束（規格 §6.5 呼叫時機②、§6.3 的 refreshIdentity / logout、§7.1）。
 *
 * SSO 路徑沒有 refresh token，續期一律是「重走 token provider 換一張新的 Assertion」。
 * 這裡釘的是三件會被誤設計的事：續期會真的發生、同時湧入的請求只換一次、
 * 以及登出要通知後端（Session 是伺服器端有狀態的，只清瀏覽器等於留一張可用的票）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const FAR_FUTURE = () => String(Date.now() + 3_600_000);

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

/** 假後端：/sso/exchange 依序發 token，其餘端點只接受目前有效的那一張 */
function stubBackend(opts: { valid: string; issue: string[]; expiresIn?: number }) {
  const calls = { exchange: 0, protected: 0, logout: 0 };
  let valid = opts.valid;
  const bodies: unknown[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      inits.push(init ?? {});
      if (url.endsWith('/sso/exchange')) {
        bodies.push(JSON.parse(String(init?.body)));
        valid = opts.issue[Math.min(calls.exchange, opts.issue.length - 1)];
        calls.exchange++;
        return Response.json({ data: { sessionToken: valid, expiresIn: opts.expiresIn ?? 3600 } });
      }
      if (url.endsWith('/auth/logout')) {
        calls.logout++;
        return new Response(null, { status: 204 });
      }
      calls.protected++;
      return new Headers(init?.headers).get('authorization') === `Bearer ${valid}`
        ? Response.json({ data: { id: 'u1' } })
        : new Response('{}', { status: 401 });
    }),
  );
  return { calls, bodies, inits };
}

it('請求前發現 Session 剩不到 60 秒 → 先重走 provider 換一張再送出', async () => {
  // 定時器在背景分頁會被節流、筆電闔上更是整段不跑，所以請求路徑上必須自己補這一刀
  sessionStorage.setItem('oa-session-token', 'hyas_old');
  sessionStorage.setItem('oa-session-expires', String(Date.now() + 30_000));
  const { calls } = stubBackend({ valid: 'hyas_old', issue: ['hyas_new'] });

  const { auth, setIdentityProvider } = await import('./api');
  setIdentityProvider(async () => 'assertion-1');
  await auth.me();

  expect(calls.exchange).toBe(1);
  expect(sessionStorage.getItem('oa-session-token')).toBe('hyas_new');
});

it('到期前 60 秒定時觸發，使用者沒有任何動作也會換到新的 Session', async () => {
  vi.useFakeTimers();
  sessionStorage.setItem('oa-session-token', 'hyas_old');
  sessionStorage.setItem('oa-session-expires', String(Date.now() + 3_600_000));
  const { calls } = stubBackend({ valid: 'hyas_old', issue: ['hyas_new'] });

  const { setIdentityProvider } = await import('./api');
  setIdentityProvider(async () => 'assertion-1');

  await vi.advanceTimersByTimeAsync(3_539_000); // 到期前 61 秒
  expect(calls.exchange).toBe(0);
  await vi.advanceTimersByTimeAsync(2_000); // 跨過 60 秒門檻
  expect(calls.exchange).toBe(1);
  expect(sessionStorage.getItem('oa-session-token')).toBe('hyas_new');
});

it('同時湧入的請求只換一次票——Assertion 是一次性的，換兩次第二張必被 TOKEN_REPLAYED 拒絕', async () => {
  sessionStorage.setItem('oa-session-token', 'hyas_old');
  sessionStorage.setItem('oa-session-expires', String(Date.now() + 10_000));
  const { calls } = stubBackend({ valid: 'hyas_old', issue: ['hyas_new'] });

  const { auth, setIdentityProvider } = await import('./api');
  let issued = 0;
  setIdentityProvider(async () => `assertion-${++issued}`);
  await Promise.all([auth.me(), auth.me(), auth.me()]);

  expect(calls.exchange).toBe(1);
  expect(issued).toBe(1);
});

it('Session 被後端作廢（撤銷 kid / 依 sub 作廢）→ 401 當場重走 provider 接回去', async () => {
  sessionStorage.setItem('oa-session-token', 'hyas_revoked');
  sessionStorage.setItem('oa-session-expires', FAR_FUTURE());
  // valid 設成別的值 → 舊 token 一律 401，等同後端已作廢
  const { calls } = stubBackend({ valid: 'hyas_none', issue: ['hyas_new'] });

  const { auth, setIdentityProvider } = await import('./api');
  setIdentityProvider(async () => 'assertion-1');
  await expect(auth.me()).resolves.toEqual({ id: 'u1' });

  expect(calls.exchange).toBe(1);
  expect(sessionStorage.getItem('oa-session-token')).toBe('hyas_new');
});

it('provider 拿不到票（使用者已從宿主網站登出）→ 不重試不空轉，落到登出處理', async () => {
  sessionStorage.setItem('oa-session-token', 'hyas_revoked');
  sessionStorage.setItem('oa-session-expires', FAR_FUTURE());
  const { calls } = stubBackend({ valid: 'hyas_none', issue: ['never'] });

  const { auth, setIdentityProvider, setUnauthorizedHandler } = await import('./api');
  const onUnauthorized = vi.fn();
  setUnauthorizedHandler(onUnauthorized);
  setIdentityProvider(async () => null);
  await expect(auth.me()).rejects.toThrow();

  expect(calls.exchange).toBe(0); // 沒票就不打換發端點
  expect(calls.protected).toBe(1); // 也不重送原請求
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('oa-session-token')).toBeNull();
});

it('沒有 provider（第一方直接開面板）時完全不排程續期', async () => {
  vi.useFakeTimers();
  sessionStorage.setItem('oa-session-token', 'hyas_old');
  sessionStorage.setItem('oa-session-expires', String(Date.now() + 120_000));
  const { calls } = stubBackend({ valid: 'hyas_old', issue: ['hyas_new'] });

  await import('./api');
  await vi.advanceTimersByTimeAsync(300_000);

  expect(calls.exchange).toBe(0);
});

it('登出通知後端作廢 Session，並清掉本地憑證', async () => {
  sessionStorage.setItem('oa-session-token', 'hyas_live');
  sessionStorage.setItem('oa-session-expires', FAR_FUTURE());
  const { calls, inits } = stubBackend({ valid: 'hyas_live', issue: ['x'] });

  const { auth } = await import('./api');
  auth.logout();
  await vi.waitFor(() => expect(calls.logout).toBe(1));

  const logoutInit = inits[inits.length - 1];
  expect(new Headers(logoutInit.headers).get('authorization')).toBe('Bearer hyas_live');
  // reload / 關分頁時請求會被取消，keepalive 是它還能送達的唯一理由
  expect(logoutInit.keepalive).toBe(true);
  expect(sessionStorage.getItem('oa-session-token')).toBeNull();
  expect(sessionStorage.getItem('oa-session-expires')).toBeNull();
  expect(auth.isAuthenticated()).toBe(false);
});

it('帳密登入的 JWT 登出不打 Session 端點（那條路徑無狀態，沒有要作廢的對象）', async () => {
  localStorage.setItem('oa-access-token', 'jwt');
  localStorage.setItem('oa-refresh-token', 'jwt-r');
  const { calls } = stubBackend({ valid: 'unused', issue: ['x'] });

  const { auth } = await import('./api');
  auth.logout();

  expect(calls.logout).toBe(0);
  expect(localStorage.getItem('oa-access-token')).toBeNull();
});
