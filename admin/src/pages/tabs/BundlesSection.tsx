import { useState, type CSSProperties } from 'react';
import { Checkbox } from '@oa-agent/ui';
import type { ScopeDef, SkillBundle, TenantPolicyView } from '../../api';

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};
const tdStyle: CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
  verticalAlign: 'middle',
};

/** 指派矩陣的一列：對象名稱 + 各套餐勾選 + 已指派摘要 */
function AssignRow({
  label,
  sub,
  assigned,
  bundles,
  onToggle,
}: {
  label: string;
  sub?: string;
  assigned: string[];
  bundles: SkillBundle[];
  onToggle: (bundleId: string) => void;
}) {
  const names = bundles.filter((b) => assigned.includes(b.id)).map((b) => b.name);
  return (
    <tr>
      <td style={tdStyle}>
        {label}
        {sub && <span className="row-sub" style={{ marginLeft: 6 }}>{sub}</span>}
      </td>
      {bundles.map((b) => (
        <td key={b.id} style={{ ...tdStyle, textAlign: 'center' }}>
          <Checkbox checked={assigned.includes(b.id)} onChange={() => onToggle(b.id)} />
        </td>
      ))}
      <td style={{ ...tdStyle, opacity: names.length ? 1 : 0.45 }}>
        {names.length ? names.join('、') : '未指派'}
      </td>
    </tr>
  );
}

/**
 * 能力套餐區（權限分頁上半部）：定義套餐（名稱＋勾選能力）並指派給部門/帳號。
 * 狀態由 PermissionsTab 持有（與零散 scope 同一顆「儲存」鈕送出），此元件只負責編輯。
 */
export default function BundlesSection({
  policy,
  onChange,
}: {
  policy: TenantPolicyView;
  onChange: (updater: (p: TenantPolicyView) => TenantPolicyView) => void;
}) {
  // 編輯中的套餐（null = 沒在編輯；id 為空字串 = 新增）
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
      // 一併移除所有指派，避免引用不存在的套餐被後端擋下
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
          <div className="card-title">能力套餐</div>
          <div className="card-desc">
            把多個能力打包成具名套餐，指派給部門或帳號；改套餐內容一次，所有被指派對象即時生效。與下方零散授權為聯集。
          </div>
        </div>
        <div className="toolbar">
          <button className="btn btn-ghost btn-sm" onClick={startNew} disabled={draft !== null}>
            ＋ 新增套餐
          </button>
        </div>
      </div>

      {policy.bundles.length === 0 && !draft && (
        <div className="empty">尚未定義套餐。</div>
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
                  {b.scopes.length === 0 ? '（空套餐）' : b.scopes.map(scopeLabel).join('、')}
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
            <label className="field-label">套餐名稱</label>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="例：業務基本套餐"
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
          {scopeGroups.map((g) => (
            <div key={g.label}>
              <div className="row-sub" style={{ marginBottom: 4 }}>{g.label}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {g.items.map((s) => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <Checkbox
                      checked={draft.scopes.includes(s.id)}
                      onChange={() =>
                        setDraft((d) =>
                          d
                            ? {
                                ...d,
                                scopes: d.scopes.includes(s.id)
                                  ? d.scopes.filter((x) => x !== s.id)
                                  : [...d.scopes, s.id],
                              }
                            : d,
                        )
                      }
                    />
                    <span style={{ fontSize: 13.5 }}>{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
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

      {policy.bundles.length > 0 && (
        <div className="card-body" style={{ borderTop: '1px solid var(--border-color)', display: 'grid', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 500 }}>指派</div>
            <div className="row-sub">列＝對象、欄＝套餐；勾選即指派，與下方零散授權為聯集。</div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th style={thStyle}>對象</th>
                  {policy.bundles.map((b) => (
                    <th key={b.id} style={{ ...thStyle, textAlign: 'center' }} title={b.scopes.map(scopeLabel).join('、')}>
                      {b.name}
                    </th>
                  ))}
                  <th style={thStyle}>已指派</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={policy.bundles.length + 2} style={{ ...tdStyle, fontWeight: 500, background: 'var(--badge-bg, transparent)' }}>
                    部門
                  </td>
                </tr>
                {policy.departments.map((dep) => (
                  <AssignRow
                    key={`g-${dep}`}
                    label={dep}
                    assigned={policy.groupBundles[dep] ?? []}
                    bundles={policy.bundles}
                    onToggle={(id) => toggleAssign('groupBundles', dep, id)}
                  />
                ))}
                <tr>
                  <td colSpan={policy.bundles.length + 2} style={{ ...tdStyle, fontWeight: 500, background: 'var(--badge-bg, transparent)' }}>
                    帳號
                  </td>
                </tr>
                {policy.users.map((u) => (
                  <AssignRow
                    key={`a-${u.id}`}
                    label={u.label}
                    sub={u.id}
                    assigned={policy.accountBundles[u.id] ?? []}
                    bundles={policy.bundles}
                    onToggle={(id) => toggleAssign('accountBundles', u.id, id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
