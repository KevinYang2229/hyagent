// @vitest-environment jsdom
/**
 * 換租戶時 AI 角色頁必須整個重建：它在本地保存角色與知識庫規則的草稿，
 * 若沿用上一個租戶的元件，按儲存會把上一個租戶的草稿寫到新租戶。
 * （獨立成檔：與 TenantDetailPage.test.tsx 的其他導頁測試共用 router 狀態時會互相干擾）
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TenantDetailPage from './TenantDetailPage';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getTenant: vi.fn() }, UnauthorizedError: class extends Error {} }));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../auth', () => ({
  useAuth: () => ({ logout: vi.fn(), isSuper: true, me: { kind: 'super' }, level: () => 'write' }),
}));
vi.mock('../components/AppLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const { personaMounts } = vi.hoisted(() => ({ personaMounts: [] as string[] }));
vi.mock('./tabs/PersonaTab', async () => {
  const { useEffect } = await import('react');
  function PersonaStub({ tenant }: { tenant: { id: string } }) {
    // 只在掛載時記一次：同一個元件換了 tenant prop 不會再記
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { personaMounts.push(tenant.id); }, []);
    return `頁面:persona:${tenant.id}`;
  }
  return { default: PersonaStub };
});

// jsdom 的 AbortSignal 與 Node 內建 Request 不相容，data router 導頁會丟錯；拿掉 signal（同 TenantDetailPage.test.tsx）
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
} as typeof Request;

afterEach(cleanup);

it('換租戶時 AI 角色頁整個重建，不會把上一個租戶的草稿存到新租戶', async () => {
  vi.mocked(api.getTenant).mockImplementation(async (id: string) => ({ id, name: id, allowedOrigins: [], createdAt: '' }));
  const router = createMemoryRouter([{ path: '/tenants/:id', element: <TenantDetailPage /> }], {
    initialEntries: ['/tenants/t1?tab=persona'],
  });
  render(<RouterProvider router={router} />);
  await screen.findByText('頁面:persona:t1');
  act(() => {
    void router.navigate('/tenants/t2?tab=persona');
  });
  await screen.findByText('頁面:persona:t2');
  expect(personaMounts).toEqual(['t1', 't2']);
});
