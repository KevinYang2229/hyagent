/**
 * 自訂 UI 範例（Surface 2 / SDK headless）。
 *
 * 重點：完全不載入 widget、不用 iframe。畫面、版面、CSS 全部自己畫，
 * 只透過 @hyagent/sdk 拿資料（對話 / 表單 / 狀態），證明「UI 可完全客製化」。
 *
 * 由 esbuild 打包成瀏覽器可執行的 /app.js（見同目錄 server.mjs）。
 */
import { createOAAgent, type TurnData } from '@hyagent/sdk';

// server.mjs 注入：OA 來源與租戶公開金鑰
const cfg = (window as unknown as { __OA__: { origin: string; key: string } }).__OA__;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const messagesEl = $('messages');
const valuesEl = $('values');
const inputEl = $('input') as HTMLInputElement;
const sendBtn = $('send') as HTMLButtonElement;
const submitBtn = $('submit') as HTMLButtonElement;
const suggestEl = $('suggest');
const statusEl = $('status');

let convId: string | null = null;
let oa: ReturnType<typeof createOAAgent>;

/**
 * demo 專用：把自動登入的每一步印到 console（標 `[sdk-custom-ui]`），用來確認「現在是誰在用」。
 * 對應 widget 版的 `data-debug="1"`（見 widge-tenant）。
 *
 * **正式站請改成 false 或整段拿掉**：憑證雖然遮罩過才印，claims 裡的使用者代號與姓名會完整印出——
 * 那正是整合期要看的東西，但 console 的內容會被截圖、被貼進 issue。
 */
const DEBUG = true;
const TAG_STYLE = 'color:#fff;background:#7c3aed;padding:1px 5px;border-radius:3px';
function dlog(label: string, detail?: unknown): void {
  if (!DEBUG) return;
  if (detail === undefined) console.log('%c[sdk-custom-ui]', TAG_STYLE, label);
  else console.log('%c[sdk-custom-ui]', TAG_STYLE, label, detail);
}

/** 憑證只印前 8 碼與長度——足以比對「是不是同一張」，又不足以拿去用。 */
const maskToken = (token: string): string => `${token.slice(0, 8)}…（共 ${token.length} 字元）`;

/** 解出 JWS 的 header / payload 供檢視。純顯示用、**不驗章**——驗證在 HyAgent 後端（規格 §8）。 */
function decodeJws(token: string): { header?: Record<string, unknown>; payload?: Record<string, unknown> } {
  const segment = (part: string) => {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    // claims 含中文姓名：atob 回的是位元組字串，要再以 UTF-8 解一次
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  };
  try {
    const [header, payload] = token.split('.');
    return { header: segment(header), payload: segment(payload) };
  } catch {
    return {};
  }
}

function addMsg(role: 'user' | 'agent' | 'sys', text: string): void {
  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderValues(values: Record<string, unknown>): void {
  valuesEl.innerHTML = '';
  const entries = Object.entries(values).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (!entries.length) {
    valuesEl.innerHTML = '<div class="empty">尚無資料</div>';
    return;
  }
  for (const [k, v] of entries) {
    const row = document.createElement('div');
    row.className = 'kv';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = Array.isArray(v) ? `${v.length} 項` : String(v);
    row.append(key, val);
    valuesEl.appendChild(row);
  }
}

function renderSuggest(suggestions: string[]): void {
  suggestEl.innerHTML = '';
  for (const s of suggestions) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = s;
    b.onclick = () => void send(s);
    suggestEl.appendChild(b);
  }
}

function applyTurn(turn: TurnData): void {
  if (turn.id) convId = turn.id;
  statusEl.textContent = turn.status;
  if (turn.reply) addMsg('agent', turn.reply);
  renderValues(turn.values ?? {});
  renderSuggest(turn.suggestions ?? []);
  submitBtn.style.display = turn.status === 'confirming' ? '' : 'none';
  if (turn.status === 'submitted' && turn.submission) {
    addMsg('sys', `✅ 已送出，OA 單號：${turn.submission.oaRequestId}`);
    submitBtn.style.display = 'none';
  }
}

async function send(text: string): Promise<void> {
  if (!text.trim() || !oa) return;
  addMsg('user', text);
  inputEl.value = '';
  try {
    const turn = convId
      ? await oa.conversations.sendMessage(convId, text)
      : await oa.conversations.create({ message: text });
    applyTurn(turn);
  } catch (e) {
    addMsg('sys', '⚠️ ' + (e instanceof Error ? e.message : String(e)));
  }
}

async function submit(): Promise<void> {
  if (!convId || !oa) return;
  try {
    applyTurn(await oa.conversations.submit(convId));
  } catch (e) {
    addMsg('sys', '⚠️ ' + (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Token Provider（規格 §5.2、§6.5）：向自家 Identity Endpoint 現取一張 Assertion。
 *
 * 傳「函式」而不是把簽好的字串傳給 SDK，是因為這是一個會一直開著的頁面：
 * Assertion 換來的 Session 預設一小時，字串形式用掉就沒有下一張——到期或被後台撤銷之後
 * 救不回來，使用者只能重整頁面。傳函式的話，SDK 會在**到期前 60 秒**與**收到 401 時**
 * 自己再呼叫一次，續期與撤銷後的重新取得都不必這支 UI 操心。
 *
 * 回 null＝使用者沒登入自家系統（端點回 401，例如在別的分頁登出了）。SDK 視同未登入、不重試。
 */
async function fetchAssertion(): Promise<string | null> {
  const res = await fetch('/api/mybot/identity', {
    // 由自家的登入 Session 決定發給誰；端點不接受前端傳入的 user id（規格 §5.2）
    credentials: 'include',
    headers: { accept: 'application/json' },
    // 拿到快取的同一張等於重放，後端會以 TOKEN_REPLAYED 拒絕
    cache: 'no-store',
  });
  dlog(`Identity Endpoint 回應 HTTP ${res.status}：GET /api/mybot/identity`);
  if (!res.ok) return null;
  const { token } = (await res.json()) as { token?: string };
  if (token) {
    const { header, payload } = decodeJws(token);
    dlog('取得 Identity Assertion（交給 SDK 換發）', {
      assertion: maskToken(token),
      kid: header?.kid ?? '(解不出)',
      // iss＝租戶、sub＝本站的使用者代號、name＝顯示名、hyagent:profile＝組織欄位、exp＝到期時間
      claims: payload ?? '(解不出)',
    });
  }
  return token ?? null;
}

// 首次開啟聊天室時才初始化 SDK（headless）：建 client → 走一次 provider → 換發 Session
const panel = $('chat-panel');
let booted = false;
async function ensureBooted(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    oa = createOAAgent({ key: cfg.key, assertion: fetchAssertion, apiBase: cfg.origin });
    dlog('首次換發：refreshIdentity()（SDK 會呼叫 fetchAssertion 取票，再送 POST /api/auth/sso/exchange）');
    // 首次換發。回 false＝provider 沒給票（使用者未登入自家系統），不是連線錯誤，
    // 所以要自己判斷——這時該回自家登入頁，而不是顯示「初始化失敗」。
    if (!(await oa.refreshIdentity())) {
      dlog('沒拿到票（本站未登入）→ 回登入頁');
      location.href = '/login';
      return;
    }
    dlog('換發成功，SDK 已持有 HyAgent Session');
    // HyAgent 最終認定的身分：租戶建有人員目錄時以目錄為準，未必等於 Assertion 帶的值。
    // 自建 UI 要顯示使用者名稱也是看這支。
    const me = await oa.me().catch((e: unknown) => {
      dlog('取不到目前登入者（GET /api/auth/me）', e);
      return null;
    });
    if (me) dlog('目前登入者（GET /api/auth/me）——這就是最終身分', me);
    addMsg('agent', `嗨${me ? ` ${me.name}` : ''}，我是用 SDK 自建 UI 的小幫手。想辦什麼？（試試「我要請假」）`);
  } catch (e) {
    booted = false; // 允許下次重試
    addMsg('sys', '初始化失敗：' + (e instanceof Error ? e.message : String(e)));
  }
}

function openChat(): void {
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  void ensureBooted();
  inputEl.focus();
}
function closeChat(): void {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
}

/**
 * 登出（整合手冊 §5.3，這段一定要做）：先 `await oa.logout()`，再送出本站自己的登出表單。
 *
 * headless 的 Session 只在本頁記憶體裡，導頁後瀏覽器這份自然消失——但 HyAgent 後端那張
 * 還活著，直到自然過期。`oa.logout()` 才會通知後端作廢它。
 *
 * 聊天室從沒開過就還沒建 client、也沒換過 Session，照原本的表單流程走即可。
 * `oa.logout()` 從不 reject，網路不通也只是略過通知，不會卡住導頁。
 */
const logoutForm = $('logout-form') as HTMLFormElement;
logoutForm.addEventListener('submit', async (e) => {
  if (!oa) return;
  e.preventDefault();
  (logoutForm.querySelector('button') as HTMLButtonElement).disabled = true; // 等待期間別讓人連按
  dlog('登出 → await oa.logout()：請 HyAgent 作廢 Session（POST /api/auth/logout）');
  await oa.logout();
  dlog('oa.logout() 完成 → 送出本站的登出表單（console 勾 Preserve log 才看得到這兩行）');
  logoutForm.submit(); // 程式呼叫 submit() 不會再觸發 submit 事件，不會繞回這裡
});

// 綁定：header / hero 按鈕開啟，面板關閉鈕收起，輸入互動
$('open-chat').onclick = openChat;
$('hero-chat').onclick = openChat;
$('close-chat').onclick = closeChat;
sendBtn.onclick = () => void send(inputEl.value);
submitBtn.onclick = () => void submit();
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) void send(inputEl.value);
});
