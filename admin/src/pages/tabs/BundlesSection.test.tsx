// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssignmentSection } from './BundlesSection';
import type { TenantPolicyView } from '../../api';

let container: HTMLDivElement;
let root: Root;
function fixture(): TenantPolicyView {
  return {
    grantedScopes: [], groups: {}, accounts: {}, capabilities: [],
    departments: Array.from({ length: 35 }, (_, i) => `部門 ${String(i + 1).padStart(2, '0')}`),
    users: Array.from({ length: 67 }, (_, i) => ({ id: `user-${i + 1}`, label: `使用者 ${i + 1}` })),
    bundles: Array.from({ length: 18 }, (_, i) => ({ id: `role-${i + 1}`, name: `角色 ${i + 1}`, scopes: [] })),
    groupBundles: { '部門 01': ['role-1', 'role-2', 'role-3', 'role-4', 'role-5'] }, accountBundles: {},
  };
}
function Harness() {
  const [policy, setPolicy] = useState(fixture);
  return <AssignmentSection policy={policy} onToggle={(kind, key, id) => setPolicy((current) => {
    const old = current[kind][key] ?? [];
    return { ...current, [kind]: { ...current[kind], [key]: old.includes(id) ? old.filter((value) => value !== id) : [...old, id] } };
  })} />;
}
function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(button).toBeDefined();
  act(() => button!.click());
}
function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('大量對象的角色指派', () => {
  it('35 個部門分成四頁，67 個帳號分成七頁，兩者不混列', () => {
    expect(container.querySelectorAll('.assignment-item')).toHaveLength(10);
    expect(container.textContent).toContain('第 1 / 4 頁');
    expect(container.textContent).not.toContain('使用者 1');
    click('下一頁');
    expect(container.querySelector('.assignment-identity')?.textContent).toContain('部門 11');
    click('下一頁'); click('下一頁');
    expect(container.querySelectorAll('.assignment-item')).toHaveLength(5);
    click('帳號');
    expect(container.textContent).toContain('第 1 / 7 頁');
    expect(container.textContent).toContain('不含從部門繼承');
    expect(container.querySelectorAll('.assignment-item')).toHaveLength(10);
  });
  it('多個角色只顯示三個摘要，其餘收合，編輯才顯示 18 個選項', () => {
    expect(container.querySelector('.assignment-summary > .assignment-chips')?.children).toHaveLength(3);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.textContent).toContain('另有 2 個角色');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    click('編輯角色');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(18);
  });
  it('搜尋對象可跨頁定位，無結果有提示', () => {
    input('搜尋指派對象', '部門 35');
    expect(container.querySelectorAll('.assignment-item')).toHaveLength(1);
    input('搜尋指派對象', '不存在');
    expect(container.textContent).toContain('找不到符合條件的對象');
  });
  it('跨頁、切換類型與角色搜尋不會遺失勾選', () => {
    click('編輯角色');
    input('搜尋角色', '角色 18');
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => box.click());
    click('下一頁'); click('帳號'); click('部門'); click('編輯角色');
    const last = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    expect(last.checked).toBe(true);
    expect(container.textContent).toContain('直接指派 · 6 個角色');
  });
  it('依未指派狀態篩選，已指派對象不會混入', () => {
    const select = container.querySelector('select')!;
    act(() => { select.value = 'unassigned'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('共 34 筆');
    expect(container.querySelector('.assignment-identity')?.textContent).toContain('部門 02');
  });
});
