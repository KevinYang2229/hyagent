/**
 * 模擬「整合方（租戶）的後端 + landing page」（widget 浮動按鈕版）。
 *
 * landing page 介紹 widget 的使用方式與特色；載入 widget 後右下角顯示**預設浮動按鈕**，
 * 點擊彈出聊天室，並自動 SSO 免登入。
 *
 * 本服務負責：
 *   1. /api/mybot/identity — Identity Endpoint（規格 §5.2）：用 SDK 的 issueAssertion
 *      以**私鑰**現簽一張短效 Assertion（模擬整合方後端）。路徑沿用規格範例，可直接照抄。
 *   2. /styles.css  — landing page 樣式。
 *   3. /            — landing page，注入 OA 來源與租戶金鑰，bootstrap 載入 widget。
 *
 * 執行（從 repo 根目錄）：node presale/widge-tenant/server.mjs → 開 http://localhost:4000
 * 設定見同目錄 .env（server 會自動載入）：PORT / OA_ORIGIN / TENANT_PK / TENANT_PRIVATE_KEY / DEMO_USER_*
 *
 * 私鑰未設時會**當場產生一組**並把公鑰印在 console，方便第一次跑起來；正式環境請把私鑰
 * 放進 KMS / Vault 或環境變數，且**絕不可**讓它離開貴方環境（規格 §2.2）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 用 SDK 的伺服器端工具簽 Assertion（零相依，只用 node:crypto）
import { computeKid, generateKeyPair, issueAssertion } from '@hyagent/sdk/server';

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
// ↓↓↓ 換成你自己的租戶 pk 與 Tenant ID（建租戶時取得）↓↓↓
const TENANT_PK =
  process.env.TENANT_PK ?? 'pk_3dc8a9721d103efb0972aac2c0ef79d237698f765178fc6a';
// Assertion 的 iss 必須等於 Tenant ID（規格 §8.4 步驟 10）——它現在是換發時的租戶依據，
// pk 只影響外觀與 CORS，不再參與身分判定。
const TENANT_ID = process.env.TENANT_ID ?? '';
// 私鑰：正式環境放 KMS / Vault / 環境變數。未設時當場產一組，只為了讓 demo 跑得起來。
const generated = process.env.TENANT_PRIVATE_KEY ? null : generateKeyPair('ES256');
const PRIVATE_KEY = process.env.TENANT_PRIVATE_KEY ?? generated.privateKeyPem;
const PUBLIC_KEY = generated?.publicKeyPem ?? null;
// 模擬「對方系統目前登入的使用者」。沿用整合手冊 §4.3 範例那位：工號 507 的財務部協理。
const DEMO_USER_ID = process.env.DEMO_USER_ID ?? '507';
const DEMO_USER_NAME = process.env.DEMO_USER_NAME ?? '測試員';
/**
 * 對方系統自家的組織欄位（公司／部門／職稱）。
 *
 * 規格 §4.2.3：這類欄位沒有標準 claim，一律集中放在 `hyagent:profile` 底下，
 * HyAgent 不解讀語意、原樣帶過。企業入口既有 SSO token 上的 deptId / companyName /
 * jobPostName 等欄位遷移過來時直接塞進這個物件即可，不必為它們發明新的頂層 claim。
 *
 * 留空的欄位不進 claims——Assertion 有 4096 bytes 上限（§4.2.4），空字串沒有意義。
 */
const DEMO_PROFILE = Object.fromEntries(
  Object.entries({
    companyName: process.env.DEMO_COMPANY_NAME ?? '凌網',
    deptName: process.env.DEMO_DEPT_NAME ?? '財務部',
    jobPostName: process.env.DEMO_JOB_POST_NAME ?? '協理',
  }).filter(([, value]) => value),
);

/**
 * 模擬：使用者已登入對方系統 → 後端以私鑰現簽一張短效 Assertion。
 *
 * 每次呼叫都重簽：Assertion 有效期 60 秒且一次性，快取重用會被 TOKEN_REPLAYED 拒絕（§6.5）。
 */
function mintAssertion() {
  return issueAssertion({
    privateKey: PRIVATE_KEY,
    tenant: TENANT_ID,
    subject: DEMO_USER_ID,
    profile: {
      name: DEMO_USER_NAME,
      ...(Object.keys(DEMO_PROFILE).length > 0 ? { 'hyagent:profile': DEMO_PROFILE } : {}),
    },
  });
}

/**
 * 只為了把「這次簽了什麼給小幫手」印在 console（demo 用）。
 *
 * 正式環境不需要這段，也不該把 claims 值寫進日誌（規格 §11.1）——這裡是本機示範，
 * 目的正是讓整合方看得見身分是怎麼帶過去的。
 */
function peekClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// landing page：注入 OA 來源與租戶金鑰供前端 bootstrap 使用，
// 並把 header 的「已登入」換成實際會被簽進 Assertion 的那位使用者。
const loginBadge = `● 已登入：${[
  DEMO_PROFILE.companyName,
  DEMO_PROFILE.deptName,
  DEMO_PROFILE.jobPostName,
  `${DEMO_USER_NAME}(${DEMO_USER_ID})`,
]
  .filter(Boolean)
  .join(' ')}`;
const html = fs
  .readFileSync(path.join(DIR, 'index.html'), 'utf-8')
  .replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, api: OA_API_ORIGIN, key: TENANT_PK })};</script>`,
  )
  .replace('<!--LOGIN_BADGE-->', loginBadge);

const server = http.createServer((req, res) => {
  if (req.url === '/api/mybot/identity') {
    // 規格 §5.2：GET；認證一律以「自家的登入 Session」判定，不得接受前端傳入的身分參數。
    // 本 demo 假設使用者已登入（DEMO_USER_*）；真實情境這裡要先驗自家 cookie，未登入回 401。
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    // 簽發失敗（最常見：忘了設 TENANT_ID）必須回成錯誤回應，不能讓它往上炸——
    // 這支 demo 是單一 http server，未捕捉的例外會直接讓整個行程結束，
    // 表現成「點一下小幫手，網站就掛了」，而真正的原因埋在 console 最底下。
    let token;
    try {
      token = mintAssertion();
    } catch (err) {
      console.error('[identity] 簽發失敗：', err.message);
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'ISSUE_FAILED', message: err.message }));
      return;
    }
    const claims = peekClaims(token);
    console.log(
      `[identity] ${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 簽發給` +
        ` ${DEMO_USER_NAME}(${DEMO_USER_ID})`,
      claims
        ? {
            iss: claims.iss,
            sub: claims.sub,
            name: claims.name,
            'hyagent:profile': claims['hyagent:profile'],
            jti: claims.jti,
            exp: new Date(claims.exp * 1000).toLocaleTimeString('zh-TW', { hour12: false }),
          }
        : '(claims 解析失敗)',
    );
    res.writeHead(200, {
      'content-type': 'application/json',
      // 規格 §5.2、§10.1：憑證不得被 CDN / 瀏覽器快取
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ token, expiresIn: 60 }));
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
  console.log(`  → Tenant ID:  ${TENANT_ID || '(未設！Assertion 的 iss 會是空字串，換發必失敗)'}`);
  console.log(
    `  → 登入使用者:  ${DEMO_USER_NAME}(${DEMO_USER_ID})` +
      (Object.keys(DEMO_PROFILE).length > 0 ? `　${Object.values(DEMO_PROFILE).join(' / ')}` : ''),
  );
  if (PUBLIC_KEY) {
    console.log('');
    console.log('  未設 TENANT_PRIVATE_KEY，已當場產生一組金鑰（重啟會變）。');
    console.log(`  請到 HyAgent 後台把下面這把公鑰貼給租戶 ${TENANT_ID}（kid: ${computeKid(PUBLIC_KEY)}）：`);
    console.log('');
    console.log(PUBLIC_KEY);
  }
});
