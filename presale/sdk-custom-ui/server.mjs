/**
 * 第二個測試網站：SDK 自訂 UI 示範（Surface 2）。
 *
 * 與 tenant-backend（widget 版）的差異：
 *   - 不載入 HyAgent widget、不用 iframe。
 *   - 前端用 @hyagent/sdk（headless）拿資料，UI 完全自己畫（見 app.ts / index.html）。
 *
 * 本服務負責：
 *   1. /api/mybot/identity — Identity Endpoint（規格 §5.2）：以私鑰現簽一張 Assertion。
 *   2. /app.js      — 用 esbuild 把 app.ts（含 SDK）打包成瀏覽器 ESM。
 *   3. /            — 自訂 UI 頁面，注入 OA 來源與租戶金鑰。
 *
 * 執行（從 repo 根目錄）：node presale/sdk-custom-ui/server.mjs → 開 http://localhost:4200
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { computeKid, generateKeyPair, issueAssertion } from '@hyagent/sdk/server';

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
// Assertion 的 iss 必須等於 Tenant ID（規格 §8.4 步驟 10）
const TENANT_ID = process.env.TENANT_ID ?? '';
// 私鑰未設時當場產一組，只為了讓 demo 跑得起來；正式環境放 KMS / Vault（規格 §2.2）
const generated = process.env.TENANT_PRIVATE_KEY ? null : generateKeyPair('ES256');
const PRIVATE_KEY = process.env.TENANT_PRIVATE_KEY ?? generated.privateKeyPem;
const PUBLIC_KEY = generated?.publicKeyPem ?? null;
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
  if (req.url === '/api/mybot/identity') {
    // 規格 §5.2：GET、認證以自家登入 Session 判定、回應不得被快取
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    // 未捕捉的例外會讓整個 demo 行程結束（最常見原因：忘了設 TENANT_ID），改回 500
    let token;
    try {
      token = issueAssertion({
        privateKey: PRIVATE_KEY,
        tenant: TENANT_ID,
        subject: DEMO_USER_ID,
        profile: { name: DEMO_USER_NAME },
      });
    } catch (err) {
      console.error('[identity] 簽發失敗：', err.message);
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'ISSUE_FAILED', message: err.message }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ token, expiresIn: 60 }));
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
  console.log(`  → HyAgent:   ${OA_ORIGIN}`);
  console.log(`  → 租戶 pk:    ${TENANT_PK.slice(0, 12)}…（其 allowedOrigins 須含 http://localhost:${PORT} 或 *）`);
  console.log(`  → Tenant ID: ${TENANT_ID || '(未設！Assertion 的 iss 會是空字串，換發必失敗)'}`);
  if (PUBLIC_KEY) {
    console.log('');
    console.log(`  未設 TENANT_PRIVATE_KEY，已當場產生一組（重啟會變）。請把下面這把公鑰貼到後台（kid: ${computeKid(PUBLIC_KEY)}）：`);
    console.log('');
    console.log(PUBLIC_KEY);
  }
  console.log(`  → 登入使用者: ${DEMO_USER_NAME}(${DEMO_USER_ID})`);
});
