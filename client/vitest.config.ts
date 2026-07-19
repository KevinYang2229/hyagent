import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 測試專用設定：不載 tailwind / proxy（vite.config.ts 是 dev server 用）
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // testing-library 的自動 cleanup 依賴全域 afterEach；不開會讓測試間 DOM 殘留
    globals: true,
  },
});
