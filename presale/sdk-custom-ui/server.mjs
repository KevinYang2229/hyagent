/**
 * 第二個測試網站：SDK 自訂 UI 示範（Surface 2）。
 *
 * 與 widge-tenant（widget 版）的差異：
 *   - 不載入 HyAgent widget、不用 iframe。
 *   - 前端用 @hyagent/sdk（headless）拿資料，UI 完全自己畫（見 app.ts / index.html）。
 *
 * 本服務負責：
 *   1. **自家的登入 Session** — GET /login 兩位使用者二選一、POST /login 登入、POST /logout 登出。
 *      Identity Endpoint 必須以自家的登入狀態判定身分（規格 §5.2），有登入才演得出 SDK 模式的
 *      登出該怎麼寫（手冊 §5.3，接線在 app.ts）。換人走「登出 → 回登入頁選另一位」。
 *      這裡用一個 httpOnly cookie 對應記憶體裡的 Map——demo 等級，正式環境請沿用貴方既有機制。
 *   2. /api/mybot/identity — Identity Endpoint（規格 §5.2）：已登入才以私鑰現簽一張 Assertion。
 *   3. /app.js      — 用 esbuild 把 app.ts（含 SDK）打包成瀏覽器 ESM。
 *   4. /            — 自訂 UI 頁面，注入 OA 來源與租戶金鑰；未登入導到 /login。
 *
 * 執行（從 repo 根目錄）：node presale/sdk-custom-ui/server.mjs → 開 http://localhost:4200
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

/**
 * 模擬「對方系統的使用者目錄」——兩位，登入頁二選一，與 widge-tenant 同一組欄位（見那支的說明）。
 * 公司別用本站自己的品牌（Beta Cloud）——身分是這個網站發的，簽別人家的公司名沒有道理。
 *
 * profile 是對方系統自家的組織欄位 → Assertion 的 `hyagent:profile`（規格 §4.2.3）。
 * HyAgent 會採用 companyName / deptName / jobPostName 作為公司／部門／職稱；
 * 其中部門另作為部門層級知識庫可見範圍的判定依據。留空的欄位不進 claims。
 */
function defineUser(key, id, name, profile) {
  return {
    key,
    id,
    name,
    profile: Object.fromEntries(Object.entries(profile).filter(([, value]) => value)),
  };
}
const USERS = [
  defineUser('1', process.env.DEMO_USER_ID ?? '507', process.env.DEMO_USER_NAME ?? '測試員', {
    companyName: process.env.DEMO_COMPANY_NAME ?? 'Beta Cloud',
    deptName: process.env.DEMO_DEPT_NAME ?? '財務部',
    jobPostName: process.env.DEMO_JOB_POST_NAME ?? '協理',
  }),
  // 第二位刻意換部門與職稱：換人登入後 console 印出的登入者整串都會變，一眼看得出有沒有生效
  defineUser('2', process.env.DEMO_USER2_ID ?? '902', process.env.DEMO_USER2_NAME ?? '王小明', {
    companyName: process.env.DEMO_USER2_COMPANY_NAME ?? 'Beta Cloud',
    deptName: process.env.DEMO_USER2_DEPT_NAME ?? '研發部',
    jobPostName: process.env.DEMO_USER2_JOB_POST_NAME ?? '工程師',
  }),
];

/** 「Beta Cloud 財務部 協理 測試員(507)」——網站上顯示的人，與 Assertion 簽出去的人是同一位。 */
function describe(user) {
  return [user.profile.companyName, user.profile.deptName, user.profile.jobPostName, `${user.name}(${user.id})`]
    .filter(Boolean)
    .join(' ');
}

// ---- 自家的登入 Session（demo 等級：httpOnly cookie ↔ 記憶體 Map）----
//
// 正式環境請沿用貴方既有的登入機制，重點只有一個：Identity Endpoint 判定身分的依據
// 必須是**這個 session**，不是前端傳來的參數（規格 §5.2）。
//
// cookie 名稱刻意與 widge-tenant（tenant_sid）不同：cookie 只依主機區分、不分埠，
// 兩支 demo 同在 localhost 上，同名的話在一站登入就會把另一站登出。
const COOKIE_NAME = 'sdkui_sid';
const sessions = new Map(); // sid → user.key

function readCookie(req, name) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** 目前這個請求屬於誰；未登入回 null。 */
function currentUser(req) {
  const sid = readCookie(req, COOKIE_NAME);
  const key = sid ? sessions.get(sid) : null;
  return USERS.find((u) => u.key === key) ?? null;
}

function startSession(res, user) {
  const sid = crypto.randomUUID();
  sessions.set(sid, user.key);
  // 本機 demo 走 http 所以沒有 Secure；正式環境必須加上。
  res.setHeader('set-cookie', `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
}

function endSession(req, res) {
  const sid = readCookie(req, COOKIE_NAME);
  if (sid) sessions.delete(sid);
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 模擬：使用者已登入對方系統 → 後端以私鑰現簽一張短效 Assertion。
 *
 * 每次呼叫都重簽：Assertion 有效期 60 秒且一次性，快取重用會被 TOKEN_REPLAYED 拒絕（§6.5）。
 */
function mintAssertion(user) {
  return issueAssertion({
    privateKey: PRIVATE_KEY,
    tenant: TENANT_ID,
    subject: user.id,
    profile: {
      name: user.name,
      ...(Object.keys(user.profile).length > 0 ? { 'hyagent:profile': user.profile } : {}),
    },
  });
}

/**
 * 只為了把「這次簽了什麼」印在終端機（demo 用）。
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

const now = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });

// ---- 頁面 ----
const INDEX_HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf-8');
const LOGIN_HTML = fs.readFileSync(path.join(DIR, 'login.html'), 'utf-8');
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function renderIndex(user) {
  return INDEX_HTML.replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, key: TENANT_PK })};</script>`,
  )
    // header 的「已登入」由目前 session 的使用者產生，確保網站上顯示的人＝Assertion 裡的人
    .replace('<!--LOGIN_BADGE-->', `● 已登入：${escapeHtml(describe(user))}`);
}

function renderLogin(user) {
  const cards = USERS.map((u) => {
    const org = [u.profile.companyName, u.profile.deptName, u.profile.jobPostName].filter(Boolean).join(' · ');
    return `<button type="submit" name="user" value="${escapeHtml(u.key)}" class="user-card${
      user && user.key === u.key ? ' current' : ''
    }">
          <span class="avatar">${escapeHtml(u.name.slice(0, 1))}</span>
          <span class="who">
            <strong>${escapeHtml(u.name)}</strong>
            <span class="meta">工號 ${escapeHtml(u.id)}</span>
            <span class="meta">${escapeHtml(org)}</span>
          </span>
        </button>`;
  }).join('\n        ');
  return LOGIN_HTML.replace('<!--USER_CARDS-->', cards);
}

function sendHtml(res, body) {
  // no-store：登出後按上一頁，不該從快取裡翻出一張「已登入」的頁面
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

/** 讀完 POST body（表單）。demo 只收得下小小一張表單，超過就斷。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const user = currentUser(req);

  if (pathname === '/api/mybot/identity') {
    // 規格 §5.2：GET、認證以自家登入 Session 判定、回應不得被快取
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    // 未登入（包含登出之後）就不簽。SDK 的 provider 拿到 null 視同未登入、不重試（規格 §6.5）。
    if (!user) {
      console.log(`[identity] ${now()} 未登入 → 401`);
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'NOT_LOGGED_IN' }));
      return;
    }
    // 未捕捉的例外會讓整個 demo 行程結束（最常見原因：忘了設 TENANT_ID），改回 500
    let token;
    try {
      token = mintAssertion(user);
    } catch (err) {
      console.error('[identity] 簽發失敗：', err.message);
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'ISSUE_FAILED', message: err.message }));
      return;
    }
    const claims = peekClaims(token);
    console.log(
      `[identity] ${now()} 簽發給 ${user.name}(${user.id})`,
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
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ token, expiresIn: 60 }));
    return;
  }
  if (pathname === '/login') {
    if (req.method === 'GET') {
      sendHtml(res, renderLogin(user));
      return;
    }
    if (req.method === 'POST') {
      let picked;
      try {
        picked = new URLSearchParams(await readBody(req)).get('user');
      } catch {
        res.writeHead(413).end();
        return;
      }
      const next = USERS.find((u) => u.key === picked);
      if (!next) {
        redirect(res, '/login');
        return;
      }
      // 換人＝先作廢舊的 session 再發一張新的，不是把舊的改寫成別人。
      endSession(req, res);
      startSession(res, next);
      console.log(`[session]  ${now()} 登入 ${describe(next)}`);
      redirect(res, '/');
      return;
    }
    res.writeHead(405, { allow: 'GET, POST' }).end();
    return;
  }
  if (pathname === '/logout') {
    // 用 POST 而非 GET：登出會改變狀態，不該被預抓連結或 <img> 之類的東西觸發。
    // 走到這裡之前，app.ts 已先 await oa.logout() 讓 HyAgent 作廢了 Session。
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (user) console.log(`[session]  ${now()} 登出 ${describe(user)}`);
    endSession(req, res);
    redirect(res, '/login');
    return;
  }
  if (pathname === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(appJs);
    return;
  }
  if (pathname === '/hy_logo.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(fs.readFileSync(path.join(DIR, 'hy_logo.png')));
    return;
  }
  if (pathname === '/styles.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DIR, 'styles.css'), 'utf-8'));
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    // 未登入不給這一頁：SDK 在這一頁上，沒有登入狀態時它也取不到票。
    if (!user) {
      redirect(res, '/login');
      return;
    }
    sendHtml(res, renderIndex(user));
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
  console.log('  → 可登入的人（先到 /login 選一位）:');
  for (const u of USERS) console.log(`      ${u.key}. ${describe(u)}`);
  if (PUBLIC_KEY) {
    console.log('');
    console.log(`  未設 TENANT_PRIVATE_KEY，已當場產生一組（重啟會變）。請把下面這把公鑰貼到後台（kid: ${computeKid(PUBLIC_KEY)}）：`);
    console.log('');
    console.log(PUBLIC_KEY);
  }
});
