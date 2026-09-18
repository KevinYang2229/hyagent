import { useCallback, useEffect, useState } from 'react';
import { Checkbox, useToast } from '@hyagent/ui';
import { api, type ScopeDef, type TenantPolicyView } from '../../api';
import BundlesSection from './BundlesSection';
import { formatDepartment, UNKNOWN_DEPARTMENT } from '../../components/department.util';

/**
 * 權限分頁：以「能力」為中心——每個能力一列，直接選 未開通／全租戶／指定對象。
 * 對應資料模型（聯集）：全租戶＝grantedScopes；指定對象＝groups/accounts；未開通＝三處皆無。
 * 切到「全租戶」時清掉該能力的部門/帳號勾選（聯集下已無意義，留著徒增困惑）。
 */

type Mode = 'off' | 'all' | 'some';

/** 從清單加入/移除某 scope（回新陣列） */
function toggle(list: string[], scope: string): string[] {
  return list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope];
}

/** 把某 scope 從 groups/accounts 這類對照表的所有值中移除（回新物件） */
function stripScope(map: Record<string, string[]>, scope: string): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, v.filter((s) => s !== scope)]),
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: 'off', label: '未開通' },
  { value: 'all', label: '全租戶' },
  { value: 'some', label: '指定對象' },
];

/** 摘要最多列出幾個對象名稱，其餘以「等 N 個」帶過 */
const SUMMARY_MAX_NAMES = 3;

function summarizeTargets(names: string[]): string {
  if (names.length <= SUMMARY_MAX_NAMES) return names.join('、');
  return `${names.slice(0, SUMMARY_MAX_NAMES).join('、')} 等 ${names.length} 個`;
}

export default function PermissionsTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [policy, setPolicy] = useState<TenantPolicyView | null>(null);
  const [activeCategory, setActiveCategory] = useState('服務');
  const [formQuery, setFormQuery] = useState('');
  const [formFilter, setFormFilter] = useState('all');
  const [formPage, setFormPage] = useState(1);
  const [saving, setSaving] = useState(false);
  // 使用者明確選了「指定對象」但尚未勾任何人的能力：資料上三處皆無、推導會誤判成「未開通」，
  // 用此集合讓模式停留在指定對象、展開區得以顯示（勾了人之後自然由資料推導）。
  const [someOverride, setSomeOverride] = useState<Set<string>>(new Set());
  // 「指定對象」的勾選區預設收合、只顯示摘要；此集合記錄使用者展開編輯中的能力
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setPolicy(await api.getTenantPolicy(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!policy)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );

  const groups: { label: string; items: ScopeDef[] }[] = [
    { label: '服務', items: policy.capabilities.filter((s) => s.id.startsWith('service:')) },
    { label: '表單', items: policy.capabilities.filter((s) => s.id.startsWith('form:')) },
    {
      label: '外部能力',
      items: policy.capabilities.filter(
        (s) => !s.id.startsWith('service:') && !s.id.startsWith('form:'),
      ),
    },
  ];

  /** 該能力目前的模式：全租戶 > 指定對象（含剛切換、尚未勾人）> 未開通 */
  const modeOf = (id: string): Mode => {
    if (policy.grantedScopes.includes(id)) return 'all';
    const inGroups = Object.values(policy.groups).some((v) => v.includes(id));
    const inAccounts = Object.values(policy.accounts).some((v) => v.includes(id));
    return inGroups || inAccounts || someOverride.has(id) ? 'some' : 'off';
  };

  /**
   * 角色授予對照：scope → 「角色名（被指派對象…）」。
   * 聯集模型下權限區的模式推導只看零散資料，看不到角色授予——不補提示會出現
   * 「顯示未開通、實際卻有權限」與「取消勾選卻關不掉」的認知落差。
   */
  const bundleGrants = (id: string): string[] =>
    policy.bundles
      .filter((b) => b.scopes.includes(id))
      .map((b) => {
        const deps = policy.departments
          .filter((d) => (policy.groupBundles[d] ?? []).includes(b.id))
          .map(formatDepartment);
        const users = policy.users
          .filter((u) => (policy.accountBundles[u.id] ?? []).includes(b.id))
          .map((u) => u.label);
        const targets = [...deps, ...users];
        return targets.length ? `${b.name}（${targets.join('、')}）` : '';
      })
      .filter(Boolean);

  // 「填表申請」是否有任何來源授予（零散或已被指派的角色）；form:* 缺它時為死授權，給軟警告
  const formServiceGranted =
    policy.grantedScopes.includes('service:form') ||
    Object.values(policy.groups).some((v) => v.includes('service:form')) ||
    Object.values(policy.accounts).some((v) => v.includes('service:form')) ||
    policy.bundles.some(
      (b) =>
        b.scopes.includes('service:form') &&
        (Object.values(policy.groupBundles).some((ids) => ids.includes(b.id)) ||
          Object.values(policy.accountBundles).some((ids) => ids.includes(b.id))),
    );

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setMode = (id: string, mode: Mode) => {
    setSomeOverride((prev) => {
      const next = new Set(prev);
      if (mode === 'some') next.add(id);
      else next.delete(id);
      return next;
    });
    // 切到指定對象時直接展開勾選區，離開時收起
    setExpanded((prev) => {
      const next = new Set(prev);
      if (mode === 'some') next.add(id);
      else next.delete(id);
      return next;
    });
    setPolicy((p) => {
      if (!p) return p;
      const granted = p.grantedScopes.filter((s) => s !== id);
      if (mode === 'all') {
        // 全租戶：進 grantedScopes，並清掉部門/帳號的殘留勾選
        return {
          ...p,
          grantedScopes: [...granted, id],
          groups: stripScope(p.groups, id),
          accounts: stripScope(p.accounts, id),
        };
      }
      if (mode === 'off') {
        return { ...p, grantedScopes: granted, groups: stripScope(p.groups, id), accounts: stripScope(p.accounts, id) };
      }
      // some：離開 grantedScopes，保留（或開始）部門/帳號勾選
      return { ...p, grantedScopes: granted };
    });
  };

  const toggleDept = (dep: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, groups: { ...p.groups, [dep]: toggle(p.groups[dep] ?? [], id) } } : p,
    );
  const toggleAccount = (userId: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, accounts: { ...p.accounts, [userId]: toggle(p.accounts[userId] ?? [], id) } } : p,
    );

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const updated = await api.putTenantPolicy(tenantId, {
        grantedScopes: policy.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        bundles: policy.bundles,
        groupBundles: policy.groupBundles,
        accountBundles: policy.accountBundles,
      });
      setPolicy(updated);
      toast.success('已儲存變更');
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const forms = groups.find((group) => group.label === '表單')!.items;
  const hasFormGrant = (id: string) => modeOf(id) !== 'off' || bundleGrants(id).length > 0;
  const filteredForms = forms.filter((form) =>
    `${form.label} ${form.description ?? ''}`.toLocaleLowerCase().includes(formQuery.trim().toLocaleLowerCase()) &&
    (formFilter === 'all' || (formFilter === 'configured' ? hasFormGrant(form.id) : !hasFormGrant(form.id))),
  );
  const formPages = Math.max(1, Math.ceil(filteredForms.length / 10));
  const currentFormPage = Math.min(formPage, formPages);
  const activeGroup = groups.find((group) => group.label === activeCategory)!;
  const visibleScopes = activeCategory === '表單'
    ? filteredForms.slice((currentFormPage - 1) * 10, currentFormPage * 10)
    : activeGroup.items;

  return (
    <div className="settings-stack">
      <BundlesSection
        policy={policy}
        onChange={(updater) => setPolicy((p) => (p ? updater(p) : p))}
      />

    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">權限</div>
          <div className="card-desc">
            先開通服務，再設定可用表單或外部能力。切換分類會保留尚未儲存的設定，完成後統一按「儲存」。
          </div>
        </div>
      </div>

      <div className="permission-category-tabs assignment-tabs" role="group" aria-label="權限分類">
        {groups.map((group) => <button key={group.label} type="button" aria-pressed={activeCategory === group.label}
          onClick={() => setActiveCategory(group.label)}>{group.label}<span className="assignment-count-badge">{group.items.length}</span></button>)}
      </div>
      <div className="card-body" aria-label={`${activeCategory}權限設定`}>
        {activeCategory === '表單' && <>
          <div className="permission-form-guide">
            <div><strong>1. 開通填表申請</strong><span className="permission-step-status">{formServiceGranted ? '已有授權對象' : '尚未開通'}</span>
              <p className="row-sub">{formServiceGranted ? '使用者必須同時取得「填表申請」及個別表單權限，才能使用表單。' : '請先設定哪些人可以使用填表申請，再選擇允許的表單。既有表單設定會保留。'}</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => {
              setActiveCategory('服務');
              requestAnimationFrame(() => document.getElementById('permission-service-form')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
            }}>{formServiceGranted ? '調整服務對象' : '前往開通服務'}</button>
          </div>
          <div className="permission-form-heading"><strong>2. 選擇可用表單</strong><span className="row-sub">已設定 {forms.filter((form) => hasFormGrant(form.id)).length} / {forms.length} 份</span></div>
          <p className="row-sub">每份表單可分別授權。選擇「全租戶」仍需具備填表申請服務權限；角色授權會另列於表單下方。</p>
          <div className="assignment-toolbar permission-form-toolbar">
            <input className="input" aria-label="搜尋表單" placeholder="搜尋表單名稱或說明…" value={formQuery}
              onChange={(event) => { setFormQuery(event.target.value); setFormPage(1); }} />
            <select className="select" aria-label="篩選表單設定" value={formFilter}
              onChange={(event) => { setFormFilter(event.target.value); setFormPage(1); }}>
              <option value="all">全部表單</option><option value="configured">已設定授權</option><option value="unconfigured">尚未設定</option>
            </select>
          </div>
        </>}
        <ul className="list">
            {visibleScopes.map((s) => {
              const mode = modeOf(s.id);
              const pickedDeps = policy.departments.filter((d) =>
                (policy.groups[d] ?? []).includes(s.id),
              );
              const pickedUsers = policy.users.filter((u) =>
                (policy.accounts[u.id] ?? []).includes(s.id),
              );
              const grants = bundleGrants(s.id);
              const targetNames = [...pickedDeps.map(formatDepartment), ...pickedUsers.map((u) => u.label)];
              // 尚未勾任何對象時強制展開，避免摘要只剩警告、找不到勾選處
              const showPicker = mode === 'some' && (expanded.has(s.id) || targetNames.length === 0);
              return (
                <li key={s.id} id={s.id === 'service:form' ? 'permission-service-form' : undefined} className="row" style={{ display: 'block', padding: '10px 0' }}>
                  <div className="perm-row-head">
                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{s.label}</span>
                      {s.description && <div className="row-sub">{s.description}</div>}
                      {s.id === 'service:form' && <div className="perm-summary">
                        <button type="button" className="perm-summary-edit" onClick={() => setActiveCategory('表單')}>選擇可用表單（{forms.filter((form) => hasFormGrant(form.id)).length} / {forms.length}）</button>
                      </div>}
                      {mode === 'all' && <div className="perm-summary">租戶內所有人皆可使用</div>}
                      {mode === 'some' && targetNames.length > 0 && (
                        <div className="perm-summary">
                          指定對象：{summarizeTargets(targetNames)}
                          <button
                            type="button"
                            className="perm-summary-edit"
                            onClick={() => toggleExpanded(s.id)}
                            aria-expanded={showPicker}
                          >
                            {showPicker ? '收合' : '編輯對象'}
                          </button>
                        </div>
                      )}
                      {grants.length > 0 && (
                        <div className="perm-summary">另由角色授予：{grants.join('；')}</div>
                      )}
                      {s.id.startsWith('form:') &&
                        (mode !== 'off' || grants.length > 0) &&
                        !formServiceGranted && (
                          <div className="perm-summary">
                            ⚠️ 「填表申請」服務未開通，此表單的授權實際不可用。
                          </div>
                        )}
                    </div>
                    <div className="mode-seg" role="group" aria-label={`${s.label} 的授權模式`}>
                      {MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          data-mode={m.value}
                          disabled={s.id.startsWith('form:') && !formServiceGranted}
                          aria-pressed={mode === m.value}
                          onClick={() => mode !== m.value && setMode(s.id, m.value)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {showPicker && (
                    <div style={{ marginTop: 10, marginLeft: 2, display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                        <span className="row-sub" style={{ width: 34 }}>部門</span>
                        {policy.departments.map((dep) => (
                          <label key={dep} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <Checkbox
                              checked={(policy.groups[dep] ?? []).includes(s.id)}
                              disabled={s.id.startsWith('form:') && !formServiceGranted}
                              onChange={() => toggleDept(dep, s.id)}
                            />
                            <span
                              style={{ fontSize: 13.5 }}
                              title={dep === UNKNOWN_DEPARTMENT ? '公開 widget 的訪客落在此桶' : undefined}
                            >
                              {formatDepartment(dep)}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                        <span className="row-sub" style={{ width: 34 }}>帳號</span>
                        {policy.users.map((u) => (
                          <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <Checkbox
                              checked={(policy.accounts[u.id] ?? []).includes(s.id)}
                              disabled={s.id.startsWith('form:') && !formServiceGranted}
                              onChange={() => toggleAccount(u.id, s.id)}
                            />
                            <span style={{ fontSize: 13.5 }}>
                              {u.label}
                              <span className="row-sub" style={{ marginLeft: 4 }}>{u.id}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      {pickedDeps.length === 0 && pickedUsers.length === 0 && (
                        <div className="row-sub">⚠️ 尚未選擇任何對象——目前效果等同「未開通」。</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          {visibleScopes.length === 0 && <li className="assignment-empty">{activeCategory === '表單' && forms.length ? '找不到符合條件的表單，請調整搜尋或篩選。' : '目前沒有可設定的項目。'}</li>}
          </ul>
          {activeCategory === '表單' && <nav className="assignment-pagination" aria-label="表單分頁">
            <span className="row-sub" aria-live="polite">共 {filteredForms.length} 份 · 第 {currentFormPage} / {formPages} 頁 · 每頁 10 份</span>
            <div><button type="button" className="btn btn-sm" disabled={currentFormPage === 1} onClick={() => setFormPage(currentFormPage - 1)}>上一頁</button>
              <button type="button" className="btn btn-sm" disabled={currentFormPage === formPages} onClick={() => setFormPage(currentFormPage + 1)}>下一頁</button></div>
          </nav>}
        </div>

      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          儲存
        </button>
      </div>
    </div>
    </div>
  );
}
