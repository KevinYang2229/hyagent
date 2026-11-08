import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, type RouteObject } from 'react-router-dom';
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

function RequireAuth({ children }: { children: ReactNode }) {
  const { authed } = useAuth();
  const loc = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

const guarded = (element: ReactNode) => <RequireAuth>{element}</RequireAuth>;

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
      { path: '/tenants/:id', element: guarded(<TenantDetailPage />) },
      { path: '/tenants/:id/forms/:formId/design', element: guarded(<FormDesignerPage />) },
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
