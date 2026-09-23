/**
 * 面板側的 postMessage 協定（規格 §6.6）。
 *
 * 這裡釘住的是**安全性質**而非流程：targetOrigin 不得是 "*"、收訊必須同時驗
 * origin 與 source、identity:response 必須配對 requestId。這三條錯了不會有任何
 * 功能症狀——面板照樣運作，只是身分憑證多了一條可被旁邊的 frame 攔截的路徑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HostBridge,
  MESSAGE_SOURCE,
  embedderOrigin,
  PROTOCOL_VERSION,
  resolveHostOrigin,
  type HyAgentMessage,
} from './hostBridge';

const HOST_ORIGIN = 'https://oa.example.com';

/** 以一個真的 iframe window 當宿主頁：MessageEvent 的 source 只收得下真正的 WindowProxy。 */
let hostFrame: HTMLIFrameElement;
let hostWindow: Window;
let posted: Array<{ message: HyAgentMessage; targetOrigin: string }>;

function makeBridge(hostOrigin: string | null = HOST_ORIGIN): HostBridge {
  return new HostBridge({ hostOrigin, host: hostWindow, self: window });
}

/** 模擬宿主頁送訊息進來；預設用合法的 origin/source/信封，測試再逐項破壞它。 */
function hostSends(
  message: Partial<HyAgentMessage> & { type: string },
  opts: { origin?: string; source?: Window | null } = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: MESSAGE_SOURCE, version: PROTOCOL_VERSION, ...message },
      origin: opts.origin ?? HOST_ORIGIN,
      source: opts.source === undefined ? hostWindow : opts.source,
    }),
  );
}

beforeEach(() => {
  posted = [];
  hostFrame = document.createElement('iframe');
  document.body.appendChild(hostFrame);
  hostWindow = hostFrame.contentWindow as Window;
  vi.spyOn(hostWindow, 'postMessage').mockImplementation(((
    message: HyAgentMessage,
    targetOrigin: string,
  ) => {
    posted.push({ message, targetOrigin });
  }) as typeof hostWindow.postMessage);
});

afterEach(() => {
  hostFrame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveHostOrigin', () => {
  it('以 widget.js 帶進來的 ?host= 為準', () => {
    expect(resolveHostOrigin('https://oa.example.com/some/path')).toBe(HOST_ORIGIN);
  });

  it('無法解析的值回 null，而不是硬湊一個 origin 出去', () => {
    expect(resolveHostOrigin('not-a-url')).toBeNull();
    expect(resolveHostOrigin('')).toBeNull();
    expect(resolveHostOrigin(null)).toBeNull();
  });
});

describe('embedderOrigin（規格 §8.6 的來源判定）', () => {
  function withReferrer(value: string, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => value });
    try {
      fn();
    } finally {
      Object.defineProperty(document, 'referrer', original ?? { configurable: true, get: () => '' });
    }
  }

  it('取 document.referrer 的 origin', () => {
    withReferrer('https://oa.example.com/some/page?q=1', () => {
      expect(embedderOrigin()).toBe('https://oa.example.com');
    });
  });

  it('referrer 被抑制時回 null，讓後端 fail closed', () => {
    withReferrer('', () => {
      expect(embedderOrigin()).toBeNull();
    });
  });

  it('**不**採用 ?host=——那是宿主頁自己填的，誰都能寫成別人的網域', () => {
    // resolveHostOrigin 會吃 ?host=（targetOrigin 用途，填錯只是訊息送不到）；
    // embedderOrigin 不吃，因為它的結果會變成放行與否的依據。
    expect(resolveHostOrigin('https://attacker-claims-this.example.com')).toBe(
      'https://attacker-claims-this.example.com',
    );
    withReferrer('', () => {
      expect(embedderOrigin()).toBeNull();
    });
  });
});

describe('HostBridge 送訊息', () => {
  it('targetOrigin 是宿主 origin，不是 "*"', () => {
    makeBridge().send('ui:close');
    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(HOST_ORIGIN);
    expect(posted[0].message).toMatchObject({
      source: MESSAGE_SOURCE,
      version: PROTOCOL_VERSION,
      type: 'ui:close',
    });
  });

  it('handshake 回報自身 origin 與協定版本', () => {
    makeBridge().handshake();
    expect(posted[0].message.type).toBe('handshake');
    expect(posted[0].message.payload).toMatchObject({ version: PROTOCOL_VERSION });
  });

  it('無法確定宿主 origin 時完全不送——寧可退回匿名，也不對未知對象廣播', () => {
    makeBridge(null).send('ui:close');
    expect(posted).toHaveLength(0);
  });

  it('未被嵌入（host === self）時不送', () => {
    new HostBridge({ hostOrigin: HOST_ORIGIN, host: window, self: window }).send('ui:close');
    expect(posted).toHaveLength(0);
  });
});

describe('HostBridge 收訊息', () => {
  it('合法訊息才交給 handler', () => {
    const handler = vi.fn();
    makeBridge().on('ui:state', handler);
    hostSends({ type: 'ui:state', payload: { expanded: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload).toEqual({ expanded: true });
  });

  it('origin 不符一律忽略（宿主頁被導到他站後的殘留 frame）', () => {
    const handler = vi.fn();
    makeBridge().on('ui:state', handler);
    hostSends({ type: 'ui:state' }, { origin: 'https://evil.example.com' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('source 不符一律忽略——同源的其他 frame 冒充宿主時 origin 檢查擋不住', () => {
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    const handler = vi.fn();
    makeBridge().on('ui:state', handler);
    hostSends({ type: 'ui:state' }, { source: other.contentWindow });
    expect(handler).not.toHaveBeenCalled();
    other.remove();
  });

  it('信封不對（缺 source / 版本不符）一律忽略', () => {
    const handler = vi.fn();
    makeBridge().on('ui:state', handler);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ui:state' },
        origin: HOST_ORIGIN,
        source: hostWindow,
      }),
    );
    hostSends({ type: 'ui:state', version: 99 as unknown as typeof PROTOCOL_VERSION });
    expect(handler).not.toHaveBeenCalled();
  });

  it('取消訂閱後不再收到', () => {
    const handler = vi.fn();
    const off = makeBridge().on('ui:state', handler);
    off();
    hostSends({ type: 'ui:state' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('HostBridge.requestIdentity', () => {
  /** 送出 identity:request 後取出宿主頁該回應的 requestId */
  function pendingRequestId(): string {
    const req = posted.find((p) => p.message.type === 'identity:request');
    expect(req).toBeDefined();
    expect(typeof req!.message.requestId).toBe('string');
    return req!.message.requestId as string;
  }

  it('收到配對的 identity:response 後回傳 Assertion', async () => {
    const bridge = makeBridge();
    const pending = bridge.requestIdentity(1000);
    hostSends({
      type: 'identity:response',
      requestId: pendingRequestId(),
      payload: { assertion: 'eyJhbGciOiJSUzI1NiIs' },
    });
    await expect(pending).resolves.toBe('eyJhbGciOiJSUzI1NiIs');
  });

  it('requestId 不符的回應不採用——宿主頁同時服務多個面板時不能收錯張', async () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    const pending = bridge.requestIdentity(1000);
    hostSends({ type: 'identity:response', requestId: 'someone-else', payload: { assertion: 'x' } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('宿主頁回錯誤（使用者未登入）時回 null，面板落回自行登入', async () => {
    const bridge = makeBridge();
    const pending = bridge.requestIdentity(1000);
    hostSends({
      type: 'identity:response',
      requestId: pendingRequestId(),
      payload: { assertion: null, error: { code: 'TOKEN_PROVIDER_FAILED' } },
    });
    await expect(pending).resolves.toBeNull();
  });

  it('宿主頁完全不回應時逾時回 null，不會無限等待', async () => {
    vi.useFakeTimers();
    const pending = makeBridge().requestIdentity(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('未被嵌入時直接回 null，不送任何訊息', async () => {
    await expect(makeBridge(null).requestIdentity(1000)).resolves.toBeNull();
    expect(posted).toHaveLength(0);
  });
});
