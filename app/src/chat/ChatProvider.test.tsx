import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PendingActionView } from '@hyagent/shared';
import type { Endpoints } from '@/api/endpoints';
import { ApiError } from '@/api/errors';
import { TaskBadgeProvider, useTaskBadge } from '@/tasks/TaskBadge';
import { ChatProvider, useChat } from './ChatProvider';

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
  const qc = new QueryClient();
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TaskBadgeProvider>
        <ChatProvider api={api}>{children}</ChatProvider>
      </TaskBadgeProvider>
    </QueryClientProvider>
  );
  const hook = await renderHook(() => ({ chat: useChat(), badge: useTaskBadge() }), { wrapper });
  return { ...hook, invalidate };
}

describe('ChatProvider', () => {
  it('第一句建立對話，之後用同一個對話送訊息', async () => {
    const api = fakeApi();
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('查庫存'); });
    expect(api.startConversation).toHaveBeenCalledWith('你好');
    expect(api.sendMessage).toHaveBeenCalledWith('c1', '查庫存');
    expect(result.current.chat.state.messages.map((m) => m.text)).toEqual(['你好', '回覆：你好', '查庫存', '回覆：查庫存']);
  });

  it('空白訊息不送；送出中再送被擋下', async () => {
    let release!: () => void;
    const api = fakeApi({
      startConversation: jest.fn(() => new Promise((r) => { release = () => r({ id: 'c1', status: 'collecting', reply: 'ok' }); })) as never,
    });
    const { result } = await setup(api);
    let first!: Promise<boolean>;
    await act(async () => {
      expect(await result.current.chat.send('   ')).toBe(false);
      first = result.current.chat.send('一');
      expect(await result.current.chat.send('二')).toBe(false);
      release();
      await first;
    });
    expect(api.startConversation).toHaveBeenCalledTimes(1);
  });

  it('對話已不存在（404）→ 自動重開一個對話再送', async () => {
    const api = fakeApi({ sendMessage: jest.fn(async () => { throw new ApiError('not found', 404, 'NOT_FOUND'); }) as never });
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('一'); });
    await act(async () => { expect(await result.current.chat.send('二')).toBe(true); });
    expect(api.startConversation).toHaveBeenLastCalledWith('二');
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

  it('confirm 成功 → done、紅點 +1、今日重點與補貨單失效、加結果訊息', async () => {
    const api = fakeApi();
    const { result, invalidate } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.chat.confirm({ items: [] }); });
    expect(outcome).toEqual({ kind: 'done', ok: true });
    expect(api.confirmAction).toHaveBeenCalledWith('c1', 'a1', { items: [] });
    expect(result.current.badge.count).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todaySummary'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['replenishments'] });
    expect(result.current.chat.state.pending).toBeNull();
  });

  it.each([
    [new ApiError('數量太大', 422, 'ACTION_INPUT_INVALID'), { kind: 'invalid', message: '數量太大' }, true],
    [new ApiError('稍後再試', 503, 'TOOL_UNAVAILABLE'), { kind: 'unavailable', message: '稍後再試' }, true],
    [new ApiError('逾時', 409, 'ACTION_EXPIRED'), { kind: 'gone' }, false],
  ])('confirm 錯誤 %p → %p（待確認動作是否保留：%p）', async (err, expected, keeps) => {
    const api = fakeApi({ confirmAction: jest.fn(async () => { throw err; }) as never });
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    let outcome: unknown;
    await act(async () => { outcome = await result.current.chat.confirm(); });
    expect(outcome).toEqual(expected);
    expect(result.current.chat.state.pending !== null).toBe(keeps);
    expect(result.current.badge.count).toBe(0);
  });

  it('cancel → 清掉待確認、加取消訊息、不加紅點', async () => {
    const api = fakeApi();
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.propose('t', {}); });
    await act(async () => { await result.current.chat.cancel(); });
    expect(api.cancelAction).toHaveBeenCalledWith('c1', 'a1');
    expect(result.current.chat.state.pending).toBeNull();
    expect(result.current.chat.state.messages.at(-1)).toMatchObject({ text: '已取消「建立補貨單」。' });
    expect(result.current.badge.count).toBe(0);
  });

  it('newConversation 清空對話', async () => {
    const { result } = await setup(fakeApi());
    await act(async () => { await result.current.chat.send('一'); });
    await act(async () => { result.current.chat.newConversation(); });
    expect(result.current.chat.state.conversationId).toBeNull();
    expect(result.current.chat.state.messages).toEqual([]);
  });
});
