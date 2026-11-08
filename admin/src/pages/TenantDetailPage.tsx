import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Dialog, useToast } from '@hyagent/ui';
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
import FeedbackTab from './tabs/FeedbackTab';
import ReportsTab from './tabs/ReportsTab';
import UsersTab from './tabs/UsersTab';
import SsoTab from './tabs/SsoTab';
import DirectorySyncTab from './tabs/DirectorySyncTab';
import DatabaseTab from './tabs/database/DatabaseTab';
import OverviewTab from './tabs/OverviewTab';

type TabKey =
  | 'overview'
  | 'sso'
  | 'users'
  | 'directorySync'
  | 'appearance'
  | 'forms'
  | 'knowledge'
  | 'database'
  | 'permissions'
  | 'settings'
  | 'webhook'
  | 'usage'
  | 'reports'
  | 'feedback'
  | 'audit';

/**
 * 依導入流程分組：接入 → 人員與登入 → 內容與能力 → 權限（把內容開給人）→ 前台呈現 → 營運。
 * 權限排在內容之後：要先有表單、知識庫標籤、外部服務，才有東西可以授權。
 * 網址的 tab key 不變，既有連結與書籤仍有效。
 */
const TAB_GROUPS: { label: string | null; tabs: { key: TabKey; label: string }[] }[] = [
  { label: null, tabs: [{ key: 'overview', label: '總覽' }] },
  { label: '接入', tabs: [{ key: 'settings', label: '基本設定' }] },
  { label: '人員與登入', tabs: [
    { key: 'sso', label: '自動登入（SSO）' },
    { key: 'users', label: '使用者目錄' },
    { key: 'directorySync', label: '人員同步' },
  ] },
  { label: '內容與能力', tabs: [
    { key: 'knowledge', label: '知識庫' },
    { key: 'forms', label: '表單' },
    { key: 'database', label: '資料庫查詢' },
  ] },
  { label: '權限', tabs: [{ key: 'permissions', label: '權限' }] },
  { label: '前台呈現', tabs: [
    { key: 'appearance', label: '外觀' },
    { key: 'webhook', label: 'Webhook' },
  ] },
  { label: '營運', tabs: [
    { key: 'usage', label: '用量' },
    { key: 'feedback', label: '回饋' },
    { key: 'reports', label: '報告' },
    { key: 'audit', label: '稽核' },
  ] },
];
const TABS = TAB_GROUPS.flatMap((g) => g.tabs);

export default function TenantDetailPage() {
  const { id = '' } = useParams();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  // 分頁狀態同步到網址（?tab=...）：重整/分享連結停留在原分頁，不再重置回第一頁
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : 'overview';
  // 權限分頁有未儲存變更時，離開前先確認（其他分頁各自即時儲存，不需要）
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const guardLeave = (action: () => void) => {
    if (permissionsDirty) setPendingLeave(() => action);
    else action();
  };
  const setTab = (next: TabKey) => {
    if (next === tab) return;
    guardLeave(() => setSearchParams({ tab: next }, { replace: true }));
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
        <button className="btn btn-ghost btn-sm" onClick={() => guardLeave(() => navigate('/'))}>
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
          <div className="tenant-shell">
            <nav className="tenant-nav" aria-label="租戶設定導覽">
              {TAB_GROUPS.map((group) => (
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
                      {tb.label}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            {/* 窄螢幕：側邊導覽收成下拉選單，分組以 optgroup 呈現 */}
            <label className="tenant-nav-select field">
              <span className="field-label">目前頁面</span>
              <select className="select" aria-label="切換租戶設定頁面" value={tab} onChange={(e) => setTab(e.target.value as TabKey)}>
                {TAB_GROUPS.map((group) => group.label
                  ? <optgroup key={group.label} label={group.label}>{group.tabs.map((tb) => <option key={tb.key} value={tb.key}>{tb.label}</option>)}</optgroup>
                  : group.tabs.map((tb) => <option key={tb.key} value={tb.key}>{tb.label}</option>))}
              </select>
            </label>
            <div className="tenant-content">

          {tab === 'overview' && <OverviewTab key={tenant.id} tenant={tenant} onNavigate={(next) => setTab(next as TabKey)} />}
          {tab === 'sso' && <SsoTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'users' && <UsersTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'directorySync' && <DirectorySyncTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'appearance' && <AppearanceTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'forms' && <FormsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'knowledge' && <KnowledgeTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'database' && <DatabaseTab key={tenant.id} tenantId={tenant.id} onError={handleErr} />}
          {tab === 'permissions' && (
            <PermissionsTab
              tenantId={tenant.id}
              onError={handleErr}
              onDirtyChange={setPermissionsDirty}
            />
          )}
          {tab === 'settings' && <SettingsTab tenant={tenant} onSaved={handleSaved} onError={handleErr} />}
          {tab === 'webhook' && <WebhookTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'usage' && <UsageTab tenant={tenant} onError={handleErr} />}
          {tab === 'reports' && <ReportsTab tenantId={tenant.id} onError={handleErr} />}
          {tab === 'feedback' && (
            <FeedbackTab
              tenantId={tenant.id}
              onError={handleErr}
              onTestRetrieval={(question, asUserId) => setSearchParams({ tab: 'knowledge', q: question, as: asUserId }, { replace: true })}
            />
          )}
          {tab === 'audit' && <AuditTab tenantId={tenant.id} onError={handleErr} />}
            </div>
          </div>

          <Dialog
            isOpen={!!pendingLeave}
            title="放棄未儲存的權限變更？"
            confirmText="放棄並離開"
            cancelText="留在此頁"
            confirmVariant="danger"
            onClose={() => setPendingLeave(null)}
            onConfirm={() => {
              const leave = pendingLeave;
              setPendingLeave(null);
              setPermissionsDirty(false);
              leave?.();
            }}
          >
            權限頁有尚未儲存的變更，離開後這些變更會遺失。
          </Dialog>
        </>
      )}
    </AppLayout>
  );
}
