// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DepartmentsSection from './DepartmentsSection';
import { api } from '../../api';
vi.mock('../../api', () => ({ api: { renameDepartment: vi.fn(), deleteDepartment: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });
const departments = [
  { name: '人資', members: 2, directGrants: 1, roles: 1 },
  { name: '舊部門', members: 0, directGrants: 1, roles: 0 },
];
function renderSection(onChanged = vi.fn().mockResolvedValue(undefined)) {
  render(<DepartmentsSection tenantId="t" departments={departments} onChanged={onChanged} onError={vi.fn()} />);
  return onChanged;
}
it('列出成員數與綁定權限，有成員的部門不能刪除', async () => {
  renderSection();
  expect(await screen.findByText('2 位成員 · 直接授權 1 項、角色 1 個')).toBeInTheDocument();
  expect(screen.getByText('已無成員')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刪除 人資' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '刪除 舊部門' })).toBeEnabled();
});
it('刪除前說明會清掉的權限', async () => {
  vi.mocked(api.deleteDepartment).mockResolvedValue({ name: '舊部門' });
  const onChanged = renderSection();
  fireEvent.click(await screen.findByRole('button', { name: '刪除 舊部門' }));
  expect(screen.getByText(/會一併清掉此部門的 直接授權 1 項/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  await screen.findByText('已刪除部門「舊部門」');
  expect(api.deleteDepartment).toHaveBeenCalledWith('t', '舊部門');
  expect(onChanged).toHaveBeenCalled();
});
it('改名通知外層重新載入；改成既有部門時先確認合併', async () => {
  vi.mocked(api.renameDepartment).mockResolvedValue({ name: 'x' });
  const onChanged = renderSection();
  fireEvent.click(await screen.findByRole('button', { name: '改名 人資' }));
  fireEvent.change(screen.getByLabelText('新部門名稱'), { target: { value: '舊部門' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  expect(screen.getByText(/成員與權限會併入/)).toBeInTheDocument();
  expect(api.renameDepartment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '合併' }));
  await screen.findByText('已將「人資」改名為「舊部門」');
  expect(api.renameDepartment).toHaveBeenCalledWith('t', '人資', '舊部門');
  expect(onChanged).toHaveBeenCalled();
});
it('有人員但沒有授權的部門顯示提醒，未指定部門與已無成員的不顯示', () => {
  render(<DepartmentsSection tenantId="t" onChanged={vi.fn()} onError={vi.fn()} departments={[
    { name: '財務', members: 3, directGrants: 0, roles: 0 },
    { name: '人資', members: 2, directGrants: 0, roles: 1 },
    { name: '舊部門', members: 0, directGrants: 0, roles: 0 },
    { name: '—', members: 4, directGrants: 0, roles: 0 },
  ]} />);
  expect(screen.getAllByText(/但沒有任何角色/)).toHaveLength(1);
  expect(screen.getByText(/財務 有 3 位人員，但沒有任何角色/)).toBeInTheDocument();
});
it('directorySyncEnabled 只在改名與刪除時提示會被 OA 蓋回', () => {
  render(<DepartmentsSection tenantId="t" onChanged={vi.fn()} onError={vi.fn()} directorySyncEnabled departments={departments} />);
  expect(screen.queryByText(/蓋回/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '改名 人資' }));
  expect(screen.getByText(/蓋回/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '刪除 舊部門' }));
  expect(screen.getByText(/蓋回/)).toBeInTheDocument();
});
