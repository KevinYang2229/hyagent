/** 裝置設定：伺服器位址、朗讀開關（存在 AsyncStorage；測試可注入 store）。 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { normalizeServerUrl } from '@hyagent/app-core/api/config';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const KEYS = { server: 'settings.serverUrl', speak: 'settings.speakEnabled' } as const;

export interface Settings {
  ready: boolean;
  serverUrl: string;
  speakEnabled: boolean;
  setServerUrl(url: string): Promise<void>;
  setSpeakEnabled(on: boolean): Promise<void>;
}

const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({
  children,
  store = AsyncStorage,
  defaultServerUrl = process.env.EXPO_PUBLIC_API_BASE ?? '',
}: {
  children: ReactNode;
  store?: KeyValueStore;
  defaultServerUrl?: string;
}) {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServer] = useState('');
  const [speakEnabled, setSpeak] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let s: string | null = null;
      let sp: string | null = null;
      try {
        [s, sp] = await Promise.all([store.getItem(KEYS.server), store.getItem(KEYS.speak)]);
      } catch {
        // 儲存區讀取失敗：退回預設值，避免啟動畫面卡住
      }
      if (!alive) return;
      setServer(normalizeServerUrl(s ?? defaultServerUrl));
      setSpeak(sp === null ? true : sp === 'true');
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [store, defaultServerUrl]);

  const setServerUrl = useCallback(
    async (url: string) => {
      const v = normalizeServerUrl(url);
      setServer(v);
      await store.setItem(KEYS.server, v);
    },
    [store],
  );

  const setSpeakEnabled = useCallback(
    async (on: boolean) => {
      setSpeak(on);
      await store.setItem(KEYS.speak, String(on));
    },
    [store],
  );

  const value = useMemo(
    () => ({ ready, serverUrl, speakEnabled, setServerUrl, setSpeakEnabled }),
    [ready, serverUrl, speakEnabled, setServerUrl, setSpeakEnabled],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Settings {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('useSettings 必須在 SettingsProvider 內使用');
  return v;
}
