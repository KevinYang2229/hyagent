import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// dev server 跑在 5173，/api 與 /healthz 代理到後端 Express（3000）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // workspace 套件以原始碼形式被引用，不要被 esbuild 預先打包
  optimizeDeps: { exclude: ['@hyagent/shared', '@hyagent/ui'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
