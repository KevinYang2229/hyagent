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
 * 回 null＝使用者沒登入自家系統。真實站台此時應導向自家登入頁；本 demo 恆為已登入。
 */
async function fetchAssertion(): Promise<string | null> {
  const res = await fetch('/api/mybot/identity', {
    // 由自家的登入 Session 決定發給誰；端點不接受前端傳入的 user id（規格 §5.2）
    credentials: 'include',
    headers: { accept: 'application/json' },
    // 拿到快取的同一張等於重放，後端會以 TOKEN_REPLAYED 拒絕
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const { token } = (await res.json()) as { token?: string };
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
    // 首次換發。回 false＝provider 沒給票（使用者未登入自家系統），不是連線錯誤，
    // 所以要自己判斷——真實站台在這裡導向登入頁，而不是顯示「初始化失敗」。
    if (!(await oa.refreshIdentity())) throw new Error('Identity Endpoint 未回傳憑證');
    addMsg('agent', '嗨，我是用 SDK 自建 UI 的小幫手。想辦什麼？（試試「我要請假」）');
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

// 綁定：header / hero 按鈕開啟，面板關閉鈕收起，輸入互動
$('open-chat').onclick = openChat;
$('hero-chat').onclick = openChat;
$('close-chat').onclick = closeChat;
sendBtn.onclick = () => void send(inputEl.value);
submitBtn.onclick = () => void submit();
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) void send(inputEl.value);
});
