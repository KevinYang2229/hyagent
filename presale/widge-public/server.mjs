/**
 * 模擬「整合方（租戶）的 landing page」——純前端嵌入版（不做 SSO 免登入）。
 *
 * 與隔壁 widge-tenant 的差別：
 *   - 不 import SDK（不需要 @hyagent/sdk/server）。
 *   - 沒有 Identity Endpoint，不簽任何憑證，後端不持有任何金鑰。
 *   - 載入 widget 時不帶 data-token-url → 使用者在 widget 內自行登入。
 *
 * 換句話說：這支「server」只是個靜態檔伺服器，正式環境根本不需要任何後端——
 * 把 index.html 裡那一行 <script src=".../sdk/widget.js" data-key=pk_…> 貼到你的頁面即可。
 * 這裡保留一支 server 只是為了 demo 能用 .env 注入 OA_ORIGIN / TENANT_PK，免改檔。
 *
 * 執行：node presale/widge-public/server.mjs → 開 http://localhost:4001
 * 設定見同目錄 .env（server 會自動載入）：PORT / OA_ORIGIN / TENANT_PK
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 自動載入同目錄的 .env（Node 20.12+ / 24 內建，零依賴）
const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
  console.log(`已載入 .env：${envPath}`);
}

const PORT = Number(process.env.PORT ?? 4001);
const OA_ORIGIN = process.env.OA_ORIGIN ?? 'http://localhost:3000';
// pk 是「公開」金鑰，放前端沒問題（不像簽發用的私鑰需留後端）
const TENANT_PK =
  process.env.TENANT_PK ?? 'pk_3dc8a9721d103efb0972aac2c0ef79d237698f765178fc6a';

// landing page：注入 OA 來源與租戶公開金鑰供前端 bootstrap 使用
const html = fs
  .readFileSync(path.join(DIR, 'index.html'), 'utf-8')
  .replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, key: TENANT_PK })};</script>`,
  );

const server = http.createServer((req, res) => {
  // 刻意「沒有」Identity Endpoint：這版不做免登入，後端不簽任何 token。
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
  console.log(`模擬租戶網站（純前端嵌入版）已啟動： http://localhost:${PORT}`);
  console.log(`  → HyAgent:  ${OA_ORIGIN}`);
  console.log(`  → 租戶 pk:   ${TENANT_PK.slice(0, 12)}…`);
  console.log(`  → SSO:       關閉（使用者於 widget 內自行登入）`);
});
