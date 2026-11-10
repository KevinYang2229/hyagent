// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebhookTab from './WebhookTab';
import { ConfirmProvider } from '../../components/confirm';
import { api } from '../../api';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../api', () => ({ api: { listWebhooks: vi.fn(), deleteWebhook: vi.fn(), toggleWebhook: vi.fn(), createWebhook: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listWebhooks).mockResolvedValue([{ id: 'w1', tenantId: 't', url: 'https://hook.example.com', secret: 's', createdAt: '' }]);
  vi.mocked(api.deleteWebhook).mockResolvedValue(undefined as never);
});

it('刪除事件通知端點前先跳出確認彈窗：取消不刪、確認才刪', async () => {
  render(<ConfirmProvider><WebhookTab tenantId="t" onError={vi.fn()} /></ConfirmProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('https://hook.example.com');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.deleteWebhook).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  const dialogDelete = screen.getAllByRole('button', { name: '刪除' }).find((b) => b.closest('.hy-dialog-footer'))!;
  fireEvent.click(dialogDelete);
  await waitFor(() => expect(api.deleteWebhook).toHaveBeenCalledWith('t', 'w1'));
});

it('新增端點後顯示一次完整 secret 並可複製（列表只回遮罩值）', async () => {
  const full = 'whsec_0123456789abcdef0123456789abcdef0123456789abcdef';
  vi.mocked(api.createWebhook).mockResolvedValue({ id: 'w2', tenantId: 't', url: 'https://new.example.com', secret: full, createdAt: '' });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<ConfirmProvider><WebhookTab tenantId="t" onError={vi.fn()} /></ConfirmProvider>);
  fireEvent.change(screen.getByPlaceholderText('https://接收端/hook'), { target: { value: 'https://new.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '新增' }));
  expect(await screen.findByText(full)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '複製' }));
  expect(writeText).toHaveBeenCalledWith(full);
});
