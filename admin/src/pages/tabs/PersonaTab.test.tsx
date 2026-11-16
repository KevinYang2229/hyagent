// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PersonaTab from './PersonaTab';
import { TAB_GROUPS, TAB_LABELS } from '../tabGroups';
import { api, type Tenant } from '../../api';
import { useUnsavedChanges } from '../../components/unsaved';

vi.mock('../../api', () => ({ api: { updateTenant: vi.fn(), previewPersona: vi.fn() } }));
vi.mock('../../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));

const base: Tenant = { id: 't1', name: '宏碁', appearance: { assistantName: '小華' }, createdAt: '' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.updateTenant).mockResolvedValue(base as never);
});
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

it('預覽 API 失敗時仍可儲存，送出的 patch 正確', async () => {
  vi.mocked(api.previewPersona).mockRejectedValue(new Error('boom'));
  const onSaved = vi.fn();
  render(<PersonaTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'it' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存 AI 角色' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', { assistantPersona: { member: { preset: 'it' }, guest: null } });
  expect(await screen.findByText('預覽暫時無法產生')).toBeInTheDocument();
});
