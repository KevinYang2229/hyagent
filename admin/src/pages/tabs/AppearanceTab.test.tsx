// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';
import { api, type Tenant } from '../../api';

vi.mock('../../api', () => ({ api: { updateTenant: vi.fn() } }));
vi.mock('../../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));

const base: Tenant = {
  id: 't1',
  name: '宏碁',
  appearance: { assistantName: '小華' },
  assistantPersona: { member: { preset: 'hr' } },
  createdAt: '',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.updateTenant).mockResolvedValue(base as never);
});
afterEach(cleanup);

it('外觀頁不含 AI 角色設定（已移到獨立的「AI 角色」頁籤）', () => {
  render(<AppearanceTab tenant={base} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.queryByLabelText('登入員工的角色')).not.toBeInTheDocument();
});

it('儲存外觀時只送 appearance，不帶 assistantPersona（只有外觀權限也存得了）', async () => {
  const onSaved = vi.fn();
  render(<AppearanceTab tenant={base} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '儲存外觀' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateTenant).toHaveBeenCalledWith('t1', { appearance: { assistantName: '小華' } });
});
