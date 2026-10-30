// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PermissionsTab from './PermissionsTab';
import { api, type TenantPolicyView } from '../../api';
vi.mock('../../api', () => ({ api: { getTenantPolicy: vi.fn(), putTenantPolicy: vi.fn() } }));
vi.mock('./BundlesSection', () => ({ default: () => null }));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn() }) }));
let container: HTMLDivElement;
let root: Root;
let fixture: TenantPolicyView;
function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(button).toBeDefined(); act(() => button!.click());
}
async function render() {
  vi.mocked(api.getTenantPolicy).mockResolvedValue(fixture);
  await act(async () => root.render(<PermissionsTab tenantId="test" onError={vi.fn()} />));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.requestAnimationFrame = () => 0;
  fixture = { grantedScopes: [], groups: {}, accounts: {}, bundles: [], groupBundles: {}, accountBundles: {}, departments: ['人資'], users: [],
    capabilities: [{ id: 'service:form', label: '填表申請', description: '申請服務', base: false },
      { id: 'email:write', label: '寄送 Email', description: '', base: false },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `form:${i}`, label: `申請表 ${i + 1}`, description: '表單說明', base: false }))] };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
it('服務未開通時，表單設定停用並提供開通入口', async () => {
  fixture.grantedScopes = ['form:0'];
  await render(); click('表單');
  expect(container.textContent).toContain('尚未開通');
  expect(container.textContent).toContain('既有表單設定會保留');
  const modes = container.querySelectorAll<HTMLButtonElement>('.mode-seg button');
  expect([...modes].every((button) => button.disabled)).toBe(true);
  click('前往開通服務');
  expect(container.querySelector('[aria-label="填表申請 的授權模式"]')).not.toBeNull();
});
it('開通服務後可選表單，跨頁籤後保留未儲存的授權', async () => {
  await render(); click('所有人'); click('選擇可用表單');
  const group = container.querySelector('[aria-label="申請表 1 的授權模式"]')!;
  act(() => [...group.querySelectorAll('button')].find((button) => button.textContent === '所有人')!.click());
  click('外部能力'); expect(container.textContent).toContain('寄送 Email');
  click('表單');
  expect(container.querySelector('[aria-label="申請表 1 的授權模式"] button[data-mode="all"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('已設定 1 / 25');
});
it('25 份表單分為三頁，搜尋可以跨頁找到表單', async () => {
  fixture.grantedScopes = ['service:form'];
  await render(); click('表單');
  expect(container.querySelectorAll('.mode-seg')).toHaveLength(10);
  click('下一頁'); click('下一頁');
  expect(container.querySelectorAll('.mode-seg')).toHaveLength(5);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜尋表單"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '申請表 25'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.querySelectorAll('.mode-seg')).toHaveLength(1);
  expect(container.textContent).toContain('第 1 / 1 頁');
});
it('服務由已指派角色授予時也能設定表單', async () => {
  fixture.bundles = [{ id: 'employee', name: '員工', scopes: ['service:form'] }];
  fixture.groupBundles = { '人資': ['employee'] };
  await render(); click('表單');
  expect(container.textContent).toContain('已有授權對象');
  expect(container.querySelector<HTMLButtonElement>('.mode-seg button')?.disabled).toBe(false);
});
it('知識庫標籤與 MCP 服務不可選所有人，並說明原因', async () => {
  fixture.capabilities.push(
    { id: 'kb:hr', label: '人事文件', description: '', base: false },
    { id: 'mcp:dbi', label: '資料庫查詢', description: '', base: false },
  );
  await render();
  for (const [category, label] of [['知識庫標籤', '人事文件'], ['外部能力', '資料庫查詢']]) {
    click(category);
    const group = container.querySelector(`[aria-label="${label} 的授權模式"]`)!;
    expect(group.querySelector<HTMLButtonElement>('button[data-mode="all"]')?.disabled).toBe(true);
    expect(group.querySelector<HTMLButtonElement>('button[data-mode="some"]')?.disabled).toBe(false);
  }
  expect(container.textContent).toContain('只能指定部門或帳號');
  const email = container.querySelector('[aria-label="寄送 Email 的授權模式"]')!;
  expect(email.querySelector<HTMLButtonElement>('button[data-mode="all"]')?.disabled).toBe(false);
});
it('所有人摘要註明包含網站訪客', async () => {
  fixture.grantedScopes = ['service:form'];
  await render();
  expect(container.textContent).toContain('含網站訪客');
});
it('知識庫標籤獨立分類，可由外層指定先開啟', async () => {
  fixture.capabilities.push({ id: 'kb:hr', label: '人事文件', description: '', base: false });
  vi.mocked(api.getTenantPolicy).mockResolvedValue(fixture);
  await act(async () => root.render(<PermissionsTab tenantId="test" onError={vi.fn()} initialCategory="kb" />));
  expect(container.querySelector('[aria-label="人事文件 的授權模式"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="寄送 Email 的授權模式"]')).toBeNull();
});
it('有未儲存變更時顯示提示並通知外層，可放棄變更', async () => {
  const onDirtyChange = vi.fn();
  vi.mocked(api.getTenantPolicy).mockResolvedValue(fixture);
  await act(async () => root.render(<PermissionsTab tenantId="test" onError={vi.fn()} onDirtyChange={onDirtyChange} />));
  const saveButton = () => [...container.querySelectorAll<HTMLButtonElement>('.perm-savebar button')].find((b) => b.textContent === '儲存')!;
  expect(saveButton().disabled).toBe(true);
  expect(container.textContent).toContain('所有變更皆已儲存');
  click('所有人');
  expect(container.textContent).toContain('有未儲存的變更');
  expect(saveButton().disabled).toBe(false);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  click('放棄變更');
  expect(container.querySelector('[aria-label="填表申請 的授權模式"] button[data-mode="off"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});
it('儲存成功後回到已儲存狀態', async () => {
  vi.mocked(api.putTenantPolicy).mockImplementation(async (_id, body) => ({ ...fixture, ...body }));
  await render(); click('所有人');
  const save = [...container.querySelectorAll<HTMLButtonElement>('.perm-savebar button')].find((b) => b.textContent === '儲存')!;
  await act(async () => save.click());
  expect(api.putTenantPolicy).toHaveBeenCalledWith('test', expect.objectContaining({ grantedScopes: ['service:form'] }));
  expect(container.textContent).toContain('所有變更皆已儲存');
});
