/**
 * widget.js（宿主側）的 postMessage 協定與 Token Provider（規格 §6.5、§6.6）。
 *
 * 取代改造前的 widget.tokenUrl.test.ts：當時的驗收基準是「token 有沒有串進 panel URL」，
 * 而規格 §10.1 明文禁止那條路徑，所以那組期望整個反過來了——現在要釘的是 URL 上**沒有**
 * 憑證，且憑證改由握手取得。
 *
 * widget.js 是給第三方網站直接嵌入的 vanilla IIFE，不是模組，所以這裡讀原始檔後以
 * new Function 執行，並先把一個假的 <script src=".../widget.js"> 掛進 DOM（jsdom 不會
 * 真的去載它）——widget.js 找不到 document.currentScript 時會回頭用 src 比對找回自己。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom 環境的 import.meta.url 是 http 網址（不能餵給 readFileSync），改用工作目錄推算。
// 從 repo 根目錄（npm test）與從 client/（npm test -w client）跑起來都要找得到。
const CANDIDATES = ['client/public/sdk/widget.js', 'public/sdk/widget.js'].map((p) => resolve(process.cwd(), p));
const WIDGET_PATH = CANDIDATES.find((p) => existsSync(p));
if (!WIDGET_PATH) throw new Error(`找不到 widget.js：${CANDIDATES.join(' / ')}`);
const SRC = readFileSync(WIDGET_PATH, 'utf-8');

const PANEL_ORIGIN = 'https://agent.example.com';
// 規格 §5.2 的範例路徑；端點在客戶自家網域裡，路徑本身不是規範值
const TOKEN_URL = '/api/mybot/identity';

interface Posted {
  message: { type: string; requestId?: string; payload?: Record<string, unknown> };
  targetOrigin: string;
}

/** 掛上 script 標籤並執行 widget.js */
function loadWidget(attrs: Record<string, string>): void {
  const script = document.createElement('script');
  script.src = `${PANEL_ORIGIN}/sdk/widget.js`;
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  document.body.appendChild(script);
  new Function(SRC)();
}

/** 點開面板（首次點開才會建立 iframe） */
function openPanel(): void {
  document.getElementById('oa-agent-launcher')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function panelIframe(): HTMLIFrameElement | null {
  return document.querySelector('#oa-agent-panel iframe');
}

function panelWindow(): Window {
  return panelIframe()!.contentWindow as Window;
}

/** 攔下 widget.js 送往面板的訊息 */
function watchPanelMessages(): Posted[] {
  const out: Posted[] = [];
  vi.spyOn(panelWindow(), 'postMessage').mockImplementation(((
    message: Posted['message'],
    targetOrigin: string,
  ) => {
    out.push({ message, targetOrigin });
  }) as typeof window.postMessage);
  return out;
}

/** 模擬面板送訊息給宿主；預設用合法的 origin/source/信封，測試再逐項破壞它 */
function panelSends(
  message: { type: string; requestId?: string; payload?: unknown; source?: string; version?: number },
  opts: { origin?: string; source?: Window | null } = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'hyagent', version: 1, ...message },
      origin: opts.origin ?? PANEL_ORIGIN,
      source: opts.source === undefined ? panelWindow() : opts.source,
    }),
  );
}

/** 依 URL 分流的假 fetch：外觀設定一律空物件，Identity Endpoint 由各測試指定 */
function mockFetch(...tokenResponses: Array<Partial<Response> & { json?: () => Promise<unknown> }>) {
  let i = 0;
  return vi.fn((url: string, _init?: RequestInit) => {
    if (String(url).includes('/api/widget/config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) } as Response);
    }
    const res = tokenResponses[Math.min(i, tokenResponses.length - 1)];
    i += 1;
    return Promise.resolve(res as Response);
  });
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status: number) => ({ ok: false, status, json: () => Promise.resolve({}) });

/** 等 identity:response 出現（provider 是非同步的） */
async function waitForIdentityResponse(posted: Posted[]): Promise<Posted> {
  await vi.waitFor(() => {
    expect(posted.some((p) => p.message.type === 'identity:response')).toBe(true);
  });
  return posted.find((p) => p.message.type === 'identity:response')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.getElementById('oa-agent-launcher-style')?.remove();
  delete (window as unknown as { __oaAgentWidgetLoaded?: boolean }).__oaAgentWidgetLoaded;
  delete (window as unknown as { OAAgent?: unknown }).OAAgent;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('panel URL 不再攜帶身分憑證（規格 §10.1）', () => {
  it('URL 只帶宿主 origin 與 identity 旗標，沒有任何 token', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-key': 'pk_test', 'data-token-url': TOKEN_URL });
    openPanel();

    const src = panelIframe()?.src ?? '';
    expect(src).not.toContain('userToken');
    expect(src).not.toContain('assertion');
    expect(src).toContain(`host=${encodeURIComponent(window.location.origin)}`);
    expect(src).toContain('identity=1');
  });

  it('未設 data-token-url 時不帶 identity=1，面板直接走自行登入', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-key': 'pk_test' });
    openPanel();

    expect(panelIframe()?.src).not.toContain('identity=1');
  });

  it('iframe 明確指定 referrerpolicy=origin，面板才讀得到「誰把它嵌起來」', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();

    // 元素層級的 referrerpolicy 優先於宿主頁的全域 Referrer-Policy，
    // 所以就算宿主頁設了 no-referrer，面板仍取得到來源（規格 §8.6 的判定依據）
    expect(panelIframe()?.referrerPolicy).toBe('origin');
  });

  it('點開面板即刻建立 iframe，不再被換票請求擋住', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();

    expect(panelIframe()).not.toBeNull(); // 同步建立
  });

  it('連點兩下只建一個 iframe', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    openPanel();

    expect(document.querySelectorAll('#oa-agent-panel iframe')).toHaveLength(1);
  });

  it('沿用舊的 data-user-token 會被忽略並警告（§6.5：靜態字串無法滿足一次性憑證）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-user-token': 'static-jwt' });
    openPanel();

    expect(panelIframe()?.src).not.toContain('static-jwt');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-user-token'));
  });
});

describe('握手與 Token Provider（規格 §6.5、§6.6）', () => {
  it('收到 handshake 後回報目前的放大狀態', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    panelSends({ type: 'handshake', payload: { origin: PANEL_ORIGIN, version: 1 } });

    const state = posted.find((p) => p.message.type === 'ui:state');
    expect(state).toBeDefined();
    expect(state?.targetOrigin).toBe(PANEL_ORIGIN); // 規格 §6.6：不得用 "*"
    expect(state?.message.payload).toMatchObject({ expanded: false });
  });

  it('identity:request → 向宿主端點取票 → identity:response 帶回同一個 requestId', async () => {
    const fetchMock = mockFetch(ok({ token: 'jwt-from-host' }));
    vi.stubGlobal('fetch', fetchMock);
    loadWidget({ 'data-key': 'pk_test', 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    panelSends({ type: 'identity:request', requestId: 'req-1' });
    const res = await waitForIdentityResponse(posted);

    const call = fetchMock.mock.calls.find(([url]) => String(url) === TOKEN_URL);
    expect(call).toBeDefined();
    // §5.2：GET、帶 cookie；no-store 避免拿到被快取的那張已用過的票
    expect(call?.[1]).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' });
    expect(res.targetOrigin).toBe(PANEL_ORIGIN);
    expect(res.message.requestId).toBe('req-1');
    expect(res.message.payload).toMatchObject({ assertion: 'jwt-from-host' });
  });

  it('回應為 {data:{token}} 形狀也接受', async () => {
    vi.stubGlobal('fetch', mockFetch(ok({ data: { token: 'wrapped-jwt' } })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    panelSends({ type: 'identity:request', requestId: 'req-2' });
    const res = await waitForIdentityResponse(posted);

    expect(res.message.payload).toMatchObject({ assertion: 'wrapped-jwt' });
  });

  it('未設 data-token-url 時直接回 NO_TOKEN_PROVIDER，不打任何端點', async () => {
    const fetchMock = mockFetch(ok({ token: 'jwt' }));
    vi.stubGlobal('fetch', fetchMock);
    loadWidget({ 'data-key': 'pk_test' });
    openPanel();
    const posted = watchPanelMessages();

    panelSends({ type: 'identity:request', requestId: 'req-3' });
    const res = await waitForIdentityResponse(posted);

    expect(res.message.payload).toMatchObject({ assertion: null, error: { code: 'NO_TOKEN_PROVIDER' } });
    expect(fetchMock.mock.calls.every(([url]) => String(url) !== TOKEN_URL)).toBe(true);
  });

  it('401（使用者未登入宿主網站）不重試，直接回匿名', async () => {
    const fetchMock = mockFetch(fail(401));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    panelSends({ type: 'identity:request', requestId: 'req-4' });
    const res = await waitForIdentityResponse(posted);

    expect(res.message.payload).toMatchObject({ assertion: null });
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_URL)).toHaveLength(1);
  });

  it('5xx 依 §6.5 退避重試 1s / 2s / 4s，共 4 次後放棄', async () => {
    const fetchMock = mockFetch(fail(503));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    vi.useFakeTimers();
    panelSends({ type: 'identity:request', requestId: 'req-5' });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect(fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_URL)).toHaveLength(4);
    const res = posted.find((p) => p.message.type === 'identity:response');
    expect(res?.message.payload).toMatchObject({
      assertion: null,
      error: { code: 'TOKEN_PROVIDER_FAILED' },
    });
  });

  it('重試期間恢復正常就拿到票', async () => {
    const fetchMock = mockFetch(fail(503), ok({ assertion: 'recovered' }));
    vi.stubGlobal('fetch', fetchMock);
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    const posted = watchPanelMessages();

    vi.useFakeTimers();
    panelSends({ type: 'identity:request', requestId: 'req-6' });
    await vi.advanceTimersByTimeAsync(1000);

    const res = posted.find((p) => p.message.type === 'identity:response');
    expect(res?.message.payload).toMatchObject({ assertion: 'recovered' });
  });
});

describe('收訊的三重檢查（規格 §6.6）', () => {
  function setup(): Posted[] {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    return watchPanelMessages();
  }

  it('origin 不符一律忽略', () => {
    const posted = setup();
    panelSends({ type: 'handshake' }, { origin: 'https://evil.example.com' });
    expect(posted).toHaveLength(0);
  });

  it('source 不是我們建的那個 iframe 就忽略', () => {
    const posted = setup();
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    panelSends({ type: 'handshake' }, { source: other.contentWindow });
    expect(posted).toHaveLength(0);
    other.remove();
  });

  it('沒有 hyagent 信封的舊格式訊息一律忽略', () => {
    const posted = setup();
    const onClose = vi.fn();
    window.addEventListener('oa-agent:close', onClose);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'oa-agent:close' },
        origin: PANEL_ORIGIN,
        source: panelWindow(),
      }),
    );

    expect(posted).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener('oa-agent:close', onClose);
  });
});

describe('UI 訊息與對宿主頁的事件轉發', () => {
  it('ui:close 收起面板，並沿用舊事件名派發給宿主頁', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    watchPanelMessages();
    const onClose = vi.fn();
    window.addEventListener('oa-agent:close', onClose);

    panelSends({ type: 'ui:close' });

    expect(document.getElementById('oa-agent-panel')?.style.opacity).toBe('0');
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener('oa-agent:close', onClose);
  });

  it('event 依 payload.name 派發 CustomEvent，detail 形狀與改造前相同', () => {
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    watchPanelMessages();
    const onSubmitted = vi.fn();
    window.addEventListener('oa-agent:submitted', onSubmitted as EventListener);

    panelSends({
      type: 'event',
      payload: { name: 'oa-agent:submitted', detail: { submission: { id: 'S1' } } },
    });

    expect(onSubmitted).toHaveBeenCalledTimes(1);
    const detail = (onSubmitted.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({ type: 'oa-agent:submitted', submission: { id: 'S1' } });
    window.removeEventListener('oa-agent:submitted', onSubmitted as EventListener);
  });

  it('OAAgent.onEvent 仍收得到轉發的事件', () => {
    const onEvent = vi.fn();
    (window as unknown as { OAAgent: { onEvent: unknown } }).OAAgent = { onEvent };
    vi.stubGlobal('fetch', mockFetch(ok({ token: 'jwt' })));
    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    watchPanelMessages();

    panelSends({ type: 'event', payload: { name: 'oa-agent:submitted', detail: { submission: null } } });

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'oa-agent:submitted' }));
  });
});
