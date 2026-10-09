/**
 * 訪客 Session 的保存處：手機／平板用系統安全儲存區；網頁版沒有 SecureStore 原生模組，改存在記憶體
 * （重新整理就換一個新的訪客 Session，訪客沒有需要保留的身分）。
 */
import { Platform } from 'react-native';
import type { TokenStore, Tokens } from '@hyagent/app-core/api/client';
import { secureTokenStore } from '@hyagent/app-core/api/secureTokens';

export function memoryTokenStore(): TokenStore {
  let current: Tokens | null = null;
  return {
    async get() { return current; },
    async set(tokens) { current = tokens; },
    async clear() { current = null; },
  };
}

export const guestTokenStore: TokenStore = Platform.OS === 'web' ? memoryTokenStore() : secureTokenStore;
