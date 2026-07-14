import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UnauthorizedError, type Tenant } from '../api';
import { useAuth } from '../auth';
import AppLayout from '../components/AppLayout';
import { IconChevron, IconInfo, IconPlus } from '../components/icons';
import { Checkbox } from '@oa-agent/ui';

export default function TenantsPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function handleErr(e: unknown) {
    if (e instanceof UnauthorizedError) {
      logout();
      navigate('/login', { replace: true });
      return;
    }
    setErr(e instanceof Error ? e.message : '發生錯誤');
  }

  async function load() {
    try {
      setTenants(await api.listTenants());
    } catch (e) {
      handleErr(e);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const { publishableKey } = await api.createTenant({ name: name.trim() });
      setName('');
      setCreating(false);
      setNewKey(publishableKey);
      await load();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  // 可刪除的租戶（排除向後相容的預設租戶）
  const deletable = tenants.filter((t) => t.id !== 'default');
  const allSelected = deletable.length > 0 && deletable.every((t) => selected.has(t.id));

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(deletable.map((t) => t.id)));
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`確定刪除選取的 ${selected.size} 個租戶？其 API 金鑰會一併移除，此動作無法復原。`)) return;
    try {
      await Promise.all([...selected].map((id) => api.deleteTenant(id)));
      setSelected(new Set());
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <AppLayout
      crumb="營運"
      title="租戶"
      actions={
        <button className="btn btn-primary btn-sm" onClick={() => setCreating((v) => !v)}>
          <IconPlus />
          新增租戶
        </button>
      }
    >
      {err && (
        <div className="banner banner-err">
          <IconInfo />
          {err}
        </div>
      )}
      {newKey && (
        <div className="banner banner-key">
          <IconInfo />
          <span>
            租戶已建立，公開金鑰 <span className="code-pill">{newKey}</span> — 僅顯示一次，請妥善保存。
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {deletable.length > 0 && (
              <Checkbox checked={allSelected} onChange={toggleAll} aria-label="全選" title="全選" />
            )}
            <div>
              <div className="card-title">所有租戶</div>
              <div className="card-desc">{tenants.length} 個整合方</div>
            </div>
          </div>
          {selected.size > 0 && (
            <button className="btn btn-danger btn-sm" onClick={removeSelected}>
              刪除選取（{selected.size}）
            </button>
          )}
        </div>

        {creating && (
          <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
            <div className="toolbar">
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                placeholder="新租戶名稱，例如 Acme Inc."
                autoFocus
              />
              <button className="btn btn-primary" onClick={create} disabled={busy}>
                {busy ? '建立中…' : '建立'}
              </button>
              <button className="btn btn-ghost" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        <ul className="list">
          {tenants.map((t) => (
            <li
              key={t.id}
              className="row row-link"
              onClick={() => navigate(`/tenants/${t.id}`)}
              style={{ cursor: 'pointer' }}
            >
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {t.id === 'default' ? (
                  // 預設租戶不可刪，但保留 checkbox 佔位讓名稱與其他列對齊
                  <Checkbox disabled aria-hidden tabIndex={-1} style={{ visibility: 'hidden' }} />
                ) : (
                  <Checkbox
                    checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                    aria-label={`選取 ${t.name}`}
                  />
                )}
              </div>
              <div className="row-main" style={{ flex: 1 }}>
                <div className="row-title">
                  {t.name}
                  {/* 未帶 API 金鑰的聊天視窗/widget 一律落在預設租戶——標示出來，避免知識庫等內容傳錯租戶 */}
                  {t.id === 'default' && (
                    <span className="badge badge-on" style={{ marginLeft: 8 }}>
                      未帶金鑰的聊天視窗使用中
                    </span>
                  )}
                </div>
                <div className="row-sub">{t.id}</div>
              </div>
              <IconChevron className="chev" />
            </li>
          ))}
          {tenants.length === 0 && <li className="empty">尚無租戶，點右上「新增租戶」開始。</li>}
        </ul>
      </div>
    </AppLayout>
  );
}
