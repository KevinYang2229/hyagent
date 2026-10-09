import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Endpoints } from '@hyagent/app-core/api/endpoints';
import { ChatProvider, useChat } from '@hyagent/app-core/chat/ChatProvider';
import { AdvisorProvider, useAdvisor } from './AdvisorProvider';

jest.mock('@hyagent/app-core/auth/AuthProvider', () => ({
  useAuth: jest.fn(() => { throw new Error('no AuthProvider'); }),
  useApi: jest.fn(() => { throw new Error('no AuthProvider'); }),
}));

function setup() {
  const api = {
    startConversation: jest.fn(async (message?: string) => ({ id: 'c1', status: 'collecting', reply: `回覆：${message}` })),
  } as unknown as Endpoints;
  const wrapper = ({ children }: { children: ReactNode }) => <ChatProvider api={api}><AdvisorProvider>{children}</AdvisorProvider></ChatProvider>;
  return { api, wrapper };
}

it('show() 只打開面板，不送任何訊息', async () => {
  const { api, wrapper } = setup();
  const { result } = await renderHook(() => ({ advisor: useAdvisor(), chat: useChat() }), { wrapper });
  expect(result.current.advisor.open).toBe(false);
  await act(async () => { result.current.advisor.show(); });
  expect(result.current.advisor.open).toBe(true);
  expect(api.startConversation).not.toHaveBeenCalled();
  await act(async () => { result.current.advisor.hide(); });
  expect(result.current.advisor.open).toBe(false);
});

it('show(問題) 打開面板並直接送出', async () => {
  const { api, wrapper } = setup();
  const { result } = await renderHook(() => ({ advisor: useAdvisor(), chat: useChat() }), { wrapper });
  await act(async () => { result.current.advisor.show('討論室怎麼預約？'); });
  expect(result.current.advisor.open).toBe(true);
  expect(api.startConversation).toHaveBeenCalledWith('討論室怎麼預約？', expect.anything());
  expect(result.current.chat.state.messages.map((m) => m.text)).toEqual(['討論室怎麼預約？', '回覆：討論室怎麼預約？']);
});
