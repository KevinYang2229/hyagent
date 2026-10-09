import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TokenStore, Tokens } from '@hyagent/app-core/api/client';
import { SettingsProvider, type KeyValueStore } from '@hyagent/app-core/settings/SettingsProvider';
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

async function setup(tokens: TokenStore, fetchFn: typeof fetch, qc = new QueryClient(), mode: 'account' | 'guest' = 'account') {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <SettingsProvider store={kv} defaultServerUrl="http://h">
        <AuthProvider tokenStore={tokens} fetchFn={fetchFn} mode={mode}>{children}</AuthProvider>
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

  it('tokenStore.get 丟錯 → signedOut', async () => {
    const tokens = { ...memoryTokens(null), async get(): Promise<Tokens | null> { throw new Error('keychain'); } };
    const { result } = await setup(tokens, fetchFrom(() => ({ status: 404 })));
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
  });

  it('強制登出（換發 401）也清空 React Query 快取', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['notifications'], { unreadCount: 3 });
    const tokens = memoryTokens({ accessToken: 'a', refreshToken: 'r' });
    const { result } = await setup(tokens, fetchFrom(() => ({ status: 401 })), qc);
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(qc.getQueryData(['notifications'])).toBeUndefined();
  });

  it('改完伺服器位址後立即登入，請求打到新位址', async () => {
    const fetchFn = fetchFrom((url) =>
      url.endsWith('/auth/login') ? { status: 200, body: { data: { accessToken: 'a', refreshToken: 'r', user: USER } } } : { status: 404 },
    );
    const { result } = await setup(memoryTokens(null), fetchFn);
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.login('kevin', 'pw', '192.168.1.9:3000/'));
    const url = (fetchFn as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url.startsWith('http://192.168.1.9:3000/')).toBe(true);
  });

  describe('訪客模式', () => {
    const GUEST_USER = { id: 'guest_x', name: '訪客', department: '—' };
    const session = { sessionToken: 'hyas_g', expiresIn: 3600, user: { sub: 'guest_x', name: '訪客' } };

    it('沒有 token → 自動換發訪客 Session 並 signedIn，不需要登入', async () => {
      const tokens = memoryTokens(null);
      const fetchFn = fetchFrom((url) =>
        url.endsWith('/auth/guest') ? { status: 201, body: { data: session } } : url.endsWith('/auth/me') ? { status: 200, body: { data: GUEST_USER } } : { status: 404 },
      );
      const { result } = await setup(tokens, fetchFn, new QueryClient(), 'guest');
      await waitFor(() => expect(result.current.status).toBe('signedIn'));
      expect(result.current.user).toEqual(GUEST_USER);
      expect(tokens.value).toEqual({ accessToken: 'hyas_g', refreshToken: '' });
      expect(result.current.error).toBeNull();
    });

    it('租戶未開放訪客 → signedOut 並說明原因；開放後 connect() 重試成功', async () => {
      let open = false;
      const fetchFn = fetchFrom((url) => {
        if (url.endsWith('/auth/guest')) return open ? { status: 201, body: { data: session } } : { status: 403, body: { error: { code: 'GUEST_ACCESS_DISABLED', message: 'x' } } };
        return url.endsWith('/auth/me') ? { status: 200, body: { data: GUEST_USER } } : { status: 404 };
      });
      const { result } = await setup(memoryTokens(null), fetchFn, new QueryClient(), 'guest');
      await waitFor(() => expect(result.current.status).toBe('signedOut'));
      expect(result.current.error).toBe('此服務目前未開放訪客使用，請聯絡管理員。');
      open = true;
      await act(() => result.current.connect());
      expect(result.current.status).toBe('signedIn');
      expect(result.current.error).toBeNull();
    });

    it.each([
      [404, undefined, '伺服器版本尚未支援訪客使用，請更新後端。'],
      [500, 'INTERNAL_SERVER_ERROR', '伺服器暫時無法提供服務，請稍後再試。'],
    ])('換發回 %s → 顯示易懂的原因，不露出後端錯誤原文', async (status, code, message) => {
      const fetchFn = fetchFrom(() => ({ status, body: { error: { code, message: 'Invalid `db.authSessionRow.create()` …' } } }));
      const { result } = await setup(memoryTokens(null), fetchFn, new QueryClient(), 'guest');
      await waitFor(() => expect(result.current.status).toBe('signedOut'));
      expect(result.current.error).toBe(message);
    });
  });
});
