import { useState } from 'react';
import { Checkbox } from '@hyagent/ui';
import type { ScopeDef, SkillBundle, TenantPolicyView } from '../../api';
import { formatDepartment, UNKNOWN_DEPARTMENT } from '../../components/department.util';

/** 對象採分頁，角色只在編輯時展開，避免雙向增長的矩陣。 */
export function AssignmentSection({ policy, onToggle }: {
  policy: TenantPolicyView;
  onToggle: (kind: 'groupBundles' | 'accountBundles', key: string, id: string) => void;
}) {
  const [kind, setKind] = useState<'groupBundles' | 'accountBundles'>('groupBundles');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [roleQuery, setRoleQuery] = useState('');
  const departmentIds = [...new Set([...policy.departments, ...Object.keys(policy.groupBundles)])];
  const userIds = [...new Set([...policy.users.map((user) => user.id), ...Object.keys(policy.accountBundles)])];
  const targets = kind === 'groupBundles'
    ? departmentIds.map((id) => ({ id, label: formatDepartment(id), sub: id === UNKNOWN_DEPARTMENT ? '公開聊天視窗的訪客與未建檔帳號' : '' }))
    : userIds.map((id) => ({ id, label: policy.users.find((user) => user.id === id)?.label ?? id,
      sub: policy.users.some((user) => user.id === id) ? id : `${id} · 未列於目前名錄` }));
  const selectedRoles = (id: string) => policy.bundles.filter((role) => (policy[kind][id] ?? []).includes(role.id));
  const filtered = targets.filter((target) => {
    const count = selectedRoles(target.id).length;
    return `${target.label} ${target.sub}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (filter === 'all' || (filter === 'assigned' ? count > 0 : count === 0));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  const roles = policy.bundles.filter((role) => role.name.toLocaleLowerCase().includes(roleQuery.trim().toLocaleLowerCase()));
  const switchKind = (next: typeof kind) => {
    setKind(next); setQuery(''); setFilter('all'); setPage(1); setEditing(null); setRoleQuery('');
  };
  return <section className="assignment-section" aria-label="角色指派">
    <div><h3 className="assignment-title">指派對象</h3>
      <p className="row-sub">選擇部門或帳號，再編輯角色。變更須按本頁「儲存」才會生效。</p>
    </div>
    <div className="assignment-tabs" role="group" aria-label="指派對象類型">
      <button type="button" aria-pressed={kind === 'groupBundles'} onClick={() => switchKind('groupBundles')}>部門 <span className="assignment-count-badge">{departmentIds.length}</span></button>
      <button type="button" aria-pressed={kind === 'accountBundles'} onClick={() => switchKind('accountBundles')}>帳號 <span className="assignment-count-badge">{userIds.length}</span></button>
    </div>
    <p className="row-sub">{kind === 'groupBundles' ? '部門指派會套用至該部門成員；訪客／未建檔帳號獨立列出。' : '此處僅顯示直接指派給帳號的角色，不含從部門繼承的角色；未直接指派不代表沒有權限。'}</p>
    <div className="assignment-toolbar">
      <input className="input" aria-label="搜尋指派對象" placeholder={kind === 'groupBundles' ? '搜尋部門名稱…' : '搜尋姓名或帳號…'} value={query}
        onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
      <select className="select" aria-label="篩選指派狀態" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}>
        <option value="all">全部指派狀態</option><option value="assigned">已直接指派</option><option value="unassigned">未直接指派</option>
      </select>
    </div>
    <ul className="list assignment-list" aria-label={kind === 'groupBundles' ? '部門指派清單' : '帳號指派清單'}>
      {visible.map((target) => {
        const assigned = selectedRoles(target.id);
        return <li key={target.id} className="assignment-item">
          <div className="assignment-item-main">
            <div className="assignment-identity"><div className="row-title">{target.label}</div>{target.sub && <div className="row-sub">{target.sub}</div>}</div>
            <div className="assignment-summary">
              <div className="row-sub">直接指派 · {assigned.length} 個角色</div>
              {assigned.length ? <div className="assignment-chips">{assigned.slice(0, 3).map((role) => <span key={role.id}>{role.name}</span>)}</div> : <div className="row-sub">未直接指派</div>}
              {assigned.length > 3 && <details className="assignment-more"><summary>另有 {assigned.length - 3} 個角色</summary><div className="assignment-chips">{assigned.slice(3).map((role) => <span key={role.id}>{role.name}</span>)}</div></details>}
            </div>
            <button type="button" className="btn btn-sm" aria-label={`編輯 ${target.label} 的角色`} aria-expanded={editing === target.id}
              onClick={() => { setEditing(editing === target.id ? null : target.id); setRoleQuery(''); }}>{editing === target.id ? '收合' : '編輯角色'}</button>
          </div>
          {editing === target.id && <div className="assignment-editor">
            <div className="row-title">{target.label} · 選擇角色</div>
            <input className="input" aria-label="搜尋角色" placeholder="搜尋角色名稱…" value={roleQuery} onChange={(event) => setRoleQuery(event.target.value)} />
            <div className="assignment-role-options" role="group" aria-label={`${target.label} 的角色選項`}>
              {roles.map((role) => <label key={role.id}><Checkbox checked={(policy[kind][target.id] ?? []).includes(role.id)} onChange={() => onToggle(kind, target.id, role.id)} /><span>{role.name}</span></label>)}
              {!roles.length && <div className="row-sub">找不到符合的角色。</div>}
            </div>
            <div className="row-sub">已選 {assigned.length} 個角色。搜尋及切換頁面不會清除選擇；請按本頁「儲存」套用。</div>
            <div><button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>完成選擇</button></div>
          </div>}
        </li>;
      })}
      {!visible.length && <li className="assignment-empty">{targets.length ? '找不到符合條件的對象，請調整搜尋或篩選。' : '尚無可指派的對象。'}</li>}
    </ul>
    <nav className="assignment-pagination" aria-label="指派清單分頁">
      <span className="row-sub" aria-live="polite">共 {filtered.length} 筆 · 第 {currentPage} / {pages} 頁 · 每頁 10 筆</span>
      <div><button type="button" className="btn btn-sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一頁</button>
        <button type="button" className="btn btn-sm" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一頁</button></div>
    </nav>
    <p className="row-sub">角色名稱不會額外開放團隊資料或簽核權限；移除角色也不會撤銷其他來源的授權。</p>
  </section>;
}

/**
 * 角色能力區（權限分頁上半部）：定義角色（名稱＋勾選能力）並指派給部門/帳號。
 * 狀態由 PermissionsTab 持有（與零散 scope 同一顆「儲存」鈕送出），此元件只負責編輯。
 */
export default function BundlesSection({
  policy,
  onChange,
}: {
  policy: TenantPolicyView;
  onChange: (updater: (p: TenantPolicyView) => TenantPolicyView) => void;
}) {
  // 編輯中的角色（null = 沒在編輯；id 為空字串 = 新增）
  const [draft, setDraft] = useState<SkillBundle | null>(null);

  const scopeGroups: { label: string; items: ScopeDef[] }[] = [
    { label: '服務', items: policy.capabilities.filter((s) => s.id.startsWith('service:')) },
    { label: '表單', items: policy.capabilities.filter((s) => s.id.startsWith('form:')) },
    {
      label: '外部能力',
      items: policy.capabilities.filter(
        (s) => !s.id.startsWith('service:') && !s.id.startsWith('form:'),
      ),
    },
  ].filter((g) => g.items.length > 0);

  const startNew = () =>
    setDraft({ id: `b-${Math.random().toString(16).slice(2, 8)}`, name: '', scopes: [] });

  const saveDraft = () => {
    if (!draft || !draft.name.trim()) return;
    const cleaned: SkillBundle = { ...draft, name: draft.name.trim() };
    onChange((p) => {
      const exists = p.bundles.some((b) => b.id === cleaned.id);
      return {
        ...p,
        bundles: exists
          ? p.bundles.map((b) => (b.id === cleaned.id ? cleaned : b))
          : [...p.bundles, cleaned],
      };
    });
    setDraft(null);
  };

  const removeBundle = (id: string) =>
    onChange((p) => ({
      ...p,
      bundles: p.bundles.filter((b) => b.id !== id),
      // 一併移除所有指派，避免引用不存在的角色被後端擋下
      groupBundles: Object.fromEntries(
        Object.entries(p.groupBundles).map(([k, v]) => [k, v.filter((x) => x !== id)]),
      ),
      accountBundles: Object.fromEntries(
        Object.entries(p.accountBundles).map(([k, v]) => [k, v.filter((x) => x !== id)]),
      ),
    }));

  const toggleAssign = (kind: 'groupBundles' | 'accountBundles', key: string, id: string) =>
    onChange((p) => {
      const cur = p[kind][key] ?? [];
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return { ...p, [kind]: { ...p[kind], [key]: next } };
    });

  const scopeLabel = (id: string) => policy.capabilities.find((c) => c.id === id)?.label ?? id;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">角色能力</div>
          <div className="card-desc">
            以具名角色組合可用 Skill，指派給部門或帳號。儲存權限後生效；與其他授權取聯集，移除角色不會撤銷其他來源的權限。
          </div>
        </div>
        <div className="toolbar">
          <button className="btn btn-ghost btn-sm" onClick={startNew} disabled={draft !== null}>
            ＋ 新增角色
          </button>
        </div>
      </div>

      {!draft && <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {[
          { name: '一般員工', description: '協助申請與查詢規定；請另選允許的表單與知識標籤。', scopes: ['service:form', 'service:knowledge'] },
          { name: '報告分析員', description: '查詢知識並產生報告；文件可見範圍仍依既有 ACL。', scopes: ['service:knowledge', 'service:report'] },
        ].map((template) => <button key={template.name} className="btn btn-ghost btn-sm" type="button"
          onClick={() => setDraft({ ...template, id: `b-${crypto.randomUUID()}`, scopes: template.scopes.filter((id) => policy.capabilities.some((c) => c.id === id)) })}>
          使用「{template.name}」範本
        </button>)}
      </div>}
      {policy.bundles.length === 0 && !draft && (
        <div className="empty">尚未定義角色，可使用範本開始設定。</div>
      )}

      {policy.bundles.length > 0 && (
        <ul className="list">
          {policy.bundles.map((b) => (
            <li key={b.id} className="row">
              <div className="row-main">
                <div className="row-title">
                  {b.name} <code style={{ fontSize: 12, opacity: 0.6 }}>{b.id}</code>
                </div>
                <div className="row-sub">
                  {b.scopes.length === 0 ? '（尚未設定能力）' : b.scopes.map(scopeLabel).join('、')}
                </div>
              </div>
              <div className="toolbar" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setDraft({ ...b, scopes: [...b.scopes] })}>
                  編輯
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => removeBundle(b.id)}>
                  刪除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <div className="card-body" style={{ borderTop: '1px solid var(--border-color)', display: 'grid', gap: 10 }}>
          <div className="field">
            <label className="field-label">角色名稱</label>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="例：一般員工、報告分析員"
            />
          </div>
          <div className="field">
            <label className="field-label">描述（選填）</label>
            <input
              className="input"
              value={draft.description ?? ''}
              onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
            />
          </div>
          {scopeGroups.map((g) => {
            // 表單掛在「填表申請」skill 底下：service:form 沒勾時 form:* 是死授權，鎖住避免誤設
            const isFormGroup = g.label === '表單';
            const hasFormService = draft.scopes.includes('service:form');
            const groupDisabled = isFormGroup && !hasFormService;
            return (
              <div key={g.label}>
                <div className="row-sub" style={{ marginBottom: 4 }}>
                  {g.label}
                  {groupDisabled && (
                    <span style={{ marginLeft: 6 }}>（需先勾選「填表申請」服務）</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, opacity: groupDisabled ? 0.45 : 1 }}>
                  {g.items.map((s) => (
                    <label
                      key={s.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: groupDisabled ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Checkbox
                        checked={draft.scopes.includes(s.id)}
                        disabled={groupDisabled}
                        onChange={() =>
                          setDraft((d) => {
                            if (!d) return d;
                            const checked = d.scopes.includes(s.id);
                            let scopes = checked
                              ? d.scopes.filter((x) => x !== s.id)
                              : [...d.scopes, s.id];
                            // 取消「填表申請」時連動清掉已勾的表單（不留死授權）
                            if (s.id === 'service:form' && checked) {
                              scopes = scopes.filter((x) => !x.startsWith('form:'));
                            }
                            return { ...d, scopes };
                          })
                        }
                      />
                      <span style={{ fontSize: 13.5 }}>{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={saveDraft} disabled={!draft.name.trim()}>
              完成
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {policy.bundles.length > 0 && <AssignmentSection policy={policy} onToggle={toggleAssign} />}
    </div>
  );
}
