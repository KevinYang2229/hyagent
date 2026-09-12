/**
 * widget.js 的 SSO 換票流程（data-token-url）。
 *
 * widget.js 是給第三方網站直接嵌入的 vanilla IIFE，不是模組，所以這裡讀原始檔後
 * 以 new Function 執行，並先把一個假的 <script src=".../widget.js"> 掛進 DOM
 *（jsdom 不會真的去載它）——widget.js 找不到 document.currentScript 時會回頭
 * 用 src 比對找回自己，測試正好走這條路。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom 環境的 import.meta.url 是 http 網址（不能餵給 readFileSync），改用工作目錄推算。
// 從 repo 根目錄（npm test）與從 client/（npm test -w client）跑起來都要找得到。
const CANDIDATES = ['client/public/widget.js', 'public/widget.js'].map((p) => resolve(process.cwd(), p));
const WIDGET_PATH = CANDIDATES.find((p) => existsSync(p));
if (!WIDGET_PATH) throw new Error(`找不到 widget.js：${CANDIDATES.join(' / ')}`);
const SRC = readFileSync(WIDGET_PATH, 'utf-8');

const TOKEN_URL = '/api/agent/widget-token';

/** 掛上 script 標籤並執行 widget.js */
function loadWidget(attrs: Record<string, string>): void {
  const script = document.createElement('script');
  script.src = 'https://agent.example.com/widget.js';
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

/** 依 URL 分流的假 fetch：外觀設定一律空物件，換票端點由各測試指定 */
function mockFetch(tokenResponse: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.fn((url: string, _init?: RequestInit) => {
    if (String(url).includes('/api/widget/config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) } as Response);
    }
    return Promise.resolve(tokenResponse as Response);
  });
}

describe('widget.js data-token-url 換票', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getElementById('oa-agent-launcher-style')?.remove();
    delete (window as unknown as { __oaAgentWidgetLoaded?: boolean }).__oaAgentWidgetLoaded;
    delete (window as unknown as { OAAgent?: unknown }).OAAgent;
    vi.restoreAllMocks();
  });

  it('點開面板前先向宿主端點換票，token 串進 panel URL', async () => {
    const fetchMock = mockFetch({ ok: true, json: () => Promise.resolve({ token: 'jwt-from-host' }) });
    vi.stubGlobal('fetch', fetchMock);

    loadWidget({ 'data-key': 'pk_test', 'data-token-url': TOKEN_URL });
    openPanel();
    await vi.waitFor(() => expect(panelIframe()).not.toBeNull());

    const call = fetchMock.mock.calls.find(([url]) => String(url) === TOKEN_URL);
    expect(call).toBeDefined();
    // 同源 cookie 換票：宿主用自己的登入狀態決定發給誰
    expect(call?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(panelIframe()?.src).toContain('userToken=jwt-from-host');
  });

  it('回應為 {data:{token}} 形狀也接受', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, json: () => Promise.resolve({ data: { token: 'wrapped-jwt' } }) }),
    );

    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    await vi.waitFor(() => expect(panelIframe()).not.toBeNull());

    expect(panelIframe()?.src).toContain('userToken=wrapped-jwt');
  });

  it('換票失敗時面板照常開啟，只是不帶 token（使用者自行登入）', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, json: () => Promise.resolve({}) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    await vi.waitFor(() => expect(panelIframe()).not.toBeNull());

    expect(panelIframe()?.src).not.toContain('userToken=');
    expect(warn).toHaveBeenCalled();
  });

  it('未設 data-token-url 時不打換票端點', async () => {
    const fetchMock = mockFetch({ ok: true, json: () => Promise.resolve({ token: 'x' }) });
    vi.stubGlobal('fetch', fetchMock);

    loadWidget({ 'data-key': 'pk_test' });
    openPanel();

    expect(panelIframe()).not.toBeNull(); // 同步建立，時序與改造前相同
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/api/widget/config'))).toBe(true);
  });

  it('宿主已直接給 data-user-token 時優先沿用，不再換票', async () => {
    const fetchMock = mockFetch({ ok: true, json: () => Promise.resolve({ token: 'ignored' }) });
    vi.stubGlobal('fetch', fetchMock);

    loadWidget({ 'data-token-url': TOKEN_URL, 'data-user-token': 'static-jwt' });
    openPanel();

    expect(panelIframe()?.src).toContain('userToken=static-jwt');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === TOKEN_URL)).toBe(false);
  });

  it('連點兩下只換一次票、只建一個 iframe', async () => {
    const fetchMock = mockFetch({ ok: true, json: () => Promise.resolve({ token: 'jwt' }) });
    vi.stubGlobal('fetch', fetchMock);

    loadWidget({ 'data-token-url': TOKEN_URL });
    openPanel();
    openPanel();
    await vi.waitFor(() => expect(panelIframe()).not.toBeNull());

    expect(fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_URL)).toHaveLength(1);
    expect(document.querySelectorAll('#oa-agent-panel iframe')).toHaveLength(1);
  });
});
