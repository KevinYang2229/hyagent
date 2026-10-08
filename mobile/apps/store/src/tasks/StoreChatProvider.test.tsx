import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PendingActionView } from '@hyagent/shared';
import type { Endpoints } from '@hyagent/app-core/api/endpoints';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { StoreChatProvider } from './StoreChatProvider';
import { TaskBadgeProvider, useTaskBadge } from './TaskBadge';

jest.mock('@hyagent/app-core/auth/AuthProvider', () => ({
  useAuth: jest.fn(() => { throw new Error('no AuthProvider'); }),
  useApi: jest.fn(() => { throw new Error('no AuthProvider'); }),
}));

const pending: PendingActionView = { id: 'a1', summary: { title: '建立補貨單', fields: [] }, expiresAt: '2099-01-01T00:00:00.000Z' };

function fakeApi(actionOk: boolean): Endpoints {
  return {
    startConversation: jest.fn(async () => ({ id: 'c1', status: 'collecting', reply: null })),
    proposeAction: jest.fn(async () => ({ pendingAction: pending })),
    confirmAction: jest.fn(async () => ({ status: 'collecting', reply: '完成', actionOk })),
  } as unknown as Endpoints;
}

async function setup(api: Endpoints) {
  const qc = new QueryClient();
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TaskBadgeProvider>
        <StoreChatProvider api={api}>{children}</StoreChatProvider>
      </TaskBadgeProvider>
    </QueryClientProvider>
  );
  const hook = await renderHook(() => ({ chat: useChat(), badge: useTaskBadge() }), { wrapper });
  return { ...hook, invalidate };
}

it('寫入動作成功 → 紅點 +1、今日重點與補貨單失效', async () => {
  const { result, invalidate } = await setup(fakeApi(true));
  await act(async () => { await result.current.chat.propose('t', {}); });
  await act(async () => { await result.current.chat.confirm(); });
  expect(result.current.badge.count).toBe(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todaySummary'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['replenishments'] });
});

it('執行失敗 → 不加紅點、不刷新', async () => {
  const { result, invalidate } = await setup(fakeApi(false));
  await act(async () => { await result.current.chat.propose('t', {}); });
  await act(async () => { await result.current.chat.confirm(); });
  expect(result.current.badge.count).toBe(0);
  expect(invalidate).not.toHaveBeenCalled();
});
