// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth';
import { api, tokenStore } from './api';

const { store, Unauthorized } = vi.hoisted(() => {
  let t: string | null = null;
  return {
    store: { get: () => t, set: (v: string) => { t = v; }, clear: () => { t = null; } },
    Unauthorized: class extends Error {},
  };
});
vi.mock('./api', () => ({
  api: { login: vi.fn(), getMe: vi.fn() },
  tokenStore: store,
  UnauthorizedError: Unauthorized,
}));

const tenantMe = {
  kind: 'tenant-admin' as const, accountId: 'a1', username: 'acme-ops', displayName: '小明',
  tenantId: 't1', permissions: { knowledge: 'read' as const, forms: 'write' as const },
};

let ctx: ReturnType<typeof useAuth>;
function Probe() {
  ctx = useAuth();
  return <div data-testid="s">{ctx.authed ? `in:${ctx.me?.kind ?? 'none'}` : 'out'}</div>;
}
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(() => { vi.resetAllMocks(); tokenStore.clear(); });
afterEach(cleanup);

it('登入回傳的 me 會被保存，level 依權限回傳', async () => {
  vi.mocked(api.login).mockResolvedValue({ token: 'tk', me: tenantMe });
  mount();
  await act(async () => { await ctx.login('acme-ops', 'pw'); });
  expect(api.login).toHaveBeenCalledWith('acme-ops', 'pw');
  expect(tokenStore.get()).toBe('tk');
  expect(ctx.me).toEqual(tenantMe);
  expect(ctx.isSuper).toBe(false);
  expect(ctx.level('knowledge')).toBe('read');
  expect(ctx.level('forms')).toBe('write');
  expect(ctx.level('webhook')).toBe('hidden');
  expect(api.getMe).not.toHaveBeenCalled();
});

it('超級管理者的 level 一律為 write', async () => {
  vi.mocked(api.login).mockResolvedValue({ token: 'tk', me: { kind: 'super' } });
  mount();
  await act(async () => { await ctx.login('admin', 'pw'); });
  expect(ctx.isSuper).toBe(true);
  expect(ctx.level('audit')).toBe('write');
});

it('有 token 但 me 未載入時呼叫 getMe', async () => {
  tokenStore.set('old');
  vi.mocked(api.getMe).mockResolvedValue(tenantMe);
  mount();
  await waitFor(() => expect(screen.getByTestId('s')).toHaveTextContent('in:tenant-admin'));
});

it('getMe 回 401 時登出', async () => {
  tokenStore.set('old');
  vi.mocked(api.getMe).mockRejectedValue(new Unauthorized('未授權'));
  mount();
  await waitFor(() => expect(screen.getByTestId('s')).toHaveTextContent('out'));
  expect(tokenStore.get()).toBeNull();
});
