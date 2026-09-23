import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '@hyagent/ui';
import { api, UnauthorizedError, type Tenant } from '../api';
import { useAuth } from '../auth';
import AppLayout from '../components/AppLayout';
import { IconBack } from '../components/icons';
import AppearanceTab from './tabs/AppearanceTab';
import SettingsTab from './tabs/SettingsTab';
import WebhookTab from './tabs/WebhookTab';
import UsageTab from './tabs/UsageTab';
import FormsTab from './tabs/FormsTab';
import KnowledgeTab from './tabs/KnowledgeTab';
import PermissionsTab from './tabs/PermissionsTab';
import AuditTab from './tabs/AuditTab';
import ReportsTab from './tabs/ReportsTab';
import UsersTab from './tabs/UsersTab';
import SsoTab from './tabs/SsoTab';

type TabKey =
  | 'sso'
  | 'users'
  | 'appearance'
  | 'forms'
  | 'knowledge'
  | 'permissions'
  | 'settings'
  | 'webhook'
  | 'usage'
  | 'reports'
  | 'audit';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'settings', label: '設定' },
  { key: 'appearance', label: '外觀' },
  { key: 'sso', label: '自動登入' },
  { key: 'users', label: '使用者目錄' },
  { key: 'permissions', label: '權限' },
  { key: 'forms', label: '表單' },
  { key: 'knowledge', label: '知識庫' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'usage', label: '用量' },
  { key: 'reports', label: '報告' },
  { key: 'audit', label: '稽核' },
];

export default function TenantDetailPage() {
  const { id = '' } = useParams();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  // 分頁狀態同步到網址（?tab=...）：重整/分享連結停留在原分頁，不再重置回第一頁
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : 'settings';
  const setTab = (next: TabKey) => setSearchParams({ tab: next }, { replace: true });

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate('/login', { replace: true });
        return;
      }
      toast.error(e instanceof Error ? e.message : '發生錯誤');
    },
    [logout, navigate, toast],
  );

  const reload = useCallback(async () => {
    try {
      const list = await api.listTenants();
      setTenant(list.find((t) => t.id === id) ?? null);
    } catch (e) {
      handleErr(e);
    }
  }, [id, handleErr]);

  // 儲存成功：跳出成功 toast 並重新載入租戶資料
  const handleSaved = useCallback(() => {
    toast.success('已儲存變更');
    void reload();
  }, [toast, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <AppLayout
      crumb="租戶"
      title={tenant?.name ?? '載入中…'}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <IconBack />
          租戶清單
        </button>
      }
    >
      {!tenant ? (
        <div className="card">
          <div className="empty">載入中…</div>
        </div>
      ) : (
        <>
          <div className="tabs">
            {TABS.map((tb) => (
              <button
                key={tb.key}
                className={`tab${tab === tb.key ? ' active' : ''}`}
                onClick={() => setTab(tb.key)}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {tab === 'sso' && <SsoTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'users' && <UsersTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'appearance' && <AppearanceTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'forms' && <FormsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'knowledge' && <KnowledgeTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'permissions' && <PermissionsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'settings' && <SettingsTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'webhook' && <WebhookTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'usage' && <UsageTab tenant={tenant} onError={handleErr} />}
          {tab === 'reports' && <ReportsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'audit' && <AuditTab tenantId={tenant.id} onError={handleErr} />}
        </>
      )}
    </AppLayout>
  );
}
