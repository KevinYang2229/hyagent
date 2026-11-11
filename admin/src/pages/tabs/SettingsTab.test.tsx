// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsTab from './SettingsTab';
import { api } from '../../api';

const { auth } = vi.hoisted(() => ({ auth: { isSuper: false, ai: 'write' as 'hidden' | 'read' | 'write' } }));
vi.mock('../../api', () => ({
  api: { updateTenant: vi.fn(), getLlmConfig: vi.fn(), putLlmConfig: vi.fn(), createKey: vi.fn() },
}));
vi.mock('../../auth', () => ({
  useAuth: () => ({ isSuper: auth.isSuper, level: (k: string) => (auth.isSuper ? 'write' : k === 'ai' ? auth.ai : 'write') }),
}));
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

it('基本設定頁不呼叫 getLlmConfig（租戶管理者可能沒有 ai 權限）', async () => {
  auth.isSuper = false;
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />);
  await screen.findByRole('button', { name: '儲存設定' });
  expect(api.getLlmConfig).not.toHaveBeenCalled();
});

it('AI 模型頁會呼叫 getLlmConfig', async () => {
  auth.isSuper = false;
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} section="ai" />);
  await waitFor(() => expect(api.getLlmConfig).toHaveBeenCalledWith('t1'));
});

it('租戶管理者沒有 AI 模型編輯權時，不能產生私密金鑰（sk_）；公開金鑰仍可產生', async () => {
  auth.isSuper = false;
  auth.ai = 'read';
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByRole('button', { name: /產生私密金鑰/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /產生公開金鑰/ })).toBeEnabled();
  auth.ai = 'write';
});

it('有 AI 模型編輯權（或超級管理者）時可產生私密金鑰', async () => {
  auth.isSuper = false;
  auth.ai = 'write';
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByRole('button', { name: /產生私密金鑰/ })).toBeEnabled();
});

it('唯讀時設定欄位與產生金鑰都停用', async () => {
  auth.isSuper = false;
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} readonly />);
  expect(screen.getByRole('button', { name: '儲存設定' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /產生公開金鑰/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /產生私密金鑰/ })).toBeDisabled();
});

it('儲存期間顯示全畫面遮罩並將 #root 設為 inert，完成後移除', async () => {
  let resolve!: (v: unknown) => void;
  vi.mocked(api.updateTenant).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  render(<SettingsTab tenant={tenant} onSaved={vi.fn()} onError={vi.fn()} />, { container: root });
  fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
  expect(await screen.findByRole('alert')).toHaveClass('saving-overlay');
  expect(root).toHaveAttribute('inert');
  resolve(tenant);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(root).not.toHaveAttribute('inert');
  root.remove();
});
