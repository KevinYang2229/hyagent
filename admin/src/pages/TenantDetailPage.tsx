import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '@hyagent/ui';
import type { AdminTabKey } from '@hyagent/shared';
import { api, UnauthorizedError, type Tenant } from '../api';
import { useAuth } from '../auth';
import AppLayout from '../components/AppLayout';
import { IconBack } from '../components/icons';
import { TAB_GROUPS, type TabKey } from './tabGroups';
import AppearanceTab from './tabs/AppearanceTab';
import SettingsTab from './tabs/SettingsTab';
import WebhookTab from './tabs/WebhookTab';
import UsageTab from './tabs/UsageTab';
import FormsTab from './tabs/FormsTab';
import KnowledgeTab from './tabs/KnowledgeTab';
import PermissionsTab from './tabs/PermissionsTab';
import AuditTab from './tabs/AuditTab';
import FeedbackTab from './tabs/FeedbackTab';
import ReportsTab from './tabs/ReportsTab';
import UsersTab from './tabs/UsersTab';
import SsoTab from './tabs/SsoTab';
import DirectorySyncTab from './tabs/DirectorySyncTab';
import DatabaseTab from './tabs/database/DatabaseTab';
import OverviewTab from './tabs/OverviewTab';
import AdminAccountsTab from './tabs/AdminAccountsTab';

const TABS = TAB_GROUPS.flatMap((g) => g.tabs);

export default function TenantDetailPage() {
  const { id = '' } = useParams();
  const { logout, isSuper, level } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  // 分頁狀態同步到網址（?tab=...）：重整/分享連結停留在原分頁，不再重置回第一頁
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  // 分頁可見規則：總覽一律；資料庫查詢只有超級管理者；其餘依分頁權限。網址指到看不到的分頁時退回總覽
  const isVisible = useCallback(
    (key: TabKey) => key === 'overview' || ((key === 'database' || key === 'adminAccounts') ? isSuper : level(key as AdminTabKey) !== 'hidden'),
    [isSuper, level],
  );
  const visibleGroups = useMemo(
    () => TAB_GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter((tb) => isVisible(tb.key)) })).filter((g) => g.tabs.length > 0),
    [isVisible],
  );
  const tab: TabKey = TABS.some((t) => t.key === rawTab && isVisible(t.key)) ? (rawTab as TabKey) : 'overview';
  // 唯讀分頁：不再整頁包 <fieldset disabled>（會連帶停用下載、搜尋、篩選、分頁）；
  // 改把 readonly 傳給各分頁，由分頁只停用或隱藏會寫入的控制項
  const tabIsReadonly = tab !== 'overview' && tab !== 'database' && tab !== 'adminAccounts' && level(tab as AdminTabKey) === 'read';
  const ro = tabIsReadonly;

  const setTab = (next: TabKey, query: Record<string, string> = {}) => {
    if (next === tab && Object.keys(query).length === 0) return;
    // 有未儲存的變更時，由最外層的 UnsavedGuard 攔下並確認
    setSearchParams({ tab: next, ...query }, { replace: true });
  };

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
      setTenant(await api.getTenant(id));
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

  const tabContent = tenant && (
    <>
          {tab === 'overview' && <OverviewTab key={tenant.id} tenant={tenant} level={level} onNavigate={(next, query) => setTab(next as TabKey, query)} />}
          {tab === 'sso' && <SsoTab key={tenant.id} tenantId={tenant.id} onError={handleErr} readonly={ro} />}
          {tab === 'users' && <UsersTab key={tenant.id} tenantId={tenant.id} onError={handleErr} readonly={ro} />}
          {tab === 'directorySync' && <DirectorySyncTab key={tenant.id} tenantId={tenant.id} onError={handleErr} readonly={ro} />}
          {tab === 'appearance' && <AppearanceTab tenant={tenant} onSaved={handleSaved} onError={handleErr} readonly={ro} />}
          {tab === 'forms' && <FormsTab tenantId={tenant.id} onError={handleErr} readonly={ro} />}
          {tab === 'knowledge' && <KnowledgeTab tenantId={tenant.id} onError={handleErr} readonly={ro} allowRenderJavaScript={isSuper} />}
          {tab === 'database' && <DatabaseTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'permissions' && (
            <PermissionsTab tenantId={tenant.id} onError={handleErr} readonly={ro} />
          )}
          {tab === 'adminAccounts' && <AdminAccountsTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'settings' && <SettingsTab tenant={tenant} onSaved={handleSaved} onError={handleErr} readonly={ro} />}
          {tab === 'ai' && <SettingsTab tenant={tenant} onSaved={handleSaved} onError={handleErr} section="ai" readonly={ro} />}
          {tab === 'webhook' && <WebhookTab tenantId={tenant.id} onError={handleErr} readonly={ro} />}
          {tab === 'usage' && <UsageTab tenant={tenant} onError={handleErr} />}
          {tab === 'reports' && <ReportsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'feedback' && (
            <FeedbackTab
              tenantId={tenant.id}
              onError={handleErr}
              onTestRetrieval={(question, asUserId) => setSearchParams({ tab: 'knowledge', q: question, as: asUserId }, { replace: true })}
              readonly={ro}
            />
          )}
          {tab === 'audit' && <AuditTab tenantId={tenant.id} onError={handleErr} />}
    </>
  );

  return (
    <AppLayout
      crumb="租戶"
      title={tenant?.name ?? '載入中…'}
      actions={isSuper ? (
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <IconBack />
          租戶清單
        </button>
      ) : undefined}
    >
      {!tenant ? (
        <div className="card">
          <div className="empty">載入中…</div>
        </div>
      ) : (
        <>
          <div className="tenant-shell">
            <nav className="tenant-nav" aria-label="租戶設定導覽">
              {visibleGroups.map((group) => (
                <div key={group.label ?? 'top'} className="tenant-nav-group">
                  {group.label && <div className="tenant-nav-label">{group.label}</div>}
                  {group.tabs.map((tb) => (
                    <button
                      key={tb.key}
                      type="button"
                      className={`tenant-nav-item${tab === tb.key ? ' active' : ''}`}
                      aria-current={tab === tb.key ? 'page' : undefined}
                      onClick={() => setTab(tb.key)}
                    >
                      <tb.icon className="tenant-nav-ico" aria-hidden="true" />
                      <span>{tb.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            {/* 窄螢幕：側邊導覽收成下拉選單，分組以 optgroup 呈現 */}
            <label className="tenant-nav-select field">
              <span className="field-label">目前頁面</span>
              <select className="select" aria-label="切換租戶設定頁面" value={tab} onChange={(e) => setTab(e.target.value as TabKey)}>
                {visibleGroups.map((group) => group.label
                  ? <optgroup key={group.label} label={group.label}>{group.tabs.map((tb) => <option key={tb.key} value={tb.key}>{tb.label}</option>)}</optgroup>
                  : group.tabs.map((tb) => <option key={tb.key} value={tb.key}>{tb.label}</option>))}
              </select>
            </label>
            <div className="tenant-content">

          {tabIsReadonly && <div className="card tab-readonly-hint"><div className="card-body">此分頁為唯讀，如需修改請聯絡平台管理者</div></div>}
          {tabContent}
            </div>
          </div>

        </>
      )}
    </AppLayout>
  );
}
