// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminAccountsTab from './AdminAccountsTab';
import { ConfirmProvider } from '../../components/confirm';
import { api } from '../../api';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => toast }));
vi.mock('../../api', () => ({
  api: {
    listAdminAccounts: vi.fn(), createAdminAccount: vi.fn(), updateAdminAccount: vi.fn(),
    resetAdminAccountPassword: vi.fn(), deleteAdminAccount: vi.fn(),
  },
}));

const acct = {
  id: 'a1', tenantId: 't', username: 'alice01', displayName: '小愛', status: 'active' as const,
  permissions: { forms: 'write' as const }, createdAt: '', updatedAt: '',
};
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listAdminAccounts).mockResolvedValue([acct]);
  vi.mocked(api.updateAdminAccount).mockResolvedValue(acct);
  vi.mocked(api.deleteAdminAccount).mockResolvedValue({ id: 'a1' });
  vi.mocked(api.resetAdminAccountPassword).mockResolvedValue({ id: 'a1' });
});
const renderTab = (onError = vi.fn()) => render(<ConfirmProvider><AdminAccountsTab tenantId="t" onError={onError} /></ConfirmProvider>);

it('列表顯示帳號，沒有任何密碼欄位', async () => {
  const { container } = renderTab();
  expect(await screen.findByText('alice01')).toBeInTheDocument();
  expect(screen.getByText('小愛')).toBeInTheDocument();
  expect(container.querySelector('ul.list input')).toBeNull();
  expect(container.querySelector('ul.list')!.textContent).not.toMatch(/password|hash/i);
  expect(container.textContent).not.toMatch(/passwordHash/);
});

it('把「知識庫」改成唯讀並儲存，送出完整 permissions', async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: '編輯權限' }));
  const row = screen.getByRole('group', { name: '知識庫' });
  fireEvent.click(within(row).getByRole('radio', { name: '唯讀' }));
  fireEvent.click(screen.getByRole('button', { name: '儲存權限' }));
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenCalledTimes(1));
  const [tid, aid, patch] = vi.mocked(api.updateAdminAccount).mock.calls[0]!;
  expect([tid, aid]).toEqual(['t', 'a1']);
  expect(patch.permissions).toMatchObject({ forms: 'write', knowledge: 'read' });
  expect(Object.keys(patch.permissions!)).toHaveLength(14);
});

it('「全部隱藏」「全部唯讀」快捷鍵', async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: '編輯權限' }));
  fireEvent.click(screen.getByRole('button', { name: '全部唯讀' }));
  fireEvent.click(screen.getByRole('button', { name: '儲存權限' }));
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenCalled());
  const perms = vi.mocked(api.updateAdminAccount).mock.calls[0]![2].permissions!;
  expect(Object.values(perms).every((v) => v === 'read')).toBe(true);
});

it('新增帳號密碼不到 10 字元：不送出並顯示錯誤', async () => {
  renderTab();
  await screen.findByText('alice01');
  fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'bob01' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Bob' } });
  fireEvent.change(screen.getByLabelText('初始密碼'), { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: '新增帳號' }));
  expect(await screen.findByText(/密碼長度需為 10 到 128/)).toBeInTheDocument();
  expect(api.createAdminAccount).not.toHaveBeenCalled();
});

it('新增帳號格式正確時送出', async () => {
  vi.mocked(api.createAdminAccount).mockResolvedValue(acct);
  renderTab();
  await screen.findByText('alice01');
  fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'bob01' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Bob' } });
  fireEvent.change(screen.getByLabelText('初始密碼'), { target: { value: 'longenough123' } });
  fireEvent.click(screen.getByRole('button', { name: '新增帳號' }));
  await waitFor(() => expect(api.createAdminAccount).toHaveBeenCalledWith('t', { username: 'bob01', displayName: 'Bob', password: 'longenough123' }));
});

it('帳號格式不符時不送出', async () => {
  renderTab();
  await screen.findByText('alice01');
  fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'Bad Name' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Bob' } });
  fireEvent.change(screen.getByLabelText('初始密碼'), { target: { value: 'longenough123' } });
  fireEvent.click(screen.getByRole('button', { name: '新增帳號' }));
  expect(await screen.findByText(/帳號格式/)).toBeInTheDocument();
  expect(api.createAdminAccount).not.toHaveBeenCalled();
});

it('刪除要先確認才會呼叫 API', async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('alice01');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.deleteAdminAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  const ok = screen.getAllByRole('button', { name: '刪除' }).find((b) => b.closest('.hy-dialog-footer'))!;
  fireEvent.click(ok);
  await waitFor(() => expect(api.deleteAdminAccount).toHaveBeenCalledWith('t', 'a1'));
});

it('停用帳號呼叫 updateAdminAccount status', async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: '停用' }));
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenCalledWith('t', 'a1', { status: 'disabled' }));
});

it('重設密碼：太短不送；成功提示已登入裝置會被登出', async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: '重設密碼' }));
  const dlg = screen.getByRole('dialog');
  fireEvent.change(within(dlg).getByLabelText('新密碼'), { target: { value: 'short' } });
  fireEvent.click(within(dlg).getByRole('button', { name: '儲存' }));
  expect(await within(dlg).findByText(/密碼長度需為 10 到 128/)).toBeInTheDocument();
  expect(api.resetAdminAccountPassword).not.toHaveBeenCalled();
  fireEvent.change(within(dlg).getByLabelText('新密碼'), { target: { value: 'longenough123' } });
  fireEvent.click(within(dlg).getByRole('button', { name: '儲存' }));
  await waitFor(() => expect(api.resetAdminAccountPassword).toHaveBeenCalledWith('t', 'a1', 'longenough123'));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('該帳號已登入的裝置會被登出')));
});
