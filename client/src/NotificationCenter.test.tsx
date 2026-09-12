import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, beforeEach } from 'vitest';
import type { TaskNotification } from '@hyagent/shared';
import { api } from './api';
import { useNotifications } from './useNotifications';
import NotificationCenter from './NotificationCenter';
import i18n from './i18n';

vi.mock('./api', () => ({ api: { listNotifications: vi.fn(), markNotificationsRead: vi.fn() } }));
const item: TaskNotification = { id: 'n1', kind: 'confirming', title: '請假單', createdAt: '2026-09-13T00:00:00Z', read: false, target: { category: 'drafts', id: 'd1', conversationId: 'd1' } };
const onOpen = vi.fn().mockResolvedValue(undefined);
function Harness({ identity = 'kevin' }: { identity?: string }) { return <NotificationCenter notifications={useNotifications(identity)} onOpen={onOpen} />; }
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-Hant');
  vi.mocked(api.listNotifications).mockResolvedValue({ items: [item], unreadCount: 1 });
  vi.mocked(api.markNotificationsRead).mockResolvedValue({ ok: true });
});
it('filters unread notifications and persists all-read before clearing the badge', async () => {
  render(<Harness />);
  await screen.findByText('請假單');
  fireEvent.click(screen.getByRole('button', { name: '全部標為已讀' }));
  await waitFor(() => expect(api.markNotificationsRead).toHaveBeenCalledWith(['n1']));
  fireEvent.click(await screen.findByRole('button', { name: '未讀 (0)' }));
  expect(screen.getByText('所有通知都已讀取')).toBeInTheDocument();
});
it('opens the notification target after recording read state', async () => {
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '查看任務' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(item));
  expect(api.markNotificationsRead).toHaveBeenCalledWith(['n1']);
});
it('keeps unread state when persistence fails and exposes retry', async () => {
  vi.mocked(api.markNotificationsRead).mockRejectedValue(new Error('offline'));
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '標為已讀' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '未讀 (1)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新整理' })).toBeEnabled();
});
it('does not show an old account response after changing identities', async () => {
  let resolveOld!: (value: { items: TaskNotification[]; unreadCount: number }) => void;
  vi.mocked(api.listNotifications).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<Harness identity="old-user" />);
  vi.mocked(api.listNotifications).mockResolvedValue({ items: [], unreadCount: 0 });
  view.rerender(<Harness identity="new-user" />);
  await screen.findByText('目前沒有通知');
  resolveOld({ items: [item], unreadCount: 1 });
  await waitFor(() => expect(screen.queryByText('請假單')).not.toBeInTheDocument());
});
