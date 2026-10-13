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

  async function setOverride(server: McpServerView, tool: string, patch: { disabled?: boolean; requireConfirm?: boolean; approvedReadOnly?: boolean; cardTitle?: string }) {
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

  const tenantName = (id: string | null) => (id ? `${tenants.find((t) => t.id === id)?.name ?? id}（專屬）` : '共用');
  const setField = (patch: Partial<McpServerFormValues>) => editing && setEditing({ ...editing, values: { ...editing.values, ...patch } });

  return (
    <AppLayout crumb="平台" title="MCP 服務">
      <div className="mcp-page">
        {err && !editing && <div className="card"><div className="card-body form-errors">{err}</div></div>}
        {view && !view.signingEnabled && (
          <div className="card"><div className="card-body muted">尚未設定 MCP_SIGNING_KEY：MCP 功能停用中，AI 不會呼叫任何 MCP 工具。</div></div>
        )}
        {!view && !err && <div className="card"><div className="empty">載入中…</div></div>}

        {/* 表單放在清單上方：開啟時就在眼前，錯誤訊息也直接顯示在表單裡 */}
        {editing && (
          <div className="card">
            <div className="card-head">
              <div className="card-title">{editing.isNew ? '新增 MCP 服務' : `編輯：${editing.values.id}`}</div>
            </div>
            <div className="card-body">
              {(formErrors.length > 0 || err) && (
                <ul className="form-errors">
                  {formErrors.map((e) => <li key={e}>{e}</li>)}
                  {err && <li>{err}</li>}
                </ul>
              )}
              <div className="form-grid">
                <div className="field">
                  <label className="field-label" htmlFor="mcp-id">serverId</label>
                  <input id="mcp-id" className="input" value={editing.values.id} disabled={!editing.isNew} placeholder="rooms" onChange={(e) => setField({ id: e.target.value })} />
                  <div className="field-hint">小寫英數與連字號，建立後不可修改；授權用 scope 為 mcp:serverId</div>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="mcp-name">名稱</label>
                  <input id="mcp-name" className="input" value={editing.values.name} maxLength={60} onChange={(e) => setField({ name: e.target.value })} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="mcp-url">URL（Streamable HTTP）</label>
                  <input id="mcp-url" className="input" value={editing.values.url} placeholder="https://rooms.example.com/mcp" onChange={(e) => setField({ url: e.target.value })} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="mcp-owner">擁有租戶</label>
                  <select id="mcp-owner" className="select" value={editing.values.ownerTenantId} onChange={(e) => setField({ ownerTenantId: e.target.value })}>
                    <option value="">共用（所有租戶皆可被授權）</option>
                    {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}（專屬）</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="mcp-desc">能力描述</label>
                <textarea id="mcp-desc" className="textarea" value={editing.values.description} maxLength={500} onChange={(e) => setField({ description: e.target.value })} />
                <div className="field-hint">AI 路由與提示詞會用到，寫清楚這個服務能做什麼</div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label className="field-label" htmlFor="mcp-kw">路由關鍵字</label>
                  <input id="mcp-kw" className="input" value={editing.values.keywords} placeholder="會議室、預約、空檔" onChange={(e) => setField({ keywords: e.target.value })} />
                  <div className="field-hint">以逗號或頓號分隔</div>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="mcp-timeout">逾時（秒）</label>
                  <input id="mcp-timeout" className="input" inputMode="numeric" value={editing.values.timeoutSeconds} onChange={(e) => setField({ timeoutSeconds: e.target.value })} />
                </div>
              </div>
              <label className="mcp-check">
                <input type="checkbox" checked={editing.values.enabled} onChange={(e) => setField({ enabled: e.target.checked })} />
                啟用
              </label>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={() => void save()}>儲存</button>
                <button type="button" className="btn btn-ghost" onClick={() => { setEditing(null); setErr(null); }}>取消</button>
              </div>
            </div>
          </div>
        )}

        {view && (
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">已登記的服務</div>
                <div className="card-desc">授權請到各租戶的權限分頁，把 mcp:serverId 授予部門或帳號</div>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => { setFormErrors([]); setErr(null); setEditing({ isNew: true, values: emptyMcpForm() }); }}>
                新增 MCP 服務
              </button>
            </div>
            {view.servers.length === 0 && <div className="empty">尚未登記任何 MCP 服務</div>}
            {view.servers.map((s) => (
              <section key={s.config.id} className="mcp-server">
                <div className="mcp-server-head">
                  <div className="row-main">
                    <div className="row-title">
                      {s.config.name}
                      <span className={`badge ${STATUS_BADGE[s.status.state]}`} title={s.status.lastError}>{statusLabel(s.status.state)}</span>
                      <span className={`badge ${s.config.enabled ? 'badge-on' : 'badge-off'}`}>{s.config.enabled ? '啟用' : '停用'}</span>
                      <span className="badge badge-off">{tenantName(s.config.ownerTenantId)}</span>
                    </div>
                    <div className="row-sub">{s.config.id} · {s.config.url}</div>
                    {s.status.lastError && <div className="mcp-error">最後錯誤：{s.status.lastError}</div>}
                  </div>
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm" disabled={busyId === s.config.id} onClick={() => void refresh(s.config.id)}>
                      {busyId === s.config.id ? '連線中…' : '測試連線'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFormErrors([]); setErr(null); setEditing({ isNew: false, values: toFormValues(s.config) }); }}>編輯</button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove(s.config.id)}>刪除</button>
                  </div>
                </div>
                {s.tools.length > 0 ? (
                  <div className="mcp-tools-wrap">
                    <table className="mcp-tools">
                      <thead>
                        <tr><th>工具</th><th>判定</th><th className="center">停用</th><th className="center">核准唯讀</th><th className="center">強制確認</th><th>卡片標題</th></tr>
                      </thead>
                      <tbody>
                        {s.tools.map((t) => (
                          <tr key={t.name} className={t.problem ? 'row-error' : undefined}>
                            <td>
                              <div className="mcp-tool-name">{t.title ?? t.name}</div>
                              <div className="row-sub">{t.name}</div>
                              {t.problem && (
                                <div className="mcp-error">
                                  {t.problem === 'name_invalid' ? '名稱不合法或過長，不會給 AI 使用' : '輸入 schema 無效，不會給 AI 使用'}
                                </div>
                              )}
                            </td>
                            <td>
                              <span className={`badge ${t.effect === 'read' ? 'badge-on' : 'badge-warn'}`}>{t.effect === 'read' ? '唯讀' : '寫入・需確認'}</span>
                              {t.declaredReadOnly && t.effect === 'write' && !s.config.toolOverrides[t.name]?.approvedReadOnly && (
                                <div className="row-sub">服務宣告唯讀，待核准</div>
                              )}
                            </td>
                            <td className="center">
                              <input type="checkbox" aria-label={`停用 ${t.name}`} checked={t.disabled} onChange={(e) => void setOverride(s, t.name, { disabled: e.target.checked })} />
                            </td>
                            <td className="center">
                              {/* 只有遠端宣告唯讀的工具能核准：核准不會讓沒宣告的工具變唯讀 */}
                              {t.declaredReadOnly ? (
                                <input
                                  type="checkbox"
                                  aria-label={`核准唯讀 ${t.name}`}
                                  title="確認此工具只讀取資料、不會修改任何東西後再核准；核准後 AI 呼叫不再經使用者確認"
                                  checked={s.config.toolOverrides[t.name]?.approvedReadOnly === true}
                                  onChange={(e) => void setOverride(s, t.name, { approvedReadOnly: e.target.checked })}
                                />
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td className="center">
                              <input
                                type="checkbox"
                                aria-label={`強制確認 ${t.name}`}
                                checked={s.config.toolOverrides[t.name]?.requireConfirm === true}
                                onChange={(e) => void setOverride(s, t.name, { requireConfirm: e.target.checked })}
                              />
                            </td>
                            <td>
                              {t.effect === 'write' ? (
                                <input
                                  key={`${s.config.id}/${t.name}/${s.config.toolOverrides[t.name]?.cardTitle ?? ''}`}
                                  className="input"
                                  aria-label={`卡片標題 ${t.name}`}
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
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mcp-hint muted">{EMPTY_TOOLS_HINT[s.status.state]}</div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

const STATUS_BADGE: Record<McpServerView['status']['state'], string> = {
  ok: 'badge-on',
  unreachable: 'badge-warn',
  auth_failed: 'badge-warn',
  idle: 'badge-off',
};

/** 沒有工具清單時的提示：依連線狀態說明原因，避免把「連線失敗」誤讀成「還沒連過」。 */
const EMPTY_TOOLS_HINT: Record<McpServerView['status']['state'], string> = {
  idle: '尚未取得工具清單，按「測試連線」連線並列出工具。',
  ok: '這個服務目前沒有提供任何工具。',
  unreachable: '連線失敗，工具暫不提供給 AI 使用。確認服務已啟動、URL 正確後再按「測試連線」。',
  auth_failed: '身分驗證失敗，工具暫不提供給 AI 使用。請確認 MCP 服務的 JWKS URL 指向本平台，且 serverId 一致。',
};
