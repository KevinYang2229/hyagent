// @vitest-environment jsdom
/**
 * 唯讀分頁的實際行為（不 stub 分頁元件）：讀取類動作（下載、搜尋、篩選、分頁）要能用，
 * 寫入類控制項要停用或隱藏，且仍顯示唯讀提示。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TenantDetailPage from './TenantDetailPage';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getTenant: vi.fn(),
    listReports: vi.fn(),
    downloadReport: vi.fn(),
    listDirectoryUsers: vi.fn(),
    listDepartments: vi.fn(),
    getDirectorySync: vi.fn(),
    listWebhooks: vi.fn(),
  },
  UnauthorizedError: class extends Error {},
}));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../auth', () => ({
  useAuth: () => ({
    logout: vi.fn(),
    isSuper: false,
    me: { kind: 'tenant-admin', tenantId: 't1', permissions: { reports: 'read', users: 'read', webhook: 'read' } },
    level: (k: string) => ({ reports: 'read', users: 'read', webhook: 'read' } as Record<string, string>)[k] ?? 'hidden',
  }),
}));
vi.mock('../components/AppLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./tabs/OverviewTab', () => ({ default: () => '頁面:overview' }));
vi.mock('../components/unsaved', () => ({ useUnsavedChanges: vi.fn() }));
vi.mock('../components/confirm', () => ({ useConfirm: () => vi.fn() }));

const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
} as typeof Request;

function renderAt(search: string) {
  const router = createMemoryRouter([{ path: '/tenants/:id', element: <TenantDetailPage /> }], {
    initialEntries: [`/tenants/t1${search}`],
  });
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTenant).mockResolvedValue({ id: 't1', name: '宏碁', allowedOrigins: [], createdAt: '' });
});
afterEach(cleanup);

it('唯讀的報告分頁：可以搜尋與下載', async () => {
  vi.mocked(api.listReports).mockResolvedValue([
    {
      reportId: 'r1',
      userId: 'amy',
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      files: [{ format: 'pdf', filename: '月報.pdf' }],
    },
  ] as never);
  vi.mocked(api.downloadReport).mockResolvedValue(undefined as never);
  renderAt('?tab=reports');
  expect(await screen.findByText('此分頁為唯讀，如需修改請聯絡平台管理者')).toBeInTheDocument();
  const pdf = await screen.findByRole('button', { name: 'PDF' });
  expect(pdf).toBeEnabled();
  fireEvent.click(pdf);
  await waitFor(() => expect(api.downloadReport).toHaveBeenCalledWith('t1', 'r1', 'pdf', '月報.pdf'));
  expect(screen.getByRole('button', { name: '查詢' })).toBeEnabled();
});

it('唯讀的使用者目錄：搜尋、篩選、分頁可用；新增、編輯、刪除不可用', async () => {
  const users = Array.from({ length: 25 }, (_, i) => ({ id: `u${String(i).padStart(2, '0')}`, name: `人員${i}`, department: '業務' }));
  vi.mocked(api.listDirectoryUsers).mockResolvedValue({ users });
  vi.mocked(api.listDepartments).mockResolvedValue({ departments: [] });
  vi.mocked(api.getDirectorySync).mockResolvedValue({ directorySyncEnabled: false, ssoAutoProvision: false } as never);
  renderAt('?tab=users');
  const search = await screen.findByRole('textbox', { name: '搜尋使用者' });
  expect(search).toBeEnabled();
  expect(screen.getByRole('combobox', { name: '依部門篩選' })).toBeEnabled();
  const next = screen.getByRole('button', { name: '下一頁' });
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(await screen.findByText(/第 2 \/ 2 頁/)).toBeInTheDocument();
  fireEvent.change(search, { target: { value: '人員3' } });
  expect(screen.getByText('人員3')).toBeInTheDocument();

  expect(screen.queryByRole('button', { name: '新增使用者' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^編輯 / })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刪除 人員3' })).toBeDisabled();
});

it('唯讀的事件通知：不顯示新增區，啟停與刪除停用', async () => {
  vi.mocked(api.listWebhooks).mockResolvedValue([{ id: 'w1', tenantId: 't1', url: 'https://hook.example.com', secret: '••••abcd', createdAt: '' }]);
  renderAt('?tab=webhook');
  expect(await screen.findByText('https://hook.example.com')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '新增' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停用' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '刪除' })).toBeDisabled();
});
