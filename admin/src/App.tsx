import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from '@hyagent/ui';
import { AuthProvider, useAuth } from './auth';
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

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <TenantsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tenants/:id"
            element={
              <RequireAuth>
                <TenantDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tenants/:id/forms/:formId/design"
            element={
              <RequireAuth>
                <FormDesignerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/skills"
            element={
              <RequireAuth>
                <SkillsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/mcp-servers"
            element={
              <RequireAuth>
                <McpServersPage />
              </RequireAuth>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireAuth>
                <AuditPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
