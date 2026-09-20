/**
 * Widget iframe ↔ 宿主頁的 postMessage 協定（規格 §6.6）。
 *
 * 改造前身分是靠 iframe URL 的 `?userToken=` 傳進面板的，那條路徑違反規格 §10.1
 * ——query string 會留在瀏覽器歷史、`Referer` header 與伺服器存取日誌裡，等同把
 * 一次性的身分憑證寫到三個不受控的地方。改為由面板主動向宿主頁要：
 *
 *   iframe → host   handshake          面板就緒，回報自身 origin 與版本
 *   iframe → host   identity:request   要求宿主頁呼叫 token provider
 *   host   → iframe identity:response  回傳 Assertion 或錯誤
 *   iframe → host   ui:close / ui:expand / event
 *   host   → iframe ui:state
 *
 * 兩個方向都**不得**使用 targetOrigin `"*"`（§6.6）：
 *   - 送出：一律指定 hostOrigin（widget.js 以 `?host=` 告知，退回 `document.referrer`）。
 *   - 接收：同時檢查 `event.origin` 與 `event.source`。兩者缺一不可——只驗 origin
 *     擋不住宿主頁上同源的其他 frame 冒充宿主，只驗 source 則擋不住宿主頁被導到他站。
 */
import { debugLog, maskToken } from './debugLog';
import { embedConfig } from './embedConfig';

export const MESSAGE_SOURCE = 'hyagent';
export const PROTOCOL_VERSION = 1;

/** 規格 §6.6 的訊息信封。非本形狀的訊息一律忽略。 */
export interface HyAgentMessage<T = unknown> {
  source: typeof MESSAGE_SOURCE;
  version: typeof PROTOCOL_VERSION;
  type: string;
  requestId?: string;
  payload?: T;
}

/** `identity:response` 的 payload：Assertion 與錯誤二擇一，兩者皆無視同未登入。 */
export interface IdentityResponsePayload {
  assertion?: string | null;
  error?: { code?: string; message?: string } | null;
}

/** `ui:state` 的 payload：宿主頁回報面板目前是否放大、以及這個視窗寬度能不能放大。 */
export interface UiStatePayload {
  expanded?: boolean;
  available?: boolean;
}

/**
 * 等待 `identity:response` 的上限。
 *
 * 規格 §6.5 的 10 秒是**宿主頁呼叫 token provider** 的逾時，不是這裡的。宿主頁在逾時後
 * 還要照 §6.5 做最多 3 次指數退避重試（1s / 2s / 4s），最壞情況約 47 秒才會放棄並回一則
 * 帶 error 的 identity:response。因此這裡的上限必須大於該預算，否則面板會在宿主頁仍在
 * 重試的期間就自行放棄。正常情況下宿主頁一定會回應，這個計時器只在宿主頁整個掛掉時才生效。
 */
export const IDENTITY_TIMEOUT_MS = 55_000;

function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    // opaque origin（about:blank、data: 等）不能當 targetOrigin 用
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/**
 * 決定 postMessage 的 targetOrigin。
 *
 * 以 widget.js 帶進來的 `?host=` 為準，`document.referrer` 為退路。
 *
 * ⚠️ **這個值不可用於任何安全判斷**：`?host=` 是宿主頁自己填進 iframe URL 的，
 * 誰都能寫成別人的網域。它只適合當 targetOrigin——填錯的後果是訊息送不到，
 * 而不是把權限交給錯的人。要判斷「誰把我們嵌起來」請用 embedderOrigin()。
 */
export function resolveHostOrigin(explicit: string | null): string | null {
  return (explicit ? originOf(explicit) : null) ?? (document.referrer ? originOf(document.referrer) : null);
}

/**
 * 嵌入本面板的頁面 origin，供後端做 §8.6 的來源白名單檢查。
 *
 * **只讀 `document.referrer`，刻意不吃 `?host=`。** 兩者的差別是這裡唯一重要的事：
 * referrer 由瀏覽器依載入來源設定，嵌入方只能「抑制」（Referrer-Policy）而無法「偽造」；
 * `?host=` 則是嵌入方自己寫的字串。安全判斷只能用前者。
 *
 * 讀不到時回 null，由後端 fail closed 拒絕——widget.js 會在自己建的 iframe 上明確指定
 * `referrerpolicy="origin"`，所以正常路徑一定讀得到；讀不到代表這個 iframe 不是我們建的，
 * 或嵌入方刻意隱藏了來源，兩種情況都不該放行。
 */
export function embedderOrigin(): string | null {
  return document.referrer ? originOf(document.referrer) : null;
}

function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface HostBridgeOptions {
  /** 宿主頁 origin；null 表示無法確定來源，橋接停用（面板以匿名模式運作） */
  hostOrigin: string | null;
  /** 宿主頁 window，預設 `window.parent`；未被嵌入時與 self 相同，橋接停用 */
  host?: Window | null;
  /** 面板自身 window，預設 `window`（測試注入用） */
  self?: Window;
}

export class HostBridge {
  readonly hostOrigin: string | null;
  private readonly host: Window | null;
  private readonly self: Window;

  constructor({ hostOrigin, host, self: selfWindow }: HostBridgeOptions) {
    this.self = selfWindow ?? window;
    this.host = host === undefined ? this.self.parent : host;
    this.hostOrigin = hostOrigin;
  }

  /** 未被嵌入、或無法確定宿主 origin 時為 false——此時一律不送、不收。 */
  get enabled(): boolean {
    return !!this.hostOrigin && !!this.host && this.host !== this.self;
  }

  /** 送一則訊息給宿主頁。targetOrigin 恆為 hostOrigin，絕不使用 `"*"`（§6.6）。 */
  send(type: string, payload?: unknown, requestId?: string): void {
    if (!this.enabled) return;
    const message: HyAgentMessage = { source: MESSAGE_SOURCE, version: PROTOCOL_VERSION, type };
    if (requestId !== undefined) message.requestId = requestId;
    if (payload !== undefined) message.payload = payload;
    try {
      this.host!.postMessage(message, this.hostOrigin!);
    } catch {
      // 宿主頁已關閉或 origin 不符：面板照常以匿名模式運作，不讓它中斷渲染
    }
  }

  /**
   * 訂閱某一型別的宿主訊息；回傳取消訂閱函式。
   *
   * 三重檢查缺一不可：`event.origin` 必須等於登記的 hostOrigin、`event.source` 必須
   * 是宿主頁那個 window、訊息本身必須帶 `source: "hyagent"` 的信封（§6.6）。
   */
  on<T = unknown>(type: string, handler: (message: HyAgentMessage<T>) => void): () => void {
    if (!this.enabled) return () => {};
    const listener = (e: MessageEvent) => {
      if (e.origin !== this.hostOrigin || e.source !== this.host) return;
      const data = e.data as HyAgentMessage<T> | null;
      if (!data || typeof data !== 'object') return;
      if (data.source !== MESSAGE_SOURCE || data.version !== PROTOCOL_VERSION) return;
      if (data.type !== type) return;
      handler(data);
    };
    this.self.addEventListener('message', listener as EventListener);
    return () => this.self.removeEventListener('message', listener as EventListener);
  }

  /** §6.6 `handshake`：面板就緒，回報自身 origin 與版本。 */
  handshake(): void {
    this.send('handshake', { origin: this.self.location.origin, version: PROTOCOL_VERSION });
  }

  /**
   * §6.6 `identity:request`：請宿主頁呼叫 token provider 取一張當下新簽發的 Assertion。
   *
   * 回傳 null 代表「以匿名模式運作」——使用者未登入宿主網站、宿主頁沒設 token provider、
   * 取票失敗或逾時，四者在面板這一端的處置相同：退回自行登入。回傳的字串**只存在記憶體裡**，
   * 用完即棄，不寫 storage、不進 URL（§6.5、§10.1）。
   */
  requestIdentity(timeoutMs: number = IDENTITY_TIMEOUT_MS): Promise<string | null> {
    if (!this.enabled) return Promise.resolve(null);
    const requestId = newRequestId();
    return new Promise<string | null>((resolve) => {
      let settled = false;
      let off: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (assertion: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        off?.();
        resolve(assertion);
      };

      off = this.on<IdentityResponsePayload>('identity:response', (message) => {
        // requestId 配對：宿主頁可能同時服務多個面板，回錯的那張不能收
        if (message.requestId !== requestId) return;
        const payload = message.payload ?? {};
        const assertion = typeof payload.assertion === 'string' ? payload.assertion.trim() : '';
        debugLog('② 收到宿主頁的 identity:response', {
          assertion: maskToken(assertion),
          error: payload.error ?? null,
        });
        finish(assertion || null);
      });
      timer = setTimeout(() => {
        debugLog('② 等不到 identity:response（逾時），改以匿名模式運作');
        finish(null);
      }, timeoutMs);
      debugLog('① 向宿主頁要求身分（identity:request）', { hostOrigin: this.hostOrigin, requestId });
      this.send('identity:request', null, requestId);
    });
  }
}

/** 由 iframe URL 參數建出的預設橋接（App 用這個；測試自行 new）。 */
export const hostBridge = new HostBridge({ hostOrigin: resolveHostOrigin(embedConfig.hostOrigin) });
