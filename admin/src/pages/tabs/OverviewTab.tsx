import { useCallback, useEffect, useState } from 'react';
import { api, type Tenant } from '../../api';
import CollapsibleList from '../../components/CollapsibleList';
import { setupChecks, setupProgress, type CheckStatus, type OverviewData, type SetupCheck } from './overview.util';

const STATUS_LABEL: Record<CheckStatus, string> = { ok: '完成', todo: '待設定', warn: '需注意', unknown: '無法檢查' };
const STEPS: SetupCheck['step'][] = ['接入', '人員與登入', '內容與能力', '權限'];

/** 值或 undefined：個別資料失敗不拖垮整頁，該項顯示「無法檢查」 */
async function settle<T>(p: Promise<T>): Promise<T | undefined> {
  try { return await p; } catch { return undefined; }
}

/**
 * 租戶總覽：依導入流程列出設定進度，每項都能直接前往處理。
 * 上線後也用來快速看「現在有什麼需要處理」（未標記檔案、未指定部門、未套用角色…）。
 */
export default function OverviewTab({ tenant, onNavigate }: {
  tenant: Tenant;
  onNavigate: (tab: string) => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const [users, sync, policy, knowledge, acl, forms] = await Promise.all([
      settle(api.listDirectoryUsers(tenant.id).then((r) => r.users)),
      settle(api.getDirectorySync(tenant.id)),
      settle(api.getTenantPolicy(tenant.id)),
      settle(api.getKnowledge(tenant.id).then((r) => r.meta)),
      settle(api.getKnowledgeAclReport(tenant.id)),
      settle(api.listForms(tenant.id)),
    ]);
    setData({ tenant, users, sync, policy, knowledge, acl, forms });
  }, [tenant]);

  useEffect(() => { void load(); }, [load]);

  if (!data) return <div className="card"><div className="card-body">檢查中…</div></div>;

  const checks = setupChecks(data);
  const { done, total } = setupProgress(checks);
  const todos = checks.filter((c) => c.status !== 'ok');

  return <div className="settings-stack">
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">設定進度</div>
          <div className="card-desc">依導入順序：接入 → 人員與登入 → 內容與能力 → 權限。點「前往」直接處理。</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>重新檢查</button>
      </div>
      <div className="card-body">
        <div className="overview-progress" aria-label="必要步驟完成度">
          <div className="overview-progress-bar"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
          <span className="perm-text">必要步驟 {done} / {total} 完成{done === total ? '，可以上線。' : '。'}</span>
        </div>
        {todos.length > 0 && (
          <div className="perm-text" style={{ marginTop: 8 }}>
            待處理：<CollapsibleList items={todos} max={4} render={(c) => c.title} />
          </div>
        )}
      </div>
    </div>

    {STEPS.map((step) => {
      const items = checks.filter((c) => c.step === step);
      if (!items.length) return null;
      return <section key={step} className="card" aria-label={step}>
        <div className="card-head"><div className="card-title">{step}</div></div>
        <ul className="list">
          {items.map((c) => <li key={c.id} className="row overview-check">
            <span className={`overview-status overview-status--${c.status}`}>{STATUS_LABEL[c.status]}</span>
            <div className="row-main">
              <div className="row-title">{c.title}{!c.required && <span className="row-sub" style={{ marginLeft: 6 }}>提醒</span>}</div>
              <div className="row-sub">{c.detail}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate(c.tab)}>{c.status === 'ok' ? '查看' : '前往'}</button>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}
