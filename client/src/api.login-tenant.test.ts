// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./embedConfig', () => ({ embedConfig: { apiKey: 'pk_test_tenant' } }));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('login and subsequent protected calls send the same tenant key', async () => {
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/login')
    ? Response.json({ data: { accessToken: 'access', refreshToken: 'refresh', user: { id: 'staff' } } })
    : Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const { auth, api } = await import('./api');
  await auth.login('staff', 'test-password');
  await api.listTasks();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(fetchMock).mock.calls) {
    const init = (call as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('x-api-key')).toBe('pk_test_tenant');
  }
});
