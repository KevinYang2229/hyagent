import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '@oa-agent/ui';
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

type TabKey =
  | 'appearance'
  | 'forms'
  | 'knowledge'
  | 'permissions'
  | 'settings'
  | 'webhook'
  | 'usage'
  | 'audit';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'settings', label: '設定' },
  { key: 'appearance', label: '外觀' },
  { key: 'permissions', label: '權限' },
  { key: 'forms', label: '表單' },
  { key: 'knowledge', label: '知識庫' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'usage', label: '用量' },
  { key: 'audit', label: '稽核' },
];

export default function TenantDetailPage() {
  const { id = '' } = useParams();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tab, setTab] = useState<TabKey>('settings');

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

          {tab === 'appearance' && <AppearanceTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'forms' && <FormsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'knowledge' && <KnowledgeTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'permissions' && <PermissionsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'settings' && <SettingsTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'webhook' && <WebhookTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'usage' && <UsageTab tenant={tenant} onError={handleErr} />}
          {tab === 'audit' && <AuditTab tenantId={tenant.id} onError={handleErr} />}
        </>
      )}
    </AppLayout>
  );
}
