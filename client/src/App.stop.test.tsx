import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import i18n from './i18n';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    auth: { ...actual.auth, isAuthenticated: () => true, me: async () => ({ id: 'tester', name: '測試者', department: '' }) },
    api: { ...actual.api, health: async () => true, listForms: async () => [], getLeaveBalances: async () => [],
      knowledgeFeed: async () => ({ knowledgeEnabled: false, suggestedPrompts: [] }),
      mySkills: async () => ({ roles: [], skills: [] }),
      listNotifications: async () => ({ items: [], unreadCount: 0 }),
      start: vi.fn(), sendMessage: vi.fn(), stopQuery: vi.fn(async () => undefined) },
  };
});
vi.mock('./embedConfig', () => ({ embedConfig: {}, fetchAppearance: async () => ({ appearance: {}, knowledgeEnabled: false, suggestedPrompts: [] }) }));

beforeEach(async () => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  await i18n.changeLanguage('zh-Hant');
});

it('停止中斷請求，立即可再提問，舊回應與 finally 不覆蓋新查詢', async () => {
  let firstResolve!: (value: Awaited<ReturnType<typeof api.start>>) => void;
  let secondResolve!: typeof firstResolve;
  vi.mocked(api.start)
    .mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { secondResolve = resolve; }));
  render(<App />);
  const send = await screen.findByRole('button', { name: '送出' });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '第一個問題' } });
  fireEvent.click(send);
  const stop = await screen.findByRole('button', { name: '停止' });
  const firstArgs = vi.mocked(api.start).mock.calls[0];
  fireEvent.click(stop);
  expect(firstArgs[3]?.aborted).toBe(true);
  expect(api.stopQuery).toHaveBeenCalledWith('tester', firstArgs[4]);
  expect(screen.getByText('已停止查詢，你可以繼續提問。')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '第二個問題' } });
  fireEvent.click(screen.getByRole('button', { name: '送出' }));
  await act(async () => firstResolve({ id: 'old', status: 'collecting', values: {}, reply: '不應出現的舊回應' }));
  expect(screen.queryByText('不應出現的舊回應')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  await act(async () => secondResolve({ id: 'new', status: 'collecting', values: {}, reply: '第二個問題的答案' }));
  expect(await screen.findByText('第二個問題的答案')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '送出' })).toBeEnabled());
});

it('停止造成的 AbortError 不顯示網路錯誤；卸載也會取消查詢', async () => {
  vi.mocked(api.start).mockImplementation((_user, _message, _form, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const { unmount } = render(<App />);
  await screen.findByRole('button', { name: '送出' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '停止測試' } });
  fireEvent.click(screen.getByRole('button', { name: '送出' }));
  fireEvent.click(await screen.findByRole('button', { name: '停止' }));
  await act(async () => {});
  expect(screen.queryByText(/⚠️.*aborted/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '卸載測試' } });
  fireEvent.click(screen.getByRole('button', { name: '送出' }));
  const signal = vi.mocked(api.start).mock.calls[1][3];
  unmount();
  expect(signal?.aborted).toBe(true);
});
