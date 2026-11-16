// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';
import { api, type Tenant } from '../../api';
import { useUnsavedChanges } from '../../components/unsaved';

vi.mock('../../api', () => ({ api: { updateTenant: vi.fn() } }));
vi.mock('../../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));

const base: Tenant = { id: 't1', name: '宏碁', appearance: { assistantName: '小華' }, createdAt: '' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.updateTenant).mockResolvedValue(base as never);
});
afterEach(cleanup);

function lastDirty(): boolean {
  const calls = vi.mocked(useUnsavedChanges).mock.calls;
  return calls[calls.length - 1][1];
}

it('只改 AI 角色也算未儲存', () => {
  render(<AppearanceTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(lastDirty()).toBe(false);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'hr' } });
  expect(lastDirty()).toBe(true);
});

it('儲存時外觀與角色設定一起送出，未設定的一側送 null', async () => {
  const onSaved = vi.fn();
  render(<AppearanceTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'hr' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存外觀' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', {
    appearance: { assistantName: '小華' },
    assistantPersona: { member: { preset: 'hr' }, guest: null },
  });
});

it('讀入既有角色設定時不算未儲存', () => {
  const tenant: Tenant = { ...base, assistantPersona: { guest: { preset: 'cs', contact: '02-1234' } } };
  render(<AppearanceTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByLabelText('網站訪客的角色')).toHaveValue('cs');
  expect(lastDirty()).toBe(false);
});
