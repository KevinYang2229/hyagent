/**
 * 登入狀態與 API：token 存安全儲存區，啟動時以 /auth/me 還原；任何請求換發失敗即登出。
 * api 的伺服器位址讀最新設定（ref），不因修改設定而重建。
 *
 * mode="guest"：沒有登入機制的 App（例如 LIB ONE 產品導覽）。啟動時沒有 token 就自動換發訪客
 * Session；Session 過期由 client 自動換新。失敗時停在 signedOut 並提供 error，App 用 connect() 重試。
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Applicant } from '@hyagent/shared';
import { createApiClient, type TokenStore } from '@hyagent/app-core/api/client';
import { createEndpoints, type Endpoints } from '@hyagent/app-core/api/endpoints';
import { normalizeServerUrl } from '@hyagent/app-core/api/config';
import { ApiError, errorMessage } from '@hyagent/app-core/api/errors';
import { secureTokenStore } from '@hyagent/app-core/api/secureTokens';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

export type AuthMode = 'account' | 'guest';

interface AuthContextValue {
  status: AuthStatus;
  user: Applicant | null;
  api: Endpoints;
  login(username: string, password: string, serverUrl?: string): Promise<void>;
  logout(): Promise<void>;
  /** 訪客模式：取得訪客 Session（啟動失敗後重試、換伺服器後重連）。帳密模式不使用。 */
  connect(): Promise<void>;
  /** 訪客模式最近一次連線失敗的原因；成功或重試中為 null */
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  tokenStore = secureTokenStore,
  fetchFn,
  mode = 'account',
}: {
  children: ReactNode;
  tokenStore?: TokenStore;
  fetchFn?: typeof fetch;
  mode?: AuthMode;
}) {
  const guest = mode === 'guest';
  const { ready, serverUrl } = useSettings();
  const queryClient = useQueryClient();
  const urlRef = useRef(serverUrl);
  urlRef.current = serverUrl;
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<Applicant | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useMemo(
    () =>
      createEndpoints(
        createApiClient({
          baseUrl: () => urlRef.current,
          tenantApiKey: () => process.env.EXPO_PUBLIC_TENANT_API_KEY ?? '',
          tokens: tokenStore,
          fetchFn,
          guest,
          onAuthLost: () => {
            if (guest) setError('連線已中斷，請重新連線。');
            queryClient.clear();
            setUser(null);
            setStatus('signedOut');
          },
        }),
      ),
    [tokenStore, fetchFn, queryClient, guest],
  );

  /** 換發訪客 Session 並取回身分；失敗時記下原因停在 signedOut。 */
  const connectGuest = useCallback(async (isAlive: () => boolean = () => true) => {
    setError(null);
    setStatus('loading');
    try {
      if (!urlRef.current) throw new ApiError('尚未設定伺服器位址', 0, 'NO_SERVER');
      const session = await api.guestSession();
      await tokenStore.set({ accessToken: session.sessionToken, refreshToken: '' });
      const me = await api.me();
      if (!isAlive()) return;
      setUser(me);
      setStatus('signedIn');
    } catch (e) {
      if (!isAlive()) return;
      setError(guestErrorMessage(e));
      setStatus('signedOut');
    }
  }, [api, tokenStore]);

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
        if (guest) await connectGuest(() => alive);
        else if (alive) setStatus('signedOut');
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
        // 訪客：既有 Session 還原不了（例如伺服器資料重置）就換一個新的
        if (guest) await connectGuest(() => alive);
        else setStatus('signedOut');
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, api, tokenStore, guest, connectGuest]);

  const connect = useCallback(() => connectGuest(), [connectGuest]);

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

  const value = useMemo(
    () => ({ status, user, api, login, logout, connect, error }),
    [status, user, api, login, logout, connect, error],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 訪客連線失敗的說明：後端錯誤原文可能很長或含內部細節，改成使用者看得懂的句子。 */
function guestErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'GUEST_ACCESS_DISABLED') return '此服務目前未開放訪客使用，請聯絡管理員。';
    if (e.status === 404) return '伺服器版本尚未支援訪客使用，請更新後端。';
    if (e.status >= 500) return '伺服器暫時無法提供服務，請稍後再試。';
  }
  return errorMessage(e);
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用');
  return v;
}

export function useApi(): Endpoints {
  return useAuth().api;
}
