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
