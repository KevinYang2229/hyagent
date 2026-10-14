import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  localStorage.setItem('oa-access-token', 'test-access');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('初次與後續查詢帶入相同取消訊號及查詢識別碼', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: { status: 'collecting', values: {}, reply: 'ok' } }));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./api');
  const controller = new AbortController();
  await api.start('u', 'hi', undefined, controller.signal, 'query-1');
  await api.sendMessage('u', 'conversation', 'hi', controller.signal, 'query-2');
  for (const [index, [, init]] of fetch.mock.calls.entries()) {
    const options = init as RequestInit;
    expect(options.signal).toBe(controller.signal);
    expect(new Headers(options.headers).get('x-query-id')).toBe(`query-${index + 1}`);
  }
  controller.abort();
  await expect(api.start('u', 'hi', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('停止通知支援 204；舊查詢停止失敗不會觸發登出', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response('{}', { status: 401 })));
  const { api, setUnauthorizedHandler } = await import('./api');
  const logout = vi.fn();
  setUnauthorizedHandler(logout);
  await expect(api.stopQuery('u', 'query')).resolves.toBeUndefined();
  await expect(api.stopQuery('u', 'query')).rejects.toMatchObject({ status: 401 });
  expect(logout).not.toHaveBeenCalled();
  expect(localStorage.getItem('oa-access-token')).toBe('test-access');
});
