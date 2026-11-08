// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PermissionsTab from './PermissionsTab';
import { api, ConflictError, type TenantPolicyView } from '../../api';
vi.mock('../../api', () => ({ api: { getTenantPolicy: vi.fn(), putTenantPolicy: vi.fn() }, ConflictError: class ConflictError extends Error {} }));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn() }) }));

let fixture: TenantPolicyView;
beforeEach(() => {
  vi.clearAllMocks();
  fixture = {
    version: 'v1', memberBundles: [], grantedScopes: [], groups: {}, accounts: {}, convertedRoleIds: [],
    capabilities: [
      { id: 'service:form', label: '填表申請', description: '', base: false },
      { id: 'service:knowledge', label: '知識庫問答', description: '', base: false },
      { id: 'form:leave', label: '請假單', description: '', base: false },
      { id: 'kb:hr', label: '人資文件', description: '', base: false },
    ],
    departments: ['—', '行銷部'],
    users: [{ id: 'kevin', label: 'Kevin', department: '行銷部' }],
    bundles: [{ id: 'emp', name: '一般員工', scopes: ['service:form', 'form:leave'] }],
    groupBundles: { 行銷部: ['emp'] }, accountBundles: {}, tenantBundles: [],
  };
  vi.mocked(api.putTenantPolicy).mockImplementation(async (_id, body) => ({ ...fixture, ...body, convertedRoleIds: [] }));
});
afterEach(cleanup);

async function renderTab(onDirtyChange = vi.fn()) {
  vi.mocked(api.getTenantPolicy).mockResolvedValue(fixture);
  render(<PermissionsTab tenantId="t" onError={vi.fn()} onDirtyChange={onDirtyChange} />);
  await screen.findByRole('button', { name: '編輯 一般員工' });
  return onDirtyChange;
}
const saveButton = () => within(screen.getByRole('region', { name: '儲存權限' })).getByRole('button', { name: '儲存' });
const editor = () => screen.getByRole('form');
const check = (scope: HTMLElement, name: string) => fireEvent.click(within(scope).getByText(name).closest('label')!.querySelector('input')!);

it('角色列出能做什麼與給誰', async () => {
  await renderTab();
  expect(screen.getByText('能做：填表申請、請假單')).toBeInTheDocument();
  expect(screen.getByText('給誰：行銷部')).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

it('新增角色：勾表單自動開啟填表申請，套用部門後存檔送出角色格式', async () => {
  const onDirty = await renderTab();
  fireEvent.click(screen.getByRole('button', { name: '＋ 新增角色' }));
  fireEvent.change(within(editor()).getByPlaceholderText('例：一般員工、報告分析員'), { target: { value: '人資專員' } });
  expect(within(editor()).getByText('還沒有套用給任何人，這個角色目前不會生效。')).toBeInTheDocument();
  check(editor(), '請假單');
  expect(within(editor()).getByRole('status')).toHaveTextContent('已一併開啟「填表申請」');
  check(within(editor()).getByRole('group', { name: '部門' }), '行銷部');
  fireEvent.click(within(editor()).getByRole('button', { name: '完成' }));
  expect(screen.getByText('人資專員')).toBeInTheDocument();
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.putTenantPolicy).toHaveBeenCalled());
  const body = vi.mocked(api.putTenantPolicy).mock.calls[0][1];
  expect(body).toMatchObject({ grantedScopes: [], groups: {}, accounts: {} });
  const role = body.bundles.find((b) => b.name === '人資專員')!;
  expect(role.scopes.sort()).toEqual(['form:leave', 'service:form']);
  expect(body.groupBundles['行銷部']).toEqual(['emp', role.id]);
});

it('開給所有人的角色不能勾知識庫標籤，也不會因此被取消「所有人」', async () => {
  await renderTab();
  fireEvent.click(screen.getByRole('button', { name: '編輯 一般員工' }));
  check(editor(), '所有人（含網站訪客）');
  const kb = within(editor()).getByText('人資文件').closest('label')!.querySelector('input')!;
  expect(kb).toBeDisabled();
  expect(within(editor()).getByText(/不能加入知識庫標籤/)).toBeInTheDocument();
  const everyone = within(editor()).getByText('所有人（含網站訪客）').closest('label')!.querySelector('input')!;
  expect(everyone).toBeChecked();
});

it('舊設定換算成的角色會標示，未變更也可以儲存套用', async () => {
  fixture.bundles.push({ id: 'legacy-1', name: '全體人員', scopes: ['service:knowledge'] });
  fixture.tenantBundles = ['legacy-1'];
  fixture.convertedRoleIds = ['legacy-1'];
  await renderTab();
  expect(screen.getByText(/舊的權限設定已整理成 1 個角色/)).toBeInTheDocument();
  expect(screen.getByText('由舊設定轉換')).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.putTenantPolicy).toHaveBeenCalledWith('t', expect.objectContaining({ tenantBundles: ['legacy-1'] })));
});

it('個人權限：顯示角色來源與缺漏，並可直接替他加角色', async () => {
  fixture.bundles.push({ id: 'kb', name: '知識庫使用者', scopes: ['service:knowledge'] });
  await renderTab();
  expect(screen.getByText('沒有發現權限缺漏。')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'user:kevin' } });
  const detail = screen.getByRole('region', { name: '角色' });
  const inherited = within(detail).getByText('一般員工').closest('label')!.querySelector('input')!;
  expect(inherited).toBeChecked();
  expect(inherited).toBeDisabled();
  expect(within(detail).getByText('來自部門「行銷部」')).toBeInTheDocument();
  check(detail, '知識庫使用者');
  expect(screen.getByRole('region', { name: '最後擁有的能力' })).toHaveTextContent('沒有任何知識庫標籤');
  // 只開網站內容是軟提醒，不列入「權限可能不完整」彙總
  expect(screen.getByText('沒有發現權限缺漏。')).toBeInTheDocument();
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.putTenantPolicy).toHaveBeenCalledWith('t', expect.objectContaining({ accountBundles: { kevin: ['kb'] } })));
});

it('個人權限：來自部門的角色不能取消，要看得出來並說明到哪裡調整', async () => {
  fixture.bundles.push({ id: 'kb', name: '知識庫使用者', scopes: ['service:knowledge'] });
  await renderTab();
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'user:kevin' } });
  const detail = screen.getByRole('region', { name: '角色' });
  const lockedRow = within(detail).getByText('一般員工').closest('label')!;
  expect(lockedRow).toHaveClass('is-locked');
  expect(within(lockedRow).getByText(/不能在這裡取消，請到此角色的「給誰」調整/)).toBeInTheDocument();
  const openRow = within(detail).getByText('知識庫使用者').closest('label')!;
  expect(openRow).not.toHaveClass('is-locked');
  expect(openRow.querySelector('input')).toBeEnabled();
});

it('個人權限：直接指派又來自部門時，取消後仍勾選並說明原因', async () => {
  fixture.accountBundles = { kevin: ['emp'] };
  await renderTab();
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'user:kevin' } });
  const detail = screen.getByRole('region', { name: '角色' });
  expect(within(detail).getByText(/取消直接指派後，仍會從其他來源取得/)).toBeInTheDocument();
  check(detail, '一般員工');
  const row = within(detail).getByText('一般員工').closest('label')!;
  expect(row.querySelector('input')).toBeChecked();
  expect(row).toHaveClass('is-locked');
  expect(within(row).queryByText(/直接指派/)).not.toBeInTheDocument();
});

it('個人權限：網站訪客不能直接指派，並說明要怎麼開放', async () => {
  await renderTab();
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'guest:' } });
  const detail = screen.getByRole('region', { name: '角色' });
  expect(within(detail).getByText(/網站訪客沒有帳號，不能直接指派角色/)).toBeInTheDocument();
  expect(within(detail).getByText('一般員工').closest('label')).toHaveClass('is-locked');
});

it('刪除角色前確認，並可放棄變更', async () => {
  const onDirty = await renderTab();
  fireEvent.click(screen.getByRole('button', { name: '刪除 一般員工' }));
  expect(screen.getByText(/「行銷部」將失去這個角色的能力/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  expect(screen.queryByText('能做：填表申請、請假單')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '放棄變更' }));
  expect(screen.getByText('能做：填表申請、請假單')).toBeInTheDocument();
  expect(onDirty).toHaveBeenLastCalledWith(false);
});

it('儲存時帶上讀取版本；版本衝突時不儲存並提示重新載入', async () => {
  await renderTab();
  fireEvent.click(screen.getByRole('button', { name: '刪除 一般員工' }));
  fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
  vi.mocked(api.putTenantPolicy).mockRejectedValueOnce(new ConflictError('conflict'));
  fireEvent.click(saveButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('已被變更');
  expect(vi.mocked(api.putTenantPolicy).mock.calls[0][1].baseVersion).toBe('v1');
  fireEvent.click(screen.getByRole('button', { name: '重新載入（放棄我的修改）' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(api.getTenantPolicy).toHaveBeenCalledTimes(2);
});

it('個人權限可用搜尋縮小人員下拉', async () => {
  fixture.users.push({ id: 'amy', label: 'Amy', department: '人資部' });
  await renderTab();
  fireEvent.change(screen.getByLabelText('搜尋人員'), { target: { value: '人資' } });
  const options = [...(screen.getByLabelText('選擇人員') as HTMLSelectElement).options].map((o) => o.text);
  expect(options).toEqual(['請選擇…', 'Amy（人資部）']);
});

it('角色編輯器開著尚未按「完成」也算未儲存，離開分頁會被提醒', async () => {
  const onDirtyChange = await renderTab();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: '編輯 一般員工' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(within(editor()).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it('通用服務：一鍵開給所有登入員工（不含訪客），儲存送出 memberBundles', async () => {
  fixture.bundles.push({ id: 'general-services', name: '通用服務', scopes: ['service:knowledge'] });
  await renderTab();
  const toggle = screen.getByLabelText('開放通用服務給所有登入員工');
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(screen.getByText('已開放給所有登入員工')).toBeInTheDocument();
  // 登入員工取得，網站訪客不會
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'user:kevin' } });
  expect(within(screen.getByRole('region', { name: '角色' })).getByText('套用給所有登入員工')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('選擇人員'), { target: { value: 'guest:' } });
  expect(within(screen.getByRole('region', { name: '最後擁有的能力' })).queryByText('知識庫問答')).toBeNull();
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.putTenantPolicy).toHaveBeenCalledWith('t', expect.objectContaining({ memberBundles: ['general-services'] })));
});

it('舊租戶沒有通用服務群組時可建立，建立後預設關閉', async () => {
  await renderTab();
  fireEvent.click(screen.getByRole('button', { name: '建立通用服務群組' }));
  expect(screen.getByLabelText('開放通用服務給所有登入員工')).not.toBeChecked();
  expect(screen.getByText(/包含：/)).toHaveTextContent('填表申請');
});
