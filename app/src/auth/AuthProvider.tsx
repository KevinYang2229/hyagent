/**
 * 登入狀態與 API：token 存安全儲存區，啟動時以 /auth/me 還原；任何請求換發失敗即登出。
 * api 的伺服器位址讀最新設定（ref），不因修改設定而重建。
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Applicant } from '@hyagent/shared';
import { createApiClient, type TokenStore } from '@/api/client';
import { createEndpoints, type Endpoints } from '@/api/endpoints';
import { normalizeServerUrl } from '@/api/config';
import { ApiError } from '@/api/errors';
import { secureTokenStore } from '@/api/secureTokens';
import { useSettings } from '@/settings/SettingsProvider';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  user: Applicant | null;
  api: Endpoints;
  login(username: string, password: string, serverUrl?: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  tokenStore = secureTokenStore,
  fetchFn,
}: {
  children: ReactNode;
  tokenStore?: TokenStore;
  fetchFn?: typeof fetch;
}) {
  const { ready, serverUrl } = useSettings();
  const queryClient = useQueryClient();
  const urlRef = useRef(serverUrl);
  urlRef.current = serverUrl;
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<Applicant | null>(null);

  const api = useMemo(
    () =>
      createEndpoints(
        createApiClient({
          baseUrl: () => urlRef.current,
          tenantApiKey: () => process.env.EXPO_PUBLIC_TENANT_API_KEY ?? '',
          tokens: tokenStore,
          fetchFn,
          onAuthLost: () => {
            queryClient.clear();
            setUser(null);
            setStatus('signedOut');
          },
        }),
      ),
    [tokenStore, fetchFn, queryClient],
  );

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      let tokens;
      try {
        tokens = await tokenStore.get();
      } catch {
        if (alive) setStatus('signedOut');
        return;
      }
      if (!tokens || !urlRef.current) {
        if (alive) setStatus('signedOut');
        return;
      }
      try {
        const me = await api.me();
        if (!alive) return;
        setUser(me);
        setStatus('signedIn');
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) await tokenStore.clear();
        setStatus('signedOut');
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, api, tokenStore]);

  const login = useCallback(
    async (username: string, password: string, serverUrl?: string) => {
      // 剛改完伺服器位址時，state 尚未重繪，直接同步寫入 ref 以免請求打到舊位址
      if (serverUrl !== undefined) urlRef.current = normalizeServerUrl(serverUrl);
      const res = await api.login(username, password);
      await tokenStore.set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      setUser(res.user);
      setStatus('signedIn');
    },
    [api, tokenStore],
  );

  const logout = useCallback(async () => {
    await tokenStore.clear();
    queryClient.clear();
    setUser(null);
    setStatus('signedOut');
  }, [tokenStore, queryClient]);

  const value = useMemo(() => ({ status, user, api, login, logout }), [status, user, api, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用');
  return v;
}

export function useApi(): Endpoints {
  return useAuth().api;
}
