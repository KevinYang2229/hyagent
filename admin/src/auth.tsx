import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { tabLevel, type AdminMe, type AdminTabKey, type AdminTabLevel } from '@hyagent/shared';
import { api, tokenStore, UnauthorizedError } from './api';

interface AuthCtx {
  authed: boolean;
  me: AdminMe | null;
  isSuper: boolean;
  /** 目前身分對某分頁的權限；超級管理者一律 write，me 尚未載入時為 hidden */
  level: (tab: AdminTabKey) => AdminTabLevel;
  login: (username: string, password: string) => Promise<AdminMe>;
  logout: () => void;
  /** 重新向後端取得身分（例如權限被調整後） */
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => !!tokenStore.get());
  const [me, setMe] = useState<AdminMe | null>(null);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    tokenStore.set(res.token);
    setMe(res.me);
    setAuthed(true);
    return res.me;
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setMe(null);
    setAuthed(false);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.getMe());
    } catch (e) {
      if (e instanceof UnauthorizedError) logout();
      else throw e;
    }
  }, [logout]);

  // 重新整理頁面：token 還在但身分資料沒了，向後端補回；401 代表帳號已失效，登出
  useEffect(() => {
    if (!authed || me) return;
    let cancelled = false;
    api.getMe().then(
      (m) => { if (!cancelled) setMe(m); },
      (e) => { if (!cancelled && e instanceof UnauthorizedError) logout(); },
    );
    return () => { cancelled = true; };
  }, [authed, me, logout]);

  const value = useMemo<AuthCtx>(() => {
    const isSuper = me?.kind === 'super';
    const level = (tab: AdminTabKey): AdminTabLevel => {
      if (!me) return 'hidden';
      if (me.kind === 'super') return 'write';
      return tabLevel(me.permissions, tab);
    };
    return { authed, me, isSuper, level, login, logout, refreshMe };
  }, [authed, me, login, logout, refreshMe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth 必須在 AuthProvider 內使用');
  return v;
}
