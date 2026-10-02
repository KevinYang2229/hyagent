import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { api, UnauthorizedError, type McpServerListView, type McpServerView, type Tenant } from '../api';
import { useAuth } from '../auth';
import { emptyMcpForm, statusLabel, toFormValues, toPayload, validateMcpForm, type McpServerFormValues } from './mcpForm.util';

/**
 * MCP 服務（平台層）：登記自建 MCP server、測試連線、檢視工具讀寫判定並覆寫。
 * 授權在各租戶的權限分頁授予 mcp:<serverId>。
 */
export default function McpServersPage() {
  const [view, setView] = useState<McpServerListView | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ isNew: boolean; values: McpServerFormValues } | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate('/login');
        return;
      }
      setErr(e instanceof Error ? e.message : String(e));
    },
    [logout, navigate],
  );

  const load = useCallback(async () => {
    try {
      const [v, ts] = await Promise.all([api.listMcpServers(), api.listTenants()]);
      setView(v);
      setTenants(ts);
      setErr(null);
    } catch (e) {
      handle(e);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  function replaceServer(next: McpServerView) {
    setView((v) => (v ? { ...v, servers: v.servers.map((s) => (s.config.id === next.config.id ? next : s)) } : v));
  }

  async function save() {
    if (!editing) return;
    const errors = validateMcpForm(editing.values, editing.isNew);
    setFormErrors(errors);
    if (errors.length > 0) return;
    try {
      const payload = toPayload(editing.values);
      if (editing.isNew) await api.createMcpServer({ id: editing.values.id, ...payload });
      else await api.updateMcpServer(editing.values.id, payload);
      setEditing(null);
      await load();
    } catch (e) {
      handle(e);
    }
  }

  async function refresh(id: string) {
    setBusyId(id);
    try {
      replaceServer(await api.refreshMcpServer(id));
    } catch (e) {
      handle(e);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`確定刪除 MCP 服務「${id}」？已授予的 mcp:${id} 權限將失去作用。`)) return;
    try {
      await api.deleteMcpServer(id);
      await load();
    } catch (e) {
      handle(e);
    }
  }

  async function setOverride(server: McpServerView, tool: string, patch: { disabled?: boolean; requireConfirm?: boolean; cardTitle?: string }) {
    const cur = server.config.toolOverrides[tool] ?? {};
    try {
      replaceServer(
        await api.updateMcpServer(server.config.id, {
          toolOverrides: { ...server.config.toolOverrides, [tool]: { ...cur, ...patch } },
        }),
      );
    } catch (e) {
      handle(e);
    }
  }

  const tenantName = (id: string | null) => (id ? (tenants.find((t) => t.id === id)?.name ?? id) : '共用');

  return (
    <AppLayout crumb="平台" title="MCP 服務">
      {err && <div className="card"><div className="empty">{err}</div></div>}
      {view && !view.signingEnabled && (
        <div className="card"><div className="empty">尚未設定 MCP_SIGNING_KEY：MCP 功能停用中，AI 不會呼叫任何 MCP 工具。</div></div>
      )}
      {!view && !err && <div className="card"><div className="empty">載入中…</div></div>}

      {view && (
        <div className="card">
          <div className="card-head">
            <h3>已登記的服務</h3>
            <button type="button" className="btn primary" onClick={() => { setFormErrors([]); setEditing({ isNew: true, values: emptyMcpForm() }); }}>
              新增 MCP 服務
            </button>
          </div>
          {view.servers.length === 0 && <div className="empty">尚未登記任何 MCP 服務</div>}
          {view.servers.map((s) => (
            <section key={s.config.id} className="mcp-server">
              <header>
                <strong>{s.config.name}</strong> <code>{s.config.id}</code>
                <span className="tag">{tenantName(s.config.ownerTenantId)}</span>
                <span className="tag">{s.config.enabled ? '啟用' : '停用'}</span>
                <span className="tag" title={s.status.lastError}>{statusLabel(s.status.state)}</span>
              </header>
              <div className="muted">{s.config.url}</div>
              {s.status.lastError && <div className="muted">最後錯誤：{s.status.lastError}</div>}
              <div className="actions">
                <button type="button" className="btn" disabled={busyId === s.config.id} onClick={() => void refresh(s.config.id)}>
                  {busyId === s.config.id ? '連線中…' : '測試連線／重新整理'}
                </button>
                <button type="button" className="btn" onClick={() => { setFormErrors([]); setEditing({ isNew: false, values: toFormValues(s.config) }); }}>編輯</button>
                <button type="button" className="btn danger" onClick={() => void remove(s.config.id)}>刪除</button>
              </div>
              {s.tools.length > 0 && (
                <table className="table">
                  <thead>
                    <tr><th>工具</th><th>判定</th><th>停用</th><th>強制確認</th><th>卡片標題</th><th>問題</th></tr>
                  </thead>
                  <tbody>
                    {s.tools.map((t) => (
                      <tr key={t.name} className={t.problem ? 'row-error' : undefined}>
                        <td>{t.title ?? t.name}<div className="muted"><code>{t.name}</code></div></td>
                        <td>{t.effect === 'read' ? '唯讀' : '寫入（需確認）'}</td>
                        <td>
                          <input type="checkbox" checked={t.disabled} onChange={(e) => void setOverride(s, t.name, { disabled: e.target.checked })} />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={s.config.toolOverrides[t.name]?.requireConfirm === true}
                            onChange={(e) => void setOverride(s, t.name, { requireConfirm: e.target.checked })}
                          />
                        </td>
                        <td>
                          {t.effect === 'write' && (
                            <input
                              key={`${s.config.id}/${t.name}/${s.config.toolOverrides[t.name]?.cardTitle ?? ''}`}
                              defaultValue={s.config.toolOverrides[t.name]?.cardTitle ?? ''}
                              placeholder={t.title ?? t.name}
                              maxLength={60}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next !== (s.config.toolOverrides[t.name]?.cardTitle ?? '')) {
                                  void setOverride(s, t.name, { cardTitle: next || undefined });
                                }
                              }}
                            />
                          )}
                        </td>
                        <td>{t.problem === 'name_invalid' ? '名稱不合法或過長，不會給 AI 使用' : t.problem === 'schema_invalid' ? '輸入 schema 無效，不會給 AI 使用' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}

      {editing && (
        <div className="card">
          <h3>{editing.isNew ? '新增 MCP 服務' : `編輯：${editing.values.id}`}</h3>
          {formErrors.length > 0 && <ul className="form-errors">{formErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="form-grid">
            <label>serverId
              <input value={editing.values.id} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, id: e.target.value } })} />
            </label>
            <label>名稱
              <input value={editing.values.name} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, name: e.target.value } })} />
            </label>
            <label>URL（Streamable HTTP）
              <input value={editing.values.url} placeholder="https://rooms.example.com/mcp" onChange={(e) => setEditing({ ...editing, values: { ...editing.values, url: e.target.value } })} />
            </label>
            <label>擁有租戶
              <select value={editing.values.ownerTenantId} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, ownerTenantId: e.target.value } })}>
                <option value="">共用（所有租戶皆可被授權）</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}（專屬）</option>)}
              </select>
            </label>
            <label>能力描述（AI 路由與提示詞會用到）
              <textarea value={editing.values.description} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, description: e.target.value } })} />
            </label>
            <label>路由關鍵字（逗號或頓號分隔）
              <input value={editing.values.keywords} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, keywords: e.target.value } })} />
            </label>
            <label>逾時（秒）
              <input value={editing.values.timeoutSeconds} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, timeoutSeconds: e.target.value } })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={editing.values.enabled} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, enabled: e.target.checked } })} />
              啟用
            </label>
          </div>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void save()}>儲存</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
