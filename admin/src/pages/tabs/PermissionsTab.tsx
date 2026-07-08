import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Checkbox, useToast } from '@oa-agent/ui';
import { api, type ScopeDef, type TenantPolicyView } from '../../api';

/** 切換某 scope 是否在清單內（回新陣列）。 */
function toggle(list: string[], scope: string): string[] {
  return list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope];
}

// admin 尚無 `.table` CSS class，這裡以 inline style 給表格最小邊框/間距，不影響功能。
const thStyle: CSSProperties = {
  textAlign: 'center',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};
const tdStyle: CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
};

export default function PermissionsTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [scopes, setScopes] = useState<ScopeDef[] | null>(null);
  const [policy, setPolicy] = useState<TenantPolicyView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cat, pol] = await Promise.all([api.listScopes(), api.getTenantPolicy(tenantId)]);
      setScopes(cat);
      setPolicy(pol);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!scopes || !policy)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );

  const baseScopes = scopes.filter((s) => s.base);
  const grantable = scopes.filter((s) => !s.base);

  const toggleTenant = (id: string) =>
    setPolicy((p) => (p ? { ...p, grantedScopes: toggle(p.grantedScopes, id) } : p));
  const toggleGroup = (dep: string, id: string) =>
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
      });
      setPolicy(updated);
      toast.success('已儲存變更');
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const cell = (checked: boolean, onChange: () => void) => (
    <td style={{ ...tdStyle, textAlign: 'center' }}>
      <Checkbox checked={checked} onChange={onChange} />
    </td>
  );

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">權限</div>
          <div className="card-desc">
            設定此租戶開通的能力，以及各部門 / 帳號可用的能力。基礎能力為全員預設、不可調整。
          </div>
        </div>
      </div>

      {/* ① 全員預設（唯讀） */}
      <div className="card-body">
        <div style={{ fontWeight: 500, marginBottom: 8 }}>全員預設（不可調整）</div>
        <ul className="list">
          {baseScopes.map((s) => (
            <li key={s.id} className="row" style={{ opacity: 0.6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox checked disabled onChange={() => {}} />
                <span>{s.label}</span>
                <span className="row-sub" style={{ marginLeft: 4 }}>
                  {s.id}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* ② 此租戶開通的能力 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>此租戶開通的能力</div>
        <ul className="list">
          {grantable.map((s) => (
            <li key={s.id} className="row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <Checkbox
                  checked={policy.grantedScopes.includes(s.id)}
                  onChange={() => toggleTenant(s.id)}
                />
                <span>{s.label}</span>
                <span className="row-sub" style={{ marginLeft: 4 }}>
                  {s.id}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* ③ 部門授權 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>部門授權</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>部門</th>
                {grantable.map((s) => (
                  <th key={s.id} style={thStyle}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.departments.map((dep) => (
                <tr key={dep}>
                  <td style={tdStyle}>{dep}</td>
                  {grantable.map((s) =>
                    cell((policy.groups[dep] ?? []).includes(s.id), () => toggleGroup(dep, s.id)),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ④ 帳號例外 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>帳號例外</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>帳號</th>
                {grantable.map((s) => (
                  <th key={s.id} style={thStyle}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.users.map((u) => (
                <tr key={u.id}>
                  <td style={tdStyle}>
                    {u.label}
                    <span className="row-sub" style={{ marginLeft: 4 }}>
                      {u.id}
                    </span>
                  </td>
                  {grantable.map((s) =>
                    cell((policy.accounts[u.id] ?? []).includes(s.id), () => toggleAccount(u.id, s.id)),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          儲存
        </button>
      </div>
    </div>
  );
}
