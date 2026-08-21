/**
 * 第二個測試網站：SDK 自訂 UI 示範（Surface 2）。
 *
 * 與 tenant-backend（widget 版）的差異：
 *   - 不載入 OA widget、不用 iframe。
 *   - 前端用 @hyagent/sdk（headless）拿資料，UI 完全自己畫（見 app.ts / index.html）。
 *
 * 本服務負責：
 *   1. /sso-token   — 用 SDK 的 signUserToken 簽 user token（模擬整合方後端）。
 *   2. /app.js      — 用 esbuild 把 app.ts（含 SDK）打包成瀏覽器 ESM。
 *   3. /            — 自訂 UI 頁面，注入 OA 來源與租戶金鑰。
 *
 * 執行（從 repo 根目錄）：node examples/sdk-custom-ui/server.mjs → 開 http://localhost:4200
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { signUserToken } from '@hyagent/sdk/server';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 自動載入同目錄 .env
const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
  console.log(`已載入 .env：${envPath}`);
}

const PORT = Number(process.env.PORT ?? 4200);
const OA_ORIGIN = process.env.OA_ORIGIN ?? 'http://localhost:3000';
const TENANT_PK =
  process.env.TENANT_PK ?? 'pk_3dc8a9721d103efb0972aac2c0ef79d237698f765178fc6a';
const TENANT_SSO_SECRET = process.env.TENANT_SSO_SECRET ?? 'test-secret1234567890';
const DEMO_USER_ID = process.env.DEMO_USER_ID ?? 'hyweb';
const DEMO_USER_NAME = process.env.DEMO_USER_NAME ?? '測試員';

// 啟動時用 esbuild 把 app.ts（含 @hyagent/sdk）打包成瀏覽器可執行的 ESM。
let appJs = '';
async function buildApp() {
  const result = await esbuild.build({
    entryPoints: [path.join(DIR, 'app.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  appJs = result.outputFiles[0].text;
  console.log(`已打包 app.ts（${(appJs.length / 1024).toFixed(1)} KB）`);
}

const html = fs
  .readFileSync(path.join(DIR, 'index.html'), 'utf-8')
  .replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, key: TENANT_PK })};</script>`,
  );

const server = http.createServer((req, res) => {
  if (req.url === '/sso-token') {
    const userToken = signUserToken({
      sub: DEMO_USER_ID,
      name: DEMO_USER_NAME,
      secret: TENANT_SSO_SECRET,
      expiresIn: '5m',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ userToken }));
    return;
  }
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(appJs);
    return;
  }
  if (req.url === '/hy_logo.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(fs.readFileSync(path.join(DIR, 'hy_logo.png')));
    return;
  }
  if (req.url === '/styles.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DIR, 'styles.css'), 'utf-8'));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404).end('not found');
});

await buildApp();
server.listen(PORT, () => {
  console.log(`SDK 自訂 UI 網站已啟動： http://localhost:${PORT}`);
  console.log(`  → OA Agent:   ${OA_ORIGIN}`);
  console.log(`  → 租戶 pk:    ${TENANT_PK.slice(0, 12)}…（其 allowedOrigins 須含 http://localhost:${PORT} 或 *）`);
  console.log(`  → 登入使用者: ${DEMO_USER_NAME}(${DEMO_USER_ID})`);
});
