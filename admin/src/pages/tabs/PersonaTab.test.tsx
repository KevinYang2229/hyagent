// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PersonaTab from './PersonaTab';
import { TAB_GROUPS, TAB_LABELS } from '../tabGroups';
import { api, type Tenant } from '../../api';
import { useUnsavedChanges } from '../../components/unsaved';

vi.mock('../../api', () => ({ api: { updateTenant: vi.fn(), previewPersona: vi.fn(), getKnowledgeRules: vi.fn() } }));
vi.mock('../../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));

const base: Tenant = { id: 't1', name: '宏碁', appearance: { assistantName: '小華' }, createdAt: '' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.updateTenant).mockResolvedValue(base as never);
  vi.mocked(api.getKnowledgeRules).mockResolvedValue(RULES_INFO);
});

const RULES_INFO = {
  member: { defaults: ['數字規則', '精簡規則'], locked: ['🔒防捏造'], custom: null },
  guest: { defaults: ['精簡規則'], locked: ['🔒不提文件名稱'], custom: ['已存的訪客規則'] },
};
afterEach(cleanup);

function lastDirty(): [string, boolean] {
  const calls = vi.mocked(useUnsavedChanges).mock.calls;
  return calls[calls.length - 1];
}

it('頁籤名稱為「AI 角色」，放在「前台呈現」群組', () => {
  expect(TAB_LABELS.persona).toBe('AI 角色');
  const group = TAB_GROUPS.find((g) => g.tabs.some((t) => t.key === 'persona'));
  expect(group?.label).toBe('前台呈現');
});

it('只改角色就算未儲存，回報名稱為「AI 角色」', () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(lastDirty()).toEqual(['AI 角色', false]);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'hr' } });
  expect(lastDirty()).toEqual(['AI 角色', true]);
});

it('儲存時只送角色設定，不帶外觀', async () => {
  const onSaved = vi.fn();
  render(<PersonaTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('網站訪客的角色'), { target: { value: 'cs' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存 AI 角色' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', {
    assistantPersona: { member: null, guest: { preset: 'cs' } },
  });
});

it('讀入既有設定時回填且不算未儲存', () => {
  const tenant: Tenant = { ...base, assistantPersona: { guest: { preset: 'cs', contact: '02-1234' } } };
  render(<PersonaTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByLabelText('網站訪客的角色')).toHaveValue('cs');
  expect(lastDirty()[1]).toBe(false);
});

it('唯讀時欄位與儲存按鈕都停用', () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} readonly />);
  expect(screen.getByLabelText('登入員工的角色')).toBeDisabled();
  expect(screen.getByRole('button', { name: '儲存 AI 角色' })).toBeDisabled();
});

it('分「設定」與「預覽」子頁籤；切到預覽才取得資料，且用的是還沒存檔的設定', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['員工預覽'], guest: [], rules: { member: [], guest: [] } });
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByRole('tab', { name: '設定' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'it' } });
  await new Promise((r) => setTimeout(r, 450));
  expect(api.previewPersona).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('tab', { name: '預覽' }));
  expect(await screen.findByText('員工預覽')).toBeInTheDocument();
  expect(vi.mocked(api.previewPersona).mock.calls[0][1].assistantPersona.member).toEqual({ preset: 'it' });

  fireEvent.click(screen.getByRole('tab', { name: '設定' }));
  expect(screen.getByLabelText('登入員工的角色')).toHaveValue('it');
});

it('預覽 API 失敗時仍可回到設定儲存，送出的 patch 正確', async () => {
  vi.mocked(api.previewPersona).mockRejectedValue(new Error('boom'));
  const onSaved = vi.fn();
  render(<PersonaTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'it' } });
  fireEvent.click(screen.getByRole('tab', { name: '預覽' }));
  expect(await screen.findByText('預覽暫時無法產生')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '設定' }));
  fireEvent.click(screen.getByRole('button', { name: '儲存 AI 角色' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', { assistantPersona: { member: { preset: 'it' }, guest: null } });
});

it('有「設定／知識庫規則／預覽」三個子頁籤', () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['設定', '知識庫規則', '預覽']);
});

it('儲存規則：只送 knowledgeAnswerRules；與內建相同的一側送 null，已存的自訂保留', async () => {
  const onSaved = vi.fn();
  render(<PersonaTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '知識庫規則' }));
  const first = (await screen.findAllByRole('textbox', { name: /^規則 \d+$/ }))[0];
  fireEvent.change(first, { target: { value: '員工新規則' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存規則' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', {
    knowledgeAnswerRules: { member: ['員工新規則', '精簡規則'], guest: ['已存的訪客規則'] },
  });
});

it('只改規則時以「知識庫規則」回報未儲存', async () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '知識庫規則' }));
  const first = (await screen.findAllByRole('textbox', { name: /^規則 \d+$/ }))[0];
  fireEvent.change(first, { target: { value: '改了' } });
  const calls = vi.mocked(useUnsavedChanges).mock.calls.filter(([label]) => label === '知識庫規則');
  expect(calls.at(-1)?.[1]).toBe(true);
});

it('預覽帶上規則草稿', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: { member: [], guest: [] } });
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '知識庫規則' }));
  const first = (await screen.findAllByRole('textbox', { name: /^規則 \d+$/ }))[0];
  fireEvent.change(first, { target: { value: '草稿規則' } });
  fireEvent.click(screen.getByRole('tab', { name: '預覽' }));
  await waitFor(() => expect(api.previewPersona).toHaveBeenCalled());
  expect(vi.mocked(api.previewPersona).mock.calls.at(-1)?.[1].knowledgeAnswerRules).toEqual({
    member: ['草稿規則', '精簡規則'],
    guest: ['已存的訪客規則'],
  });
});

it('子頁籤是頁面最上方的獨立區塊，不在設定卡片裡', () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByRole('tablist', { name: 'AI 角色子頁' }).closest('.card')).toBeNull();
});

it('「還原預設」與「儲存規則」在同一列', async () => {
  render(<PersonaTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '知識庫規則' }));
  const save = await screen.findByRole('button', { name: '儲存規則' });
  expect(screen.getByRole('button', { name: '還原預設' }).parentElement).toBe(save.parentElement);
});
