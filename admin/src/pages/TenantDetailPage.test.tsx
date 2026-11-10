// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import UnsavedGuard from '../components/UnsavedGuard';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TenantDetailPage from './TenantDetailPage';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getTenant: vi.fn() }, UnauthorizedError: class extends Error {} }));
vi.mock('@hyagent/ui', async () => ({ ...await vi.importActual<object>('@hyagent/ui'), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const { authState } = vi.hoisted(() => ({
  authState: { perms: null as null | Record<string, 'read' | 'write' | 'hidden'> },
}));
vi.mock('../auth', () => ({
  useAuth: () => {
    const perms = authState.perms;
    return {
      logout: vi.fn(),
      isSuper: perms === null,
      me: perms === null ? { kind: 'super' } : { kind: 'tenant-admin', tenantId: 't1', permissions: perms },
      level: (k: string) => (perms === null ? 'write' : perms[k] ?? 'hidden'),
    };
  },
}));
vi.mock('../components/AppLayout', () => ({ default: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => <div>{actions}{children}</div> }));
// 各頁籤內容不是此測試的重點，換成標記
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ default: () => `頁面:${name}` }) }));
vi.mock('./tabs/OverviewTab', () => stub('overview'));
// 基本設定頁模擬「有未儲存修改」，驗證租戶頁的中央離開提醒
vi.mock('./tabs/SettingsTab', async () => {
  const { useUnsavedChanges } = await import('../components/unsaved');
  function DirtySettings() { useUnsavedChanges('基本設定：租戶設定', true); return '頁面:settings'; }
  return { default: DirtySettings };
});
vi.mock('./tabs/AppearanceTab', () => stub('appearance'));
vi.mock('./tabs/WebhookTab', () => stub('webhook'));
vi.mock('./tabs/UsageTab', () => stub('usage'));
vi.mock('./tabs/FormsTab', () => stub('forms'));
vi.mock('./tabs/KnowledgeTab', () => stub('knowledge'));
vi.mock('./tabs/PermissionsTab', () => stub('permissions'));
vi.mock('./tabs/AuditTab', () => stub('audit'));
vi.mock('./tabs/FeedbackTab', () => stub('feedback'));
vi.mock('./tabs/ReportsTab', () => stub('reports'));
vi.mock('./tabs/UsersTab', () => stub('users'));
vi.mock('./tabs/SsoTab', () => stub('sso'));
vi.mock('./tabs/AdminAccountsTab', () => stub('adminAccounts'));
vi.mock('./tabs/DirectorySyncTab', () => stub('directorySync'));
vi.mock('./tabs/database/DatabaseTab', () => stub('database'));

// 測試環境專用：jsdom 的 AbortSignal 與 Node 內建 Request（undici）不相容，
// data router 導頁時建立 Request 會丟錯而無法切頁。真實瀏覽器沒有這個問題；這裡拿掉 signal 讓導頁可進行。
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
} as typeof Request;

function Where() { return <div data-testid="where">{useLocation().search}</div>; }

beforeEach(() => {
  authState.perms = null;
  vi.mocked(api.getTenant).mockResolvedValue({ id: 't1', name: '宏碁', allowedOrigins: [], createdAt: '' });
});
afterEach(cleanup);

function renderAt(search = '') {
  // 與正式環境相同：data router 最外層包 UnsavedGuard
  const router = createMemoryRouter([{
    element: <UnsavedGuard><Outlet /></UnsavedGuard>,
    children: [
      { path: '/tenants/:id', element: <><TenantDetailPage /><Where /></> },
      { path: '/', element: <div>頁面:tenant-list</div> },
    ],
  }], { initialEntries: [`/tenants/t1${search}`] });
  render(<RouterProvider router={router} />);
  return router;
}

it('預設進入總覽；導覽依導入流程分組，權限排在內容之後', async () => {
  renderAt();
  expect(await screen.findByText('頁面:overview')).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: '租戶設定導覽' });
  const labels = [...nav.querySelectorAll('.tenant-nav-label')].map((el) => el.textContent);
  expect(labels).toEqual(['接入', '人員與登入', '內容與能力', '權限', '前台呈現', '營運']);
  const items = within(nav).getAllByRole('button').map((b) => b.textContent);
  expect(items.indexOf('角色與授權')).toBeGreaterThan(items.indexOf('表單'));
  expect(items[0]).toBe('總覽');
});

it('點導覽切換頁面並寫入網址；舊的 tab 參數仍有效', async () => {
  renderAt('?tab=knowledge');
  expect(await screen.findByText('頁面:knowledge')).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: '租戶設定導覽' });
  expect(within(nav).getByRole('button', { name: '知識庫' })).toHaveAttribute('aria-current', 'page');
  fireEvent.click(within(nav).getByRole('button', { name: '使用者目錄' }));
  expect(await screen.findByText('頁面:users')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('tab=users'));
});

it('窄螢幕的下拉選單與導覽同步', async () => {
  renderAt('?tab=audit');
  const select = await screen.findByLabelText('切換租戶設定頁面');
  expect(select).toHaveValue('audit');
  fireEvent.change(select, { target: { value: 'permissions' } });
  expect(await screen.findByText('頁面:permissions')).toBeInTheDocument();
});

it('有區塊未儲存時，切換頁籤先確認並列出是哪個區塊；留在此頁不會切走', async () => {
  renderAt('?tab=settings');
  await screen.findByText('頁面:settings');
  const nav = screen.getByRole('navigation', { name: '租戶設定導覽' });
  fireEvent.click(within(nav).getByRole('button', { name: '外觀' }));
  expect(await screen.findByText(/基本設定：租戶設定/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '留在此頁' }));
  expect(await screen.findByText('頁面:settings')).toBeInTheDocument();
  fireEvent.click(within(nav).getByRole('button', { name: '外觀' }));
  fireEvent.click(await screen.findByRole('button', { name: '放棄並離開' }));
  expect(await screen.findByText('頁面:appearance')).toBeInTheDocument();
});

it('有區塊未儲存時，按「租戶清單」離開也會先確認', async () => {
  renderAt('?tab=settings');
  await screen.findByText('頁面:settings');
  fireEvent.click(screen.getByRole('button', { name: /租戶清單/ }));
  expect(await screen.findByText(/基本設定：租戶設定/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '放棄並離開' }));
  expect(await screen.findByText('頁面:tenant-list')).toBeInTheDocument();
});

it('超級管理者看得到全部 17 個分頁', async () => {
  renderAt();
  await screen.findByText('頁面:overview');
  const nav = screen.getByRole('navigation', { name: '租戶設定導覽' });
  expect(within(nav).getAllByRole('button')).toHaveLength(17);
  expect(within(nav).getByRole('button', { name: '資料庫查詢' })).toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: '後台管理者' })).toBeInTheDocument();
});

it('租戶管理者只看到有權限的分頁；唯讀分頁包在 disabled fieldset，可寫的不會；沒有租戶清單按鈕', async () => {
  authState.perms = { knowledge: 'read', forms: 'write' };
  renderAt('?tab=knowledge');
  const content = await screen.findByText('頁面:knowledge');
  const nav = screen.getByRole('navigation', { name: '租戶設定導覽' });
  expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['總覽', '知識庫', '表單']);
  expect(within(nav).queryByRole('button', { name: '後台管理者' })).not.toBeInTheDocument();
  const fs = content.closest('fieldset');
  expect(fs).toHaveAttribute('disabled');
  expect(fs).toHaveClass('tab-readonly');
  expect(screen.getByText('此分頁為唯讀，如需修改請聯絡平台管理者')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /租戶清單/ })).not.toBeInTheDocument();
  fireEvent.click(within(nav).getByRole('button', { name: '表單' }));
  const forms = await screen.findByText('頁面:forms');
  expect(forms.closest('fieldset')).toBeNull();
  expect(screen.queryByText('此分頁為唯讀，如需修改請聯絡平台管理者')).not.toBeInTheDocument();
});

it('?tab 指到看不到的分頁時退回總覽', async () => {
  authState.perms = { knowledge: 'read' };
  renderAt('?tab=webhook');
  expect(await screen.findByText('頁面:overview')).toBeInTheDocument();
  expect(screen.queryByText('頁面:webhook')).not.toBeInTheDocument();
});

it('租戶管理者不能用 ?tab=database 進資料庫查詢', async () => {
  authState.perms = { knowledge: 'write' };
  renderAt('?tab=database');
  expect(await screen.findByText('頁面:overview')).toBeInTheDocument();
});
