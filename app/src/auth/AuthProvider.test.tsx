import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TokenStore, Tokens } from '@/api/client';
import { SettingsProvider, type KeyValueStore } from '@/settings/SettingsProvider';
import { AuthProvider, useAuth } from './AuthProvider';

const USER = { id: 'kevin', name: 'Kevin Yang', department: '門市', title: '店員' };

function memoryTokens(initial: Tokens | null): TokenStore & { value: Tokens | null } {
  const s = {
    value: initial,
    async get() { return s.value; },
    async set(t: Tokens) { s.value = t; },
    async clear() { s.value = null; },
  };
  return s;
}

const kv: KeyValueStore = { async getItem() { return null; }, async setItem() {} };

function fetchFrom(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  return jest.fn(async (url: string, init: RequestInit) => {
    const r = handler(url, init);
    return { status: r.status, ok: r.status < 300, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function setup(tokens: TokenStore, fetchFn: typeof fetch) {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <SettingsProvider store={kv} defaultServerUrl="http://h">
        <AuthProvider tokenStore={tokens} fetchFn={fetchFn}>{children}</AuthProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
  return await renderHook(() => useAuth(), { wrapper });
}

describe('AuthProvider', () => {
  it('沒有 token → signedOut；登入後存 token、signedIn', async () => {
    const tokens = memoryTokens(null);
    const fetchFn = fetchFrom((url) =>
      url.endsWith('/auth/login') ? { status: 200, body: { data: { accessToken: 'a', refreshToken: 'r', user: USER } } } : { status: 404 },
    );
    const { result } = await setup(tokens, fetchFn);
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.login('kevin', 'pw'));
    expect(result.current.status).toBe('signedIn');
    expect(result.current.user).toEqual(USER);
    expect(tokens.value).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('有 token → 以 /auth/me 還原登入', async () => {
    const fetchFn = fetchFrom((url) => (url.endsWith('/auth/me') ? { status: 200, body: { data: USER } } : { status: 404 }));
    const { result } = await setup(memoryTokens({ accessToken: 'a', refreshToken: 'r' }), fetchFn);
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    expect(result.current.user).toEqual(USER);
  });

  it('token 失效且換發失敗 → signedOut、token 清除', async () => {
    const tokens = memoryTokens({ accessToken: 'a', refreshToken: 'r' });
    const { result } = await setup(tokens, fetchFrom(() => ({ status: 401 })));
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(tokens.value).toBeNull();
  });

  it('登出清 token、回到 signedOut', async () => {
    const tokens = memoryTokens({ accessToken: 'a', refreshToken: 'r' });
    const { result } = await setup(tokens, fetchFrom(() => ({ status: 200, body: { data: USER } })));
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    await act(() => result.current.logout());
    expect(result.current.status).toBe('signedOut');
    expect(tokens.value).toBeNull();
  });

  it('登入失敗 → 丟出錯誤、維持 signedOut', async () => {
    const fetchFn = fetchFrom(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: '帳號或密碼錯誤' } } }));
    const { result } = await setup(memoryTokens(null), fetchFn);
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await expect(result.current.login('kevin', 'bad')).rejects.toMatchObject({ message: '帳號或密碼錯誤' });
    expect(result.current.status).toBe('signedOut');
  });
});
