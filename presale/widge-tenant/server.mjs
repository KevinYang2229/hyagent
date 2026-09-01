/**
 * 模擬「整合方（租戶）的後端 + landing page」（widget 浮動按鈕版）。
 *
 * landing page 介紹 widget 的使用方式與特色；載入 widget 後右下角顯示**預設浮動按鈕**，
 * 點擊彈出聊天室，並自動 SSO 免登入。
 *
 * 本服務負責：
 *   1. /sso-token   — 用 SDK 的 signUserToken 簽 user token（模擬整合方後端）。
 *   2. /styles.css  — landing page 樣式。
 *   3. /            — landing page，注入 OA 來源與租戶金鑰，bootstrap 載入 widget。
 *
 * 執行（從 repo 根目錄）：node presale/widge-tenant/server.mjs → 開 http://localhost:4000
 * 設定見同目錄 .env（server 會自動載入）：PORT / OA_ORIGIN / TENANT_PK / TENANT_SSO_SECRET / DEMO_USER_*
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 用 SDK 的伺服器端工具簽 token（取代直接呼叫 jsonwebtoken）
import { signUserToken } from '@hyagent/sdk/server';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 自動載入同目錄的 .env（Node 20.12+ / 24 內建，零依賴）
const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
  console.log(`已載入 .env：${envPath}`);
}

const PORT = Number(process.env.PORT ?? 4000);
const OA_ORIGIN = process.env.OA_ORIGIN ?? 'http://localhost:3000';
// API（server）對外來源。前後端分開部署時，這要指向 server 網域（≠ 載入 widget.js 的 client 網域）。
// 同網域 / dev proxy 情境留空即可（預設沿用 OA_ORIGIN）。
const OA_API_ORIGIN = process.env.OA_API_ORIGIN ?? OA_ORIGIN;
// ↓↓↓ 換成你自己的租戶 pk 與 ssoSecret（建租戶時取得/設定）↓↓↓
const TENANT_PK =
  process.env.TENANT_PK ?? 'pk_3dc8a9721d103efb0972aac2c0ef79d237698f765178fc6a';
const TENANT_SSO_SECRET = process.env.TENANT_SSO_SECRET ?? 'test-secret1234567890';
// 模擬「對方系統目前登入的使用者」
const DEMO_USER_ID = process.env.DEMO_USER_ID ?? 'hyweb';
const DEMO_USER_NAME = process.env.DEMO_USER_NAME ?? '測試員';

/** 模擬：使用者已登入對方系統 → 後端用租戶 ssoSecret 簽一張短效 userToken（透過 SDK） */
function mintUserToken() {
  return signUserToken({
    sub: DEMO_USER_ID,
    name: DEMO_USER_NAME,
    secret: TENANT_SSO_SECRET,
    expiresIn: '5m',
  });
}

// landing page：注入 OA 來源與租戶金鑰供前端 bootstrap 使用
const html = fs
  .readFileSync(path.join(DIR, 'index.html'), 'utf-8')
  .replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, api: OA_API_ORIGIN, key: TENANT_PK })};</script>`,
  );

const server = http.createServer((req, res) => {
  if (req.url === '/sso-token') {
    // 真實情境：這裡會先確認「使用者已登入本系統」，再用 ssoSecret 簽 token
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ userToken: mintUserToken() }));
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

server.listen(PORT, () => {
  console.log(`模擬租戶網站已啟動： http://localhost:${PORT}`);
  console.log(`  → HyAgent:    ${OA_ORIGIN}`);
  console.log(`  → 租戶 pk:     ${TENANT_PK.slice(0, 12)}…`);
  console.log(`  → 登入使用者:  ${DEMO_USER_NAME}(${DEMO_USER_ID})`);
});
