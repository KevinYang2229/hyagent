// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UsersTab from './UsersTab';
import { api } from '../../api';
vi.mock('../../api', () => ({ api: { listDirectoryUsers: vi.fn(), addDirectoryUser: vi.fn(), updateDirectoryUser: vi.fn(), deleteDirectoryUser: vi.fn(),
  listDepartments: vi.fn(), renameDepartment: vi.fn(), deleteDepartment: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.listDepartments).mockResolvedValue({ departments: [] }); });
it('adds the entered account to the selected tenant and displays the saved directory', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [] });
  vi.mocked(api.addDirectoryUser).mockResolvedValue({ users: [{ id: 'hyweb', name: 'Hyweb', department: '—' }] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('登入帳號'), { target: { value: 'hyweb' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Hyweb' } });
  fireEvent.click(screen.getByRole('button', { name: '新增使用者' }));
  await screen.findByText('已新增帳號 hyweb');
  expect(api.addDirectoryUser).toHaveBeenCalledWith('tenant-a', { id: 'hyweb', name: 'Hyweb', department: '—' });
  expect(screen.getByText(/帳號：hyweb/)).toBeInTheDocument();
});
it('retains entered values when adding fails', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [] });
  vi.mocked(api.addDirectoryUser).mockRejectedValue(new Error('此帳號已存在'));
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('登入帳號'), { target: { value: 'hyweb' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Hyweb' } });
  fireEvent.click(screen.getByRole('button', { name: '新增使用者' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: '新增使用者' })).toBeEnabled());
  expect(screen.getByLabelText('登入帳號')).toHaveValue('hyweb');
});
it('部門從既有部門選擇，也可新增部門', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [{ id: 'amy', name: 'Amy', department: '人資' }] });
  vi.mocked(api.addDirectoryUser).mockResolvedValue({ users: [] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  const select = await screen.findByLabelText('部門（選填）');
  expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(['未指定', '人資', '＋ 新增部門…']);
  fireEvent.change(screen.getByLabelText('登入帳號'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Bob' } });
  fireEvent.change(select, { target: { value: '__new__' } });
  expect(screen.getByRole('button', { name: '新增使用者' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('新部門名稱'), { target: { value: ' 人資 ' } });
  expect(screen.getByText('已有此部門，將直接加入。')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('新部門名稱'), { target: { value: ' 業務 ' } });
  fireEvent.click(screen.getByRole('button', { name: '新增使用者' }));
  await waitFor(() => expect(api.addDirectoryUser).toHaveBeenCalledWith('tenant-a', { id: 'bob', name: 'Bob', department: '業務' }));
});
it('編輯使用者：帳號不可改，可清除 Email 並改部門', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [
    { id: 'amy', name: 'Amy', department: '人資', email: 'amy@example.com' },
    { id: 'bob', name: 'Bob', department: '業務' },
  ] });
  vi.mocked(api.updateDirectoryUser).mockResolvedValue({ users: [
    { id: 'amy', name: 'Amy Lin', department: '業務' },
    { id: 'bob', name: 'Bob', department: '業務' },
  ] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '編輯 Amy' }));
  const form = screen.getByRole('form', { name: '編輯 Amy' });
  expect(form).toHaveTextContent('帳號建立後不可修改');
  const inputs = form.querySelectorAll('input');
  fireEvent.change(inputs[0], { target: { value: 'Amy Lin' } });
  fireEvent.change(form.querySelector('select')!, { target: { value: '業務' } });
  fireEvent.change(form.querySelector('input[type="email"]')!, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await screen.findByText('已更新帳號 amy');
  expect(api.updateDirectoryUser).toHaveBeenCalledWith('tenant-a', 'amy', { name: 'Amy Lin', department: '業務', email: null });
  expect(screen.queryByRole('form', { name: '編輯 Amy' })).toBeNull();
  expect(screen.getByText('Amy Lin')).toBeInTheDocument();
});
it('刪除使用者前需確認，取消不會刪除', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [{ id: 'amy', name: 'Amy', department: '人資' }] });
  vi.mocked(api.deleteDirectoryUser).mockResolvedValue({ users: [] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Amy' }));
  expect(screen.getByText(/無法再用帳密登入/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /取消|cancel/i }));
  expect(api.deleteDirectoryUser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '刪除 Amy' }));
  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  await screen.findByText('已刪除帳號 amy');
  expect(api.deleteDirectoryUser).toHaveBeenCalledWith('tenant-a', 'amy');
  expect(screen.getByText('尚無使用者，請先新增登入帳號。')).toBeInTheDocument();
});
it('部門下拉包含已無成員但仍存在的部門', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [{ id: 'kevin', name: 'Kevin', department: '—' }] });
  vi.mocked(api.listDepartments).mockResolvedValue({ departments: [{ name: '行銷部', members: 0, directGrants: 0, roles: 1 }] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await screen.findByText('已無成員');
  const select = screen.getByLabelText('部門（選填）') as HTMLSelectElement;
  expect([...select.options].map((o) => o.text)).toEqual(['未指定', '行銷部', '＋ 新增部門…']);
  fireEvent.click(screen.getByRole('button', { name: '編輯 Kevin' }));
  const form = screen.getByRole('form', { name: '編輯 Kevin' });
  expect([...form.querySelector('select')!.options].map((o) => o.text)).toContain('行銷部');
});
