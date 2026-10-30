// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UsersTab from './UsersTab';
import { api } from '../../api';
vi.mock('../../api', () => ({ api: { listDirectoryUsers: vi.fn(), addDirectoryUser: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });
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
