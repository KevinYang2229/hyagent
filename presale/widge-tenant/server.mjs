/**
 * 模擬「整合方（租戶）的後端 + landing page」（widget 浮動按鈕版）。
 *
 * landing page 介紹 widget 的使用方式與特色；載入 widget 後右下角顯示**預設浮動按鈕**，
 * 點擊彈出聊天室，並自動 SSO 免登入。
 *
 * 本服務負責：
 *   1. **自家的登入 Session** — GET /login 兩位使用者二選一、POST /login 登入、POST /logout 登出。
 *      規格 §5.2 要求 Identity Endpoint「一律以自家的登入 Session 判定身分，不得接受前端傳入
 *      的身分參數」，所以 demo 得先有自家的登入狀態，才演得出登出與換人登入（手冊 §5.3）。
 *      這裡用一個 httpOnly cookie 對應記憶體裡的 Map——demo 等級，正式環境請沿用貴方既有機制。
 *   2. /api/mybot/identity — Identity Endpoint（規格 §5.2）：用 SDK 的 issueAssertion
 *      以**私鑰**現簽一張短效 Assertion，簽的是**目前這個 cookie session 的使用者**；
 *      未登入回 401（widget 收到 401 不重試，面板改走匿名／自行登入）。路徑沿用規格範例。
 *   3. /styles.css  — 樣式（landing page 與登入頁共用）。
 *   4. /            — landing page，注入 OA 來源與租戶金鑰，bootstrap 載入 widget；未登入導去 /login。
 *
 * 執行（從 repo 根目錄）：node presale/widge-tenant/server.mjs → 開 http://localhost:4000
 * 設定見同目錄 .env（server 會自動載入）：PORT / OA_ORIGIN / TENANT_PK / TENANT_PRIVATE_KEY / DEMO_USER*
 *
 * 私鑰未設時會**當場產生一組**並把公鑰印在 console，方便第一次跑起來；正式環境請把私鑰
 * 放進 KMS / Vault 或環境變數，且**絕不可**讓它離開貴方環境（規格 §2.2）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

/**
 * 模擬「對方系統的使用者目錄」——兩位，登入頁二選一。
 *
 * 有兩位才演得出「登出 → 以另一位重新登入」（手冊 §5.3）：換人之後小幫手裡的身分
 * 有沒有跟著換，是整合方最容易漏掉、也最該當場驗一次的事。
 *
 * profile 是對方系統自家的組織欄位（公司／部門／職稱）。規格 §4.2.3：這類欄位沒有標準 claim，
 * 一律集中放在 `hyagent:profile` 底下，HyAgent 不解讀語意、原樣帶過。企業入口既有 SSO token
 * 上的 deptId / companyName / jobPostName 等欄位遷移過來時直接塞進這個物件即可。
 * 留空的欄位不進 claims——Assertion 有 4096 bytes 上限（§4.2.4），空字串沒有意義。
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
  // 沿用整合手冊 §4.3 範例那位：工號 507 的財務部協理
  defineUser('1', process.env.DEMO_USER_ID ?? '507', process.env.DEMO_USER_NAME ?? '測試員', {
    companyName: process.env.DEMO_COMPANY_NAME ?? '凌網',
    deptName: process.env.DEMO_DEPT_NAME ?? '財務部',
    jobPostName: process.env.DEMO_JOB_POST_NAME ?? '協理',
  }),
  // 第二位刻意換部門與職稱：換人登入後，小幫手標題列那串會整個不一樣，一眼看得出有沒有生效
  defineUser('2', process.env.DEMO_USER2_ID ?? '902', process.env.DEMO_USER2_NAME ?? '王小明', {
    companyName: process.env.DEMO_USER2_COMPANY_NAME ?? '凌網',
    deptName: process.env.DEMO_USER2_DEPT_NAME ?? '研發部',
    jobPostName: process.env.DEMO_USER2_JOB_POST_NAME ?? '工程師',
  }),
];

/** 「凌網 財務部 協理 測試員(507)」——網站上顯示的人，與 Assertion 簽出去的人是同一位。 */
function describe(user) {
  return [
    user.profile.companyName,
    user.profile.deptName,
    user.profile.jobPostName,
    `${user.name}(${user.id})`,
  ]
    .filter(Boolean)
    .join(' ');
}

// ---- 自家的登入 Session（demo 等級：httpOnly cookie ↔ 記憶體 Map）----
//
// 正式環境請沿用貴方既有的登入機制，重點只有一個：Identity Endpoint 判定身分的依據
// 必須是**這個 session**，不是前端傳來的參數（規格 §5.2）。
const COOKIE_NAME = 'tenant_sid';
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

const now = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });

// ---- 頁面 ----
const INDEX_HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf-8');
const LOGIN_HTML = fs.readFileSync(path.join(DIR, 'login.html'), 'utf-8');
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * header 右側：目前登入者 ＋ 登出（整合手冊 §5.3）。
 *
 * 登出鈕由 index.html 底部那段腳本接線：送出表單前先 await OAAgent.logout()，
 * 那段就是要給整合方照抄的部分。換人走「登出 → 回登入頁選另一位」，與一般網站相同。
 */
function sessionBox(user) {
  return `<span class="login-badge" id="login-badge">● 已登入：${escapeHtml(describe(user))}</span>
      <div class="session-actions">
        <form method="post" action="/logout" id="logout-form">
          <button type="submit" class="logout">登出</button>
        </form>
      </div>`;
}

function renderIndex(user) {
  return INDEX_HTML.replace(
    '<!--OA_CONFIG-->',
    `<script>window.__OA__ = ${JSON.stringify({ origin: OA_ORIGIN, api: OA_API_ORIGIN, key: TENANT_PK })};</script>`,
  ).replace('<!--SESSION_BOX-->', sessionBox(user));
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
  }).join('\n          ');
  return LOGIN_HTML.replace('<!--USER_CARDS-->', cards);
}

function sendHtml(res, body) {
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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const user = currentUser(req);

  if (pathname === '/api/mybot/identity') {
    // 規格 §5.2：GET；認證一律以「自家的登入 Session」判定，不得接受前端傳入的身分參數。
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    // 未登入就不簽——這是規格 §5.2 的要求，也是登出之後該有的樣子。widget 把 401 當成
    // 「使用者根本沒登入宿主網站」：不重試，面板改走匿名／自行登入（§6.5）。
    if (!user) {
      console.log(`[identity] ${now()} 未登入 → 401`);
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'NOT_LOGGED_IN' }));
      return;
    }
    // 簽發失敗（最常見：忘了設 TENANT_ID）必須回成錯誤回應，不能讓它往上炸——
    // 這支 demo 是單一 http server，未捕捉的例外會直接讓整個行程結束，
    // 表現成「點一下小幫手，網站就掛了」，而真正的原因埋在 console 最底下。
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
    res.writeHead(200, {
      'content-type': 'application/json',
      // 規格 §5.2、§10.1：憑證不得被 CDN / 瀏覽器快取
      'cache-control': 'no-store',
    });
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
      // 切換帳號＝先作廢舊的 session 再發一張新的，不是把舊的改寫成別人。
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
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (user) console.log(`[session]  ${now()} 登出 ${describe(user)}`);
    endSession(req, res);
    redirect(res, '/login');
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
    // 未登入不給 landing page：widget 的載入碼在這一頁，沒有登入狀態時它也取不到票。
    if (!user) {
      redirect(res, '/login');
      return;
    }
    sendHtml(res, renderIndex(user));
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  console.log(`模擬租戶網站已啟動： http://localhost:${PORT}`);
  console.log(`  → HyAgent:    ${OA_ORIGIN}`);
  console.log(`  → 租戶 pk:     ${TENANT_PK.slice(0, 12)}…`);
  console.log(`  → Tenant ID:  ${TENANT_ID || '(未設！Assertion 的 iss 會是空字串，換發必失敗)'}`);
  console.log('  → 可登入的人:');
  for (const u of USERS) console.log(`      ${u.key}. ${describe(u)}`);
  if (PUBLIC_KEY) {
    console.log('');
    console.log('  未設 TENANT_PRIVATE_KEY，已當場產生一組金鑰（重啟會變）。');
    console.log(`  請到 HyAgent 後台把下面這把公鑰貼給租戶 ${TENANT_ID}（kid: ${computeKid(PUBLIC_KEY)}）：`);
    console.log('');
    console.log(PUBLIC_KEY);
  }
});
