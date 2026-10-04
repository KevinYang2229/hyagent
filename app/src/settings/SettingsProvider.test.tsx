import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SettingsProvider, useSettings, type KeyValueStore } from './SettingsProvider';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const s = {
    data: { ...init },
    async getItem(k: string) { return s.data[k] ?? null; },
    async setItem(k: string, v: string) { s.data[k] = v; },
  };
  return s;
}

async function setup(store: KeyValueStore, defaultServerUrl = '') {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsProvider store={store} defaultServerUrl={defaultServerUrl}>{children}</SettingsProvider>
  );
  return await renderHook(() => useSettings(), { wrapper });
}

describe('SettingsProvider', () => {
  it('沒有儲存值時：伺服器用預設值（正規化）、朗讀預設開', async () => {
    const { result } = await setup(memoryStore(), 'http://10.0.0.2:3000/');
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.serverUrl).toBe('http://10.0.0.2:3000');
    expect(result.current.speakEnabled).toBe(true);
  });

  it('讀回儲存值；修改會正規化並寫回', async () => {
    const store = memoryStore({ 'settings.serverUrl': 'http://a', 'settings.speakEnabled': 'false' });
    const { result } = await setup(store);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.serverUrl).toBe('http://a');
    expect(result.current.speakEnabled).toBe(false);
    await act(() => result.current.setServerUrl('192.168.1.9:3000/'));
    await act(() => result.current.setSpeakEnabled(true));
    expect(result.current.serverUrl).toBe('http://192.168.1.9:3000');
    expect(store.data).toEqual({ 'settings.serverUrl': 'http://192.168.1.9:3000', 'settings.speakEnabled': 'true' });
  });
});
