// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsTab from './SettingsTab';
import { api } from '../../api';

const { auth } = vi.hoisted(() => ({ auth: { isSuper: false } }));
vi.mock('../../api', () => ({
  api: { updateTenant: vi.fn(), getLlmConfig: vi.fn(), putLlmConfig: vi.fn(), createKey: vi.fn() },
}));
vi.mock('../../auth', () => ({ useAuth: () => ({ isSuper: auth.isSuper }) }));
vi.mock('../../components/confirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));

const tenant = { id: 't1', name: '宏碁', allowedOrigins: ['https://a.com'], quotaMonthlyLlmTokens: 500, createdAt: '' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getLlmConfig).mockResolvedValue({} as never);
  vi.mocked(api.updateTenant).mockResolvedValue(tenant as never);
});
afterEach(cleanup);

async function save() {
  const onSaved = vi.fn();
  render(<SettingsTab tenant={tenant} onSaved={onSaved} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
  await waitFor(() => expect(api.updateTenant).toHaveBeenCalled());
  return vi.mocked(api.updateTenant).mock.calls[0][1];
}

it('租戶管理者儲存時，body 不含 quotaMonthlyLlmTokens，配額欄位唯讀', async () => {
  auth.isSuper = false;
  const body = await save();
  expect(body).not.toHaveProperty('quotaMonthlyLlmTokens');
  expect(body).toMatchObject({ name: '宏碁' });
  expect(screen.getByPlaceholderText(/例：1000000/)).toHaveAttribute('readonly');
});

it('超級管理者儲存時仍會送出配額', async () => {
  auth.isSuper = true;
  const body = await save();
  expect(body.quotaMonthlyLlmTokens).toBe(500);
  expect(screen.getByPlaceholderText(/例：1000000/)).not.toHaveAttribute('readonly');
});
