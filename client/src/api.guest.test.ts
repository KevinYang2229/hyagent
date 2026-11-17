// @vitest-environment jsdom
/**
 * 訪客 Session：租戶開放訪客免登入時，widget 以 pk_ 換一張訪客 Session 直接進聊天。
 * 員工改用帳密登入後，訪客那張票要丟掉並通知後端作廢——Session 優先於 JWT，
 * 留著的話登入後的請求仍會以訪客身分送出（看不到員工才有的出處與功能）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./embedConfig', () => ({ embedConfig: { apiKey: 'pk_test_tenant' } }));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function headerOf(call: unknown, name: string): string | null {
  const init = (call as [string, RequestInit])[1];
  return new Headers(init?.headers).get(name);
}

it('guest() 以租戶金鑰換訪客 Session，之後的請求帶這張 Session', async () => {
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/auth/guest')
    ? Response.json({ data: { sessionToken: 'hyas_guest', expiresIn: 3600, user: { sub: 'guest_1', name: '訪客' } } })
    : Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const { auth, api } = await import('./api');
  await auth.guest();
  expect(auth.isAuthenticated()).toBe(true);
  await api.listTasks();
  const [guestCall, taskCall] = fetchMock.mock.calls;
  expect(guestCall[0]).toMatch(/\/api\/auth\/guest$/);
  expect((guestCall as unknown as [string, RequestInit])[1].method).toBe('POST');
  expect(headerOf(guestCall, 'x-api-key')).toBe('pk_test_tenant');
  expect(headerOf(taskCall, 'authorization')).toBe('Bearer hyas_guest');
});

it('guest() 失敗（租戶關閉訪客）→ 丟錯、不留憑證', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(
    { error: { code: 'GUEST_ACCESS_DISABLED', message: '此租戶未開放訪客使用' } }, { status: 403 },
  )));
  const { auth } = await import('./api');
  await expect(auth.guest()).rejects.toThrow('此租戶未開放訪客使用');
  expect(auth.isAuthenticated()).toBe(false);
});

it('訪客改用員工登入：之後的請求帶員工 JWT，訪客 Session 通知後端作廢', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/guest')) return Response.json({ data: { sessionToken: 'hyas_guest', expiresIn: 3600 } });
    if (url.endsWith('/auth/login')) return Response.json({ data: { accessToken: 'staff_jwt', refreshToken: 'r', user: { id: 'staff' } } });
    return Response.json({ data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const { auth, api } = await import('./api');
  await auth.guest();
  await auth.login('staff', 'pw');
  await api.listTasks();
  const logoutCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/auth/logout'));
  expect(logoutCall).toBeDefined();
  expect(headerOf(logoutCall, 'authorization')).toBe('Bearer hyas_guest');
  const taskCall = fetchMock.mock.calls.at(-1);
  expect(headerOf(taskCall, 'authorization')).toBe('Bearer staff_jwt');
});

it('員工登入失敗時保留訪客 Session，仍可繼續以訪客身分提問', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/guest')) return Response.json({ data: { sessionToken: 'hyas_guest', expiresIn: 3600 } });
    if (url.endsWith('/auth/login')) return Response.json({ error: { message: '帳號或密碼錯誤' } }, { status: 401 });
    return Response.json({ data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const { auth, api } = await import('./api');
  await auth.guest();
  await expect(auth.login('staff', 'wrong')).rejects.toThrow('帳號或密碼錯誤');
  await api.listTasks();
  expect(headerOf(fetchMock.mock.calls.at(-1), 'authorization')).toBe('Bearer hyas_guest');
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/logout'))).toBe(false);
});
