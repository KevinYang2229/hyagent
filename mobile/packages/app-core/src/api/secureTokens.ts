/** 登入 token 存在系統安全儲存區（iOS Keychain／Android Keystore）。 */
import * as SecureStore from 'expo-secure-store';
import type { TokenStore, Tokens } from './client';

const KEY = 'auth.tokens';

export const secureTokenStore: TokenStore = {
  async get() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      return null;
    }
  },
  async set(tokens) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY);
  },
};
