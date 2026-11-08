// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsersTab from './UsersTab';
import { api } from '../../api';
vi.mock('../../api', () => ({ api: { listDirectoryUsers: vi.fn(), addDirectoryUser: vi.fn(), updateDirectoryUser: vi.fn(), deleteDirectoryUser: vi.fn(),
  listDepartments: vi.fn(), renameDepartment: vi.fn(), deleteDepartment: vi.fn(), getDirectorySync: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.listDepartments).mockResolvedValue({ departments: [] });
  vi.mocked(api.getDirectorySync).mockResolvedValue({ directorySyncEnabled: false } as never); });
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
  expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(['未指定部門', '人資', '＋ 新增部門…']);
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
  expect([...select.options].map((o) => o.text)).toEqual(['未指定部門', '行銷部', '＋ 新增部門…']);
  fireEvent.click(screen.getByRole('button', { name: '編輯 Kevin' }));
  const form = screen.getByRole('form', { name: '編輯 Kevin' });
  expect([...form.querySelector('select')!.options].map((o) => o.text)).toContain('行銷部');
});

const mixedUsers = [
  { id: 'm', name: 'Manual', department: '人資' },
  { id: 's', name: 'Sso', department: '人資', origin: 'sso' as const },
  { id: 'y', name: 'Synced', department: '人資', origin: 'sync' as const, syncedAt: '2026-11-01T00:00:00Z' },
];
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
it('顯示來源標記：手動、自動登入、OA 同步', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await screen.findByText('Manual');
  expect(rowOf('Manual')).toHaveTextContent('手動');
  expect(rowOf('Sso')).toHaveTextContent('自動登入');
  expect(rowOf('Synced')).toHaveTextContent('OA 同步');
});
const switches = (ssoAutoProvision: boolean, directorySyncEnabled: boolean) =>
  vi.mocked(api.getDirectorySync).mockResolvedValue({ ssoAutoProvision, directorySyncEnabled } as never);
/** 等開關讀取完成，免得「沒有按鈕」其實只是還在載入 */
const settled = async () => { await screen.findByText('Manual'); await act(async () => { await Promise.resolve(); }); };
const editButton = (name: string) => screen.queryByRole('button', { name: `編輯 ${name}` });
const taken = { id: 'w', name: 'Taken', department: '人資', origin: 'manual' as const, syncedAt: '2026-11-01T00:00:00Z' };
const ssoTaken = { id: 't', name: 'SsoTaken', department: '人資', origin: 'sso' as const, syncedAt: '2026-11-01T00:00:00Z' };
it.each([
  { sso: true, sync: true, editable: ['Manual'], locked: ['Sso', 'Synced', 'Taken', 'SsoTaken'] },
  { sso: true, sync: false, editable: ['Manual', 'Synced', 'Taken', 'SsoTaken'], locked: ['Sso'] },
  { sso: false, sync: true, editable: ['Manual', 'Sso'], locked: ['Synced', 'Taken', 'SsoTaken'] },
  { sso: false, sync: false, editable: ['Manual', 'Sso', 'Synced', 'Taken', 'SsoTaken'], locked: [] },
])('編輯按鈕跟著開關：自動建立 $sso、同步 $sync', async ({ sso, sync, editable, locked }) => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [...mixedUsers, taken, ssoTaken] });
  switches(sso, sync);
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await settled();
  for (const name of editable) expect(editButton(name)).toBeInTheDocument();
  for (const name of locked) expect(editButton(name)).toBeNull();
});
it('開關讀取失敗：OA 管理的帳號維持鎖定，手動帳號可編輯', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  vi.mocked(api.getDirectorySync).mockRejectedValue(new Error('boom'));
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await settled();
  expect(editButton('Manual')).toBeInTheDocument();
  expect(editButton('Sso')).toBeNull();
  expect(editButton('Synced')).toBeNull();
});
it('開關還沒讀到：OA 管理的帳號先鎖定，讀到才開放', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  let resolve!: (v: never) => void;
  vi.mocked(api.getDirectorySync).mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await settled();
  expect(editButton('Sso')).toBeNull();
  resolve({ ssoAutoProvision: false, directorySyncEnabled: false } as never);
  expect(await screen.findByRole('button', { name: '編輯 Sso' })).toBeInTheDocument();
});
it('開關關閉後來源標記不變', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  switches(false, false);
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await settled();
  expect(rowOf('Sso')).toHaveTextContent('自動登入');
  expect(rowOf('Synced')).toHaveTextContent('OA 同步');
});
it('webhook 接手的 manual 帳號標示 OA 同步，同步開啟時沒有編輯按鈕', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [taken] });
  switches(false, true);
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await screen.findByText('Taken');
  await act(async () => { await Promise.resolve(); });
  expect(rowOf('Taken')).toHaveTextContent('OA 同步');
  expect(editButton('Taken')).toBeNull();
});
describe('刪除確認文案與實際行為一致', () => {
  const openDelete = async (name: string) => {
    render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `刪除 ${name}` }));
  };
  const SESSION_HINT = /自動登入的工作階段不會因此結束.*「自動登入」分頁的「登入工作階段」/;
  it('手動帳號：帳密工作階段失效；同時走 SSO 的人不受影響；不提 Session 作廢', async () => {
    vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
    await openDelete('Manual');
    expect(screen.getByText(/無法再用帳密登入，帳密登入的工作階段會立即失效/)).toBeInTheDocument();
    expect(screen.getByText(/也透過自動登入.*不受影響/)).toBeInTheDocument();
    expect(screen.queryByText(SESSION_HINT)).toBeNull();
    expect(screen.queryByText(/已登入的工作階段會立即失效/)).toBeNull();
  });
  it.each(['Sso', 'Synced'])('%s：自動登入工作階段不會結束，指向登入 Session；不提帳密', async (name) => {
    vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
    await openDelete(name);
    expect(screen.getByText(SESSION_HINT)).toBeInTheDocument();
    expect(screen.queryByText(/已登入的工作階段會立即失效/)).toBeNull();
    expect(screen.queryByText(/無法再用帳密登入/)).toBeNull();
  });
  it('webhook 接手的 manual 帳號兩種都有：帳密會失效、自動登入不會結束', async () => {
    vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [taken] });
    await openDelete('Taken');
    expect(screen.getByText(/無法再用帳密登入，帳密登入的工作階段會立即失效/)).toBeInTheDocument();
    expect(screen.getByText(SESSION_HINT)).toBeInTheDocument();
  });
  it('開關全關時，OA 管理帳號的提示仍在', async () => {
    vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
    switches(false, false);
    await openDelete('Sso');
    expect(screen.getByText(/會重新建立，停權請在 OA 處理/)).toBeInTheDocument();
    expect(screen.getByText(SESSION_HINT)).toBeInTheDocument();
  });
});
it('刪除 OA 管理帳號時提示會重新建立，停權請在 OA 處理', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Synced' }));
  expect(screen.getByText(/會重新建立，停權請在 OA 處理/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /取消|cancel/i }));
  fireEvent.click(screen.getByRole('button', { name: '刪除 Manual' }));
  expect(screen.queryByText(/會重新建立，停權請在 OA 處理/)).toBeNull();
  expect(screen.getByText(/無法再用帳密登入/)).toBeInTheDocument();
});
it('手動帳號的編輯與刪除行為不變', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  vi.mocked(api.updateDirectoryUser).mockResolvedValue({ users: mixedUsers });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '編輯 Manual' }));
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await screen.findByText('已更新帳號 m');
  expect(api.updateDirectoryUser).toHaveBeenCalledWith('tenant-a', 'm', { name: 'Manual', department: '人資', email: null });
  expect(screen.getByRole('button', { name: '刪除 Manual' })).toBeEnabled();
});
it('有人員但沒有角色的部門顯示提醒；都有角色時不顯示', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [] });
  vi.mocked(api.listDepartments).mockResolvedValue({ departments: [
    { name: '財務', members: 3, directGrants: 0, roles: 0 },
    { name: '人資', members: 2, directGrants: 1, roles: 0 },
    { name: '行銷', members: 2, directGrants: 0, roles: 1 },
    { name: '舊部門', members: 0, directGrants: 0, roles: 0 },
    { name: '—', members: 5, directGrants: 0, roles: 0 },
  ] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  expect(await screen.findByText('財務 有 3 位人員，但沒有任何角色；若部門在 OA 改過名，請更新角色的適用部門。')).toBeInTheDocument();
  expect(screen.getAllByText(/但沒有任何角色/)).toHaveLength(1);
});
it('getDirectorySync 失敗時目錄照常顯示', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: mixedUsers });
  vi.mocked(api.getDirectorySync).mockRejectedValue(new Error('boom'));
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  expect(await screen.findByText('Manual')).toBeInTheDocument();
});
it('directorySyncEnabled 開啟時，改名或刪除部門提示會被 OA 蓋回', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [] });
  vi.mocked(api.getDirectorySync).mockResolvedValue({ directorySyncEnabled: true } as never);
  vi.mocked(api.listDepartments).mockResolvedValue({ departments: [{ name: '舊部門', members: 0, directGrants: 0, roles: 1 }] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '改名 舊部門' }));
  expect(await screen.findByText(/OA 同步已開啟.*蓋回/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '刪除 舊部門' }));
  expect(screen.getByText(/OA 同步已開啟.*蓋回/)).toBeInTheDocument();
});
it('ssoAutoProvision 開啟時，部門提示也涵蓋登入', async () => {
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [] });
  vi.mocked(api.getDirectorySync).mockResolvedValue({ ssoAutoProvision: true, directorySyncEnabled: false } as never);
  vi.mocked(api.listDepartments).mockResolvedValue({ departments: [{ name: '舊部門', members: 0, directGrants: 0, roles: 1 }] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(await screen.findByRole('button', { name: '改名 舊部門' }));
  expect(await screen.findByText(/員工下次登入時被蓋回/)).toBeInTheDocument();
});
it('列出未指定部門（與訪客同權限）的帳號，超過 5 位時其餘收合', async () => {
  const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, name: `User${i}`, department: '—' }));
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users: [...users, { id: 'amy', name: 'Amy', department: '人資' }] });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  const warn = await screen.findByText(/7 位未指定部門/);
  expect(warn).toHaveTextContent('User0（u0）');
  expect(warn).not.toHaveTextContent('Amy');
  expect(screen.getByText('另有 2 項')).toBeInTheDocument();
});
it('使用者清單可搜尋、依部門篩選，並每頁 20 位分頁', async () => {
  const users = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, name: `User${i}`, department: i < 3 ? '人資' : '行銷部' }));
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users });
  render(<UsersTab tenantId="tenant-a" onError={vi.fn()} />);
  expect(await screen.findByText(/共 25 位 · 第 1 \/ 2 頁/)).toBeInTheDocument();
  expect(screen.queryByText('帳號：u24 · 部門：行銷部')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一頁' }));
  expect(screen.getByText(/帳號：u24/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('依部門篩選'), { target: { value: '人資' } });
  expect(screen.getAllByText(/部門：人資/)).toHaveLength(3);
  expect(screen.queryByRole('navigation', { name: '使用者清單分頁' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('搜尋使用者'), { target: { value: 'User1' } });
  expect(screen.getAllByText(/部門：人資/)).toHaveLength(1);
});
