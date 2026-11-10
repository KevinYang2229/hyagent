import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useParams, type RouteObject } from 'react-router-dom';
import { ToastProvider } from '@hyagent/ui';
import { AuthProvider, useAuth } from './auth';
import { ConfirmProvider } from './components/confirm';
import UnsavedGuard from './components/UnsavedGuard';
import LoginPage from './pages/LoginPage';
import TenantsPage from './pages/TenantsPage';
import TenantDetailPage from './pages/TenantDetailPage';
import SkillsPage from './pages/SkillsPage';
import McpServersPage from './pages/McpServersPage';
import AuditPage from './pages/AuditPage';
import FormDesignerPage from './pages/FormDesignerPage';

/**
 * scope：
 * - platform：平台層頁面，租戶管理者一律導回自己的租戶
 * - tenant：租戶頁面，租戶管理者只能看自己的租戶（網址 :id 對不上就導回）
 */
function RequireAuth({ children, scope }: { children: ReactNode; scope: 'platform' | 'tenant' }) {
  const { authed, me } = useAuth();
  const { id } = useParams();
  const loc = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // 重新整理後身分還在載入：先不渲染，避免租戶管理者閃過平台頁
  if (!me) return <div className="card"><div className="empty">載入中…</div></div>;
  if (me.kind === 'tenant-admin') {
    const home = `/tenants/${encodeURIComponent(me.tenantId)}`;
    if (scope === 'platform' || id !== me.tenantId) return <Navigate to={home} replace />;
  }
  return <>{children}</>;
}

const guarded = (element: ReactNode, scope: 'platform' | 'tenant' = 'platform') => (
  <RequireAuth scope={scope}>{element}</RequireAuth>
);

/**
 * 路由表。最外層包 UnsavedGuard：任何頁面有未儲存的新增／編輯時，離開前都會先確認
 * （需用 data router，useBlocker 才能攔下側邊選單、返回鍵與程式導頁）。
 */
const routes: RouteObject[] = [
  {
    element: <UnsavedGuard><Outlet /></UnsavedGuard>,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: guarded(<TenantsPage />) },
      { path: '/tenants/:id', element: guarded(<TenantDetailPage />, 'tenant') },
      { path: '/tenants/:id/forms/:formId/design', element: guarded(<FormDesignerPage />, 'tenant') },
      { path: '/skills', element: guarded(<SkillsPage />) },
      { path: '/mcp-servers', element: guarded(<McpServersPage />) },
      { path: '/audit', element: guarded(<AuditPage />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
