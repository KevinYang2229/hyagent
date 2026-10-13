import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { PendingActionView } from '@hyagent/shared';
import type { Endpoints } from '@hyagent/app-core/api/endpoints';
import { ApiError } from '@hyagent/app-core/api/errors';
import { useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { ChatProvider, MAX_QUEUED, useChat } from './ChatProvider';

// 測試用：不掛真的 AuthProvider，由 mockAuthStatus 控制登入狀態；預設（undefined）等同沒有 AuthProvider
jest.mock('@hyagent/app-core/auth/AuthProvider', () => ({ useAuth: jest.fn(), useApi: jest.fn() }));
let mockAuthStatus: string | undefined;
beforeEach(() => {
  mockAuthStatus = undefined;
  (useAuth as jest.Mock).mockImplementation(() => {
    if (mockAuthStatus === undefined) throw new Error('no AuthProvider');
    return { status: mockAuthStatus };
  });
  const { useApi } = jest.requireMock('@hyagent/app-core/auth/AuthProvider');
  useApi.mockImplementation(() => { throw new Error('no AuthProvider'); });
});

const pending: PendingActionView = { id: 'a1', summary: { title: '建立補貨單', fields: [] }, expiresAt: '2099-01-01T00:00:00.000Z' };

function fakeApi(over: Partial<Endpoints> = {}): Endpoints {
  return {
    startConversation: jest.fn(async (m?: string) => ({ id: 'c1', status: 'collecting', reply: m ? `回覆：${m}` : null })),
    sendMessage: jest.fn(async (_id: string, m: string) => ({ status: 'collecting', reply: `回覆：${m}` })),
    proposeAction: jest.fn(async () => ({ pendingAction: pending })),
    confirmAction: jest.fn(async () => ({ status: 'collecting', reply: '已完成「建立補貨單」。', actionOk: true })),
    cancelAction: jest.fn(async () => ({ status: 'collecting', reply: '已取消「建立補貨單」。' })),
    ...over,
  } as unknown as Endpoints;
}

async function setup(api: Endpoints) {
  const onActionConfirmed = jest.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ChatProvider api={api} onActionConfirmed={onActionConfirmed}>{children}</ChatProvider>
  );
  const hook = await renderHook(() => ({ chat: useChat() }), { wrapper });
  return { ...hook, onActionConfirmed };
}

describe('ChatProvider', () => {
  it('rate 以訊息自己的對話 id 送出；對話重開後評價舊訊息仍送到原對話', async () => {
    const api = fakeApi({
      // 第二次送出時舊對話已不存在（404）→ 自動重開成 c2，訊息串保留
      sendMessage: jest.fn()
        .mockResolvedValueOnce({ status: 'collecting', reply: '舊回覆', replyId: 'r-old' })
        .mockRejectedValueOnce(new ApiError('找不到對話', 404)),
      startConversation: jest.fn()
        .mockResolvedValueOnce({ id: 'c1', status: 'collecting', reply: null })
        .mockResolvedValueOnce({ id: 'c2', status: 'collecting', reply: '新回覆', replyId: 'r-new' }),
      setFeedback: jest.fn(async (_c: string, _r: string, input: unknown) => input),
    } as never);
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('查庫存'); });
    const msg = result.current.chat.state.messages.find((m) => m.role === 'agent' && 'replyId' in m && m.replyId === 'r-old')!;
    await act(async () => { await result.current.chat.send('再問'); });
    expect(result.current.chat.state.conversationId).toBe('c2');
    await act(async () => { await result.current.chat.rate(msg.id, { rating: 'up' }); });
    expect(api.setFeedback).toHaveBeenCalledWith('c1', 'r-old', { rating: 'up' });
    expect(result.current.chat.state.messages.find((m) => m.id === msg.id)).toMatchObject({ feedback: { rating: 'up' } });
  });

  it('rate 失敗時還原並回 false', async () => {
    const api = fakeApi({
      sendMessage: jest.fn(async () => ({ status: 'collecting', reply: '答', replyId: 'r1' })),
      startConversation: jest.fn(async () => ({ id: 'c1', status: 'collecting', reply: null })),
      setFeedback: jest.fn(async () => { throw new ApiError('這則回覆已無法評價', 404); }),
    } as never);
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('再問'); });
    const msg = result.current.chat.state.messages.find((m) => m.role === 'agent' && 'replyId' in m && m.replyId)!;
    let ok = true;
    await act(async () => { ok = await result.current.chat.rate(msg.id, { rating: 'down' }); });
    expect(ok).toBe(false);
    expect(result.current.chat.state.messages.find((m) => m.id === msg.id)).not.toHaveProperty('feedback');
  });

  it('第一句建立對話，之後用同一個對話送訊息', async () => {
    const api = fakeApi();
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('查庫存'); });
    expect(api.startConversation).toHaveBeenCalledWith('你好', expect.any(AbortSignal));
    expect(api.sendMessage).toHaveBeenCalledWith('c1', '查庫存', expect.any(AbortSignal));
    expect(result.current.chat.state.messages.map((m) => m.text)).toEqual(['你好', '回覆：你好', '查庫存', '回覆：查庫存']);
  });

  it.each([false, true])('取消等待後可重新送出，舊回覆不會插入（既有對話：%s）', async (existing) => {
    let release!: (value: unknown) => void;
    const delayed = jest.fn((_id?: string, _message?: string, _signal?: AbortSignal) => new Promise((resolve) => { release = resolve; }));
    const api = fakeApi();
    const { result } = await setup(api);
    if (existing) {
      await act(async () => { await result.current.chat.send('先前訊息'); });
      api.sendMessage = delayed as never;
    } else {
      api.startConversation = delayed as never;
    }
    let request!: Promise<boolean>;
    await act(async () => { request = result.current.chat.send('取消這句'); });
    const signal = delayed.mock.calls[0][existing ? 2 : 1] as AbortSignal;
    await act(async () => { result.current.chat.cancelSend(); result.current.chat.cancelSend(); });
    expect(signal.aborted).toBe(true);
    expect(result.current.chat.state.sending).toBe(false);
    expect(result.current.chat.state.messages.at(-1)).toMatchObject({ text: '已取消回覆。', tone: 'info' });
    api.startConversation = jest.fn(async () => ({ id: 'c2', status: 'collecting', reply: '新回覆' })) as never;
    await act(async () => { expect(await result.current.chat.send('重新送出')).toBe(true); });
    await act(async () => { release({ id: 'old', status: 'collecting', reply: '舊回覆' }); expect(await request).toBe(false); });
    expect(result.current.chat.state.conversationId).toBe('c2');
    expect(result.current.chat.state.messages.some((m) => m.text === '舊回覆')).toBe(false);
    expect(result.current.chat.state.messages.at(-1)?.text).toBe('新回覆');
  });

  it('空白訊息不送；送出中再送 → 排隊，這一輪結束後依序送出', async () => {
    let release!: () => void;
    const api = fakeApi({
      startConversation: jest.fn(() => new Promise((r) => { release = () => r({ id: 'c1', status: 'collecting', reply: 'ok' }); })) as never,
    });
    const { result } = await setup(api);
    let first!: Promise<boolean>;
    await act(async () => {
      expect(await result.current.chat.send('   ')).toBe(false);
      first = result.current.chat.send('一');
      expect(await result.current.chat.send('二')).toBe(true);
      expect(await result.current.chat.send('三')).toBe(true);
    });
    // 排隊中的句子還沒送出，也還沒有使用者泡泡
    expect(result.current.chat.state.messages.map((m) => m.text)).toEqual(['一']);
    await act(async () => { release(); await first; });
    expect(api.startConversation).toHaveBeenCalledTimes(1);
    expect((api.sendMessage as jest.Mock).mock.calls.map((c) => c[1])).toEqual(['二', '三']);
    expect(result.current.chat.state.messages.map((m) => m.text)).toEqual(['一', 'ok', '二', '回覆：二', '三', '回覆：三']);
    expect(result.current.chat.state.sending).toBe(false);
  });

  it('排隊最多 MAX_QUEUED 句，滿了回 false', async () => {
    let release!: () => void;
    const api = fakeApi({
      startConversation: jest.fn(() => new Promise((r) => { release = () => r({ id: 'c1', status: 'collecting', reply: 'ok' }); })) as never,
    });
    const { result } = await setup(api);
    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.chat.send('一');
      for (let i = 0; i < MAX_QUEUED; i += 1) expect(await result.current.chat.send(`排${i}`)).toBe(true);
      expect(await result.current.chat.send('太多')).toBe(false);
    });
    await act(async () => { release(); await first; });
    expect(api.sendMessage).toHaveBeenCalledTimes(MAX_QUEUED);
  });

  it.each(['newConversation', 'cancelSend'] as const)('%s 清掉排隊中的句子', async (method) => {
    let release!: () => void;
    const api = fakeApi({
      startConversation: jest.fn(() => new Promise((r) => { release = () => r({ id: 'c1', status: 'collecting', reply: 'ok' }); })) as never,
    });
    const { result } = await setup(api);
    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.chat.send('一');
      await result.current.chat.send('二');
    });
    await act(async () => { result.current.chat[method](); });
    await act(async () => { release(); await first; });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.current.chat.state.messages.some((m) => m.text === '二')).toBe(false);
    expect(result.current.chat.state.sending).toBe(false);
  });

  it('對話已不存在（404）→ 自動重開一個對話再送', async () => {
    const api = fakeApi({ sendMessage: jest.fn(async () => { throw new ApiError('not found', 404, 'NOT_FOUND'); }) as never });
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('一'); });
    await act(async () => { expect(await result.current.chat.send('二')).toBe(true); });
    expect(api.startConversation).toHaveBeenLastCalledWith('二', expect.any(AbortSignal));
  });

  it('送出失敗 → 回 false、加錯誤訊息', async () => {
    const api = fakeApi({ startConversation: jest.fn(async () => { throw new ApiError('無法連線到伺服器，請檢查網路', 0, 'NETWORK'); }) as never });
    const { result } = await setup(api);
    await act(async () => { expect(await result.current.chat.send('一')).toBe(false); });
    expect(result.current.chat.state.messages.at(-1)).toMatchObject({ role: 'system', tone: 'error' });
  });

  it('propose：沒有對話時先建立空對話，再記下待確認動作', async () => {
    const api = fakeApi();
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.propose('mcp.store-demo.replenishment_create', { items: [] }); });
    expect(api.startConversation).toHaveBeenCalledWith();
    expect(api.proposeAction).toHaveBeenCalledWith('c1', 'mcp.store-demo.replenishment_create', { items: [] });
    expect(result.current.chat.state.pending).toEqual(pending);
  });

  it('confirm 成功 → done、通知 App 動作已執行、加結果訊息', async () => {
    const api = fakeApi();
    const { result, onActionConfirmed } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.chat.confirm({ items: [] }); });
    expect(outcome).toEqual({ kind: 'done', ok: true });
    expect(api.confirmAction).toHaveBeenCalledWith('c1', 'a1', { items: [] });
    expect(onActionConfirmed).toHaveBeenCalledTimes(1);
    expect(result.current.chat.state.pending).toBeNull();
  });

  it.each([
    [new ApiError('數量太大', 422, 'ACTION_INPUT_INVALID'), { kind: 'invalid', message: '數量太大' }, true],
    [new ApiError('稍後再試', 503, 'TOOL_UNAVAILABLE'), { kind: 'unavailable', message: '稍後再試' }, true],
    [new ApiError('逾時', 409, 'ACTION_EXPIRED'), { kind: 'gone' }, false],
  ])('confirm 錯誤 %p → %p（待確認動作是否保留：%p）', async (err, expected, keeps) => {
    const api = fakeApi({ confirmAction: jest.fn(async () => { throw err; }) as never });
    const { result, onActionConfirmed } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.chat.confirm(); });
    expect(outcome).toEqual(expected);
    expect(result.current.chat.state.pending !== null).toBe(keeps);
    expect(onActionConfirmed).not.toHaveBeenCalled();
  });

  it('cancel → 清掉待確認、加取消訊息、不通知 App', async () => {
    const api = fakeApi();
    const { result, onActionConfirmed } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    await act(async () => { await result.current.chat.cancel(); });
    expect(api.cancelAction).toHaveBeenCalledWith('c1', 'a1');
    expect(result.current.chat.state.pending).toBeNull();
    expect(result.current.chat.state.messages.at(-1)).toMatchObject({ text: '已取消「建立補貨單」。' });
    expect(onActionConfirmed).not.toHaveBeenCalled();
  });

  it('newConversation 清空對話', async () => {
    const { result } = await setup(fakeApi());
    await act(async () => { await result.current.chat.send('一'); });
    await act(async () => { result.current.chat.newConversation(); });
    expect(result.current.chat.state.conversationId).toBeNull();
    expect(result.current.chat.state.messages).toEqual([]);
  });

  it('登入狀態離開 signedIn → 清掉訊息、對話 id、待確認動作', async () => {
    mockAuthStatus = 'signedIn';
    const { result, rerender } = await setup(fakeApi());
    await act(async () => { await result.current.chat.send('一'); });
    await act(async () => { await result.current.chat.propose('t', {}); });
    expect(result.current.chat.state.pending).not.toBeNull();
    mockAuthStatus = 'signedOut';
    await rerender({});
    expect(result.current.chat.state).toMatchObject({ conversationId: null, messages: [], pending: null, sending: false });
  });

  it('第一句送出中 propose → 只建立一次對話、沿用該 id、sending 維持到送出結束', async () => {
    let release!: () => void;
    const api = fakeApi({
      startConversation: jest.fn(() => new Promise((r) => { release = () => r({ id: 'c1', status: 'collecting', reply: 'ok' }); })) as never,
    });
    const { result } = await setup(api);
    let sendP!: Promise<boolean>;
    let proposeP!: Promise<void>;
    await act(async () => {
      sendP = result.current.chat.send('一');
      proposeP = result.current.chat.propose('t', {});
    });
    expect(result.current.chat.state.sending).toBe(true);
    await act(async () => { release(); await sendP; await proposeP; });
    expect(api.startConversation).toHaveBeenCalledTimes(1);
    expect(api.proposeAction).toHaveBeenCalledWith('c1', 't', {});
    expect(result.current.chat.state.sending).toBe(false);
    expect(result.current.chat.state.pending).toEqual(pending);
  });

  it('propose 遇到失效的對話 id（404）→ 重開對話並重試成功', async () => {
    const proposeAction = jest.fn()
      .mockRejectedValueOnce(new ApiError('not found', 404, 'NOT_FOUND'))
      .mockResolvedValue({ pendingAction: pending });
    let n = 0;
    const startConversation = jest.fn(async (m?: string) => ({ id: `c${++n}`, status: 'collecting', reply: m ? 'r' : null }));
    const api = fakeApi({ proposeAction: proposeAction as never, startConversation: startConversation as never });
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    expect(startConversation).toHaveBeenCalledTimes(2);
    expect(proposeAction).toHaveBeenLastCalledWith('c2', 't', {});
    expect(result.current.chat.state).toMatchObject({ conversationId: 'c2', pending });
  });

  it('confirm 404 → gone，待確認動作清掉', async () => {
    const api = fakeApi({ confirmAction: jest.fn(async () => { throw new ApiError('nf', 404, 'NOT_FOUND'); }) as never });
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.chat.confirm(); });
    expect(outcome).toEqual({ kind: 'gone' });
    expect(result.current.chat.state.pending).toBeNull();
    expect(result.current.chat.state.messages.at(-1)).toMatchObject({ role: 'system', tone: 'info' });
  });
});
