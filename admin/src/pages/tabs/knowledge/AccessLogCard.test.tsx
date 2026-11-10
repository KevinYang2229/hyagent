// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../../components/confirm';
import AccessLogCard from './AccessLogCard';

const listKnowledgeAccessLogs = vi.fn();
const updateKnowledgeAccessLogSettings = vi.fn();
vi.mock('../../../api', () => ({
  api: {
    listKnowledgeAccessLogs: (...a: unknown[]) => listKnowledgeAccessLogs(...a),
    updateKnowledgeAccessLogSettings: (...a: unknown[]) => updateKnowledgeAccessLogSettings(...a),
  },
}));
vi.mock('@hyagent/ui', async () => ({ ...(await vi.importActual<object>('@hyagent/ui')), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const files = [{ fileId: 'hr', name: '薪酬辦法.pdf', chunks: 1, ingestedAt: '2026-11-01T00:00:00Z' }];
const labels = [{ id: 'hr', label: '人資' }];
const page = (extra = {}) => ({
  items: [
    { id: '2', userId: 'HYW003', actorId: 'admin', path: 'admin_test', fileId: 'hr', fileName: '薪酬辦法.pdf', scopes: ['kb:hr'], at: '2026-11-10T02:00:00Z' },
    { id: '1', userId: 'HYW001', path: 'chat', fileId: 'gone', fileName: '舊考績表.xlsx', scopes: ['kb:hr'], at: '2026-11-10T01:00:00Z' },
    { id: '0', userId: '', path: 'chat', fileName: 'https://intra.example.com/a', scopes: ['kb:__website_access'], at: '2026-11-09T01:00:00Z' },
  ],
  retentionDays: 180, platformDefaultDays: 180, overridden: false, ...extra,
});

beforeEach(() => {
  listKnowledgeAccessLogs.mockReset().mockResolvedValue(page());
  updateKnowledgeAccessLogSettings.mockReset();
});
afterEach(cleanup);

const renderCard = () => render(<ConfirmProvider><AccessLogCard tenantId="t1" files={files} labels={labels} onError={vi.fn()} /></ConfirmProvider>);

it('列出紀錄：標示試查者、已刪除檔案、網站訪客與標籤名稱', async () => {
  renderCard();
  const list = await screen.findByRole('list', { name: '存取紀錄' });
  expect(await within(list).findByText('薪酬辦法.pdf')).toBeVisible();
  expect(within(list).getByText(/由 admin 以此身分試查/)).toBeVisible();
  expect(within(list).getByText('舊考績表.xlsx（已刪除）')).toBeVisible();
  expect(within(list).getByText('網站：https://intra.example.com/a')).toBeVisible();
  expect(within(list).getByText(/網站訪客.*網站：限定部門/)).toBeVisible();
  expect(screen.getByText(/保存 180 天（平台預設）/)).toBeVisible();
});

it('按「查詢」才套用篩選條件', async () => {
  renderCard();
  await screen.findByText('薪酬辦法.pdf', { selector: '.row-title' });
  fireEvent.change(screen.getByLabelText('文件'), { target: { value: 'hr' } });
  fireEvent.change(screen.getByLabelText('使用者'), { target: { value: ' HYW001 ' } });
  expect(listKnowledgeAccessLogs).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '查詢' }));
  await waitFor(() => expect(listKnowledgeAccessLogs).toHaveBeenLastCalledWith('t1', { fileId: 'hr', userId: 'HYW001' }));
});

it('縮短保存天數要先確認；取消就不送出', async () => {
  renderCard();
  fireEvent.click(await screen.findByRole('button', { name: '調整' }));
  fireEvent.change(screen.getByLabelText('保存天數'), { target: { value: '90' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  expect(await screen.findByText('縮短保存天數為 90 天？')).toBeVisible();
  // 編輯列也有「取消」：限定在確認彈窗內
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  expect(updateKnowledgeAccessLogSettings).not.toHaveBeenCalled();
});

it('延長保存天數不需確認，直接送出', async () => {
  updateKnowledgeAccessLogSettings.mockResolvedValue({ retentionDays: 365, platformDefaultDays: 180, overridden: true });
  renderCard();
  fireEvent.click(await screen.findByRole('button', { name: '調整' }));
  fireEvent.change(screen.getByLabelText('保存天數'), { target: { value: '365' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await waitFor(() => expect(updateKnowledgeAccessLogSettings).toHaveBeenCalledWith('t1', 365));
  expect(await screen.findByText(/保存 365 天（此租戶單獨設定）/)).toBeVisible();
});
