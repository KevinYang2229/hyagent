// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppLayout from './AppLayout';
import { tokenStore } from '../api';

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('../auth', () => ({
  useAuth: () => ({
    logout,
    isSuper: false,
    me: { kind: 'tenant-admin', accountId: 'a1', username: 'amy', displayName: 'Amy', tenantId: 't1', permissions: {} },
  }),
}));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  tokenStore.set('valid-token');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('修改密碼時目前密碼錯誤（422）：對話框顯示「目前密碼錯誤」，不登出、token 保留', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { code: 'UNPROCESSABLE', message: '目前密碼錯誤' } }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }),
  ));
  render(<MemoryRouter><AppLayout title="t">內容</AppLayout></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '修改密碼' }));
  const [current, next, again] = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
  fireEvent.change(current, { target: { value: 'wrong-password' } });
  fireEvent.change(next, { target: { value: 'a-new-long-password' } });
  fireEvent.change(again, { target: { value: 'a-new-long-password' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  expect(await screen.findByText('目前密碼錯誤')).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('未授權')).not.toBeInTheDocument();
  expect(logout).not.toHaveBeenCalled();
  expect(tokenStore.get()).toBe('valid-token');
});
