import { useState } from 'react';
import { Dialog } from '@hyagent/ui';
import { api, type DbiDataSource, type DbiDbType } from '../../../api';
import { IconPlus } from '../../../components/icons';
import { CONNECTION_EXAMPLES, connectionSummary, DB_TYPE_LABELS, diffSummary, parseList } from './database.util';

interface Props {
  serverId: string;
  tenantId: string;
  sources: DbiDataSource[];
  reload: () => Promise<void>;
  onReview: (dataSourceId: string) => void;
  onError: (e: unknown) => void;
}

interface FormValues {
  id: string;
  dbType: DbiDbType;
  schemas: string;
  connectionEnv: string;
  timezone: string;
}

const EMPTY: FormValues = { id: '', dbType: 'postgres', schemas: 'public', connectionEnv: '', timezone: 'Asia/Taipei' };

/** 每列操作結果：連線測試或掃描差異 */
type RowResult = { kind: 'ok' | 'err'; lines: string[]; warnings?: string[] };

export default function DataSourcesSection({ serverId, tenantId, sources, reload, onReview, onError }: Props) {
  const [form, setForm] = useState<{ isNew: boolean; values: FormValues } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [deleting, setDeleting] = useState<DbiDataSource | null>(null);

  const setResult = (id: string, r: RowResult) => setResults((m) => ({ ...m, [id]: r }));

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  const testConnection = (ds: DbiDataSource) =>
    run(ds.id, async () => {
      const s = connectionSummary(await api.dbiTestConnection(serverId, ds.id));
      setResult(ds.id, { kind: s.ok && !s.warnings.length ? 'ok' : 'err', lines: [s.text], warnings: s.warnings });
    });

  const sync = (ds: DbiDataSource) =>
    run(ds.id, async () => {
      const r = await api.dbiSchemaSync(serverId, ds.id);
      setResult(ds.id, { kind: 'ok', lines: diffSummary(r.diff) });
      await reload();
    });

  async function save() {
    if (!form) return;
    const v = form.values;
    const schemas = parseList(v.schemas);
    if (!v.id.trim() || !v.connectionEnv.trim() || schemas.length === 0) {
      onError(new Error('請填寫資料來源 ID、Schema 與連線字串環境變數'));
      return;
    }
    await run('form', async () => {
      // 表單沒有的欄位（如只能經 API 設定的 includeObjects）沿用既有值，PUT 是整筆取代
      const existing = form.isNew ? undefined : sources.find((s) => s.id === v.id);
      await api.dbiPutDataSource(serverId, v.id.trim(), {
        tenantId,
        dbType: v.dbType,
        schemas,
        connectionEnv: v.connectionEnv.trim(),
        timezone: v.timezone.trim() || 'Asia/Taipei',
        ...(existing?.includeObjects ? { includeObjects: existing.includeObjects } : {}),
      });
      setForm(null);
      await reload();
    });
  }

  async function confirmDelete() {
    const ds = deleting;
    setDeleting(null);
    if (ds) await run(ds.id, async () => {
      await api.dbiDeleteDataSource(serverId, ds.id);
      await reload();
    });
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">資料來源</div>
          <div className="card-desc">客戶的唯讀資料庫連線。密碼不經過 HyAgent：連線字串放在 db-intelligence 服務的環境變數，這裡只填變數名稱。</div>
        </div>
        {!form && (
          <button className="btn btn-primary btn-sm" onClick={() => setForm({ isNew: true, values: EMPTY })}>
            <IconPlus />
            新增資料來源
          </button>
        )}
      </div>

      {form && (
        <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">資料來源 ID</span>
              <input
                className="input"
                value={form.values.id}
                disabled={!form.isNew}
                placeholder="ds_erp"
                onChange={(e) => setForm({ ...form, values: { ...form.values, id: e.target.value } })}
              />
              <span className="field-hint">英數、底線與連字號；建立後不可修改</span>
            </label>
            <label className="field">
              <span className="field-label">資料庫類型</span>
              <select
                className="select"
                value={form.values.dbType}
                disabled={!form.isNew}
                onChange={(e) => {
                  const dbType = e.target.value as DbiDbType;
                  // Schema 預設值隨類型調整：PostgreSQL 是 public，MariaDB／MySQL 的 schema 就是資料庫名稱
                  const schemas = form.values.schemas === 'public' && dbType !== 'postgres' ? '' : form.values.schemas;
                  setForm({ ...form, values: { ...form.values, dbType, schemas: schemas || (dbType === 'postgres' ? 'public' : '') } });
                }}
              >
                {(Object.keys(DB_TYPE_LABELS) as DbiDbType[]).map((t) => (
                  <option key={t} value={t}>
                    {DB_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <span className="field-hint">建立後不可修改</span>
            </label>
            <label className="field">
              <span className="field-label">連線字串環境變數</span>
              <input
                className="input"
                value={form.values.connectionEnv}
                placeholder="DBI_DS_ERP_URL"
                onChange={(e) => setForm({ ...form, values: { ...form.values, connectionEnv: e.target.value } })}
              />
              <span className="field-hint">在 db-intelligence 服務設定此變數，例如 {CONNECTION_EXAMPLES[form.values.dbType]}</span>
            </label>
            <label className="field">
              <span className="field-label">允許掃描的 Schema</span>
              <input className="input" value={form.values.schemas} onChange={(e) => setForm({ ...form, values: { ...form.values, schemas: e.target.value } })} />
              <span className="field-hint">
                逗號分隔；範圍外的 Schema 不會被掃描。{form.values.dbType === 'postgres' ? '' : 'MariaDB／MySQL 填資料庫名稱'}
              </span>
            </label>
            <label className="field">
              <span className="field-label">時區</span>
              <input className="input" value={form.values.timezone} onChange={(e) => setForm({ ...form, values: { ...form.values, timezone: e.target.value } })} />
              <span className="field-hint">換算「今年」「上個月」等相對日期</span>
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy === 'form'}>
              儲存
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <ul className="list">
        {sources.map((ds) => {
          const r = results[ds.id];
          return (
            <li key={ds.id} className="row" style={{ flexWrap: 'wrap' }}>
              <div className="row-main">
                <div className="row-title">
                  <span style={{ fontWeight: 600 }}>{ds.id}</span>
                  <span className="badge badge-off">{DB_TYPE_LABELS[ds.dbType]}</span>
                  {!ds.catalog ? (
                    <span className="badge badge-off">尚未掃描</span>
                  ) : ds.catalog.published ? (
                    <span className="badge badge-on">已發布 v{ds.catalog.version}</span>
                  ) : (
                    <span className="badge badge-warn">未發布 v{ds.catalog.version}</span>
                  )}
                  {!ds.connectionConfigured && <span className="badge badge-warn">連線字串未設定</span>}
                </div>
                <div className="row-sub">
                  Schema：{ds.schemas.join('、')} · 環境變數：<span className="code-pill">{ds.connectionEnv}</span>
                  {ds.catalog && (
                    <>
                       · 資料集 {ds.catalog.approvedDatasets}/{ds.catalog.datasets} 已核准 · 可查詢欄位 {ds.catalog.queryableColumns}
                      {ds.catalog.unreviewedColumns > 0 && <> · <strong>{ds.catalog.unreviewedColumns} 個欄位待審核</strong></>}
                    </>
                  )}
                </div>
              </div>
              <div className="row-actions">
                <button className="btn btn-sm" disabled={busy === ds.id || !ds.connectionConfigured} onClick={() => void testConnection(ds)}>
                  連線測試
                </button>
                <button className="btn btn-sm" disabled={busy === ds.id || !ds.connectionConfigured} onClick={() => void sync(ds)}>
                  {busy === ds.id ? '處理中…' : '掃描 Schema'}
                </button>
                <button className="btn btn-primary btn-sm" disabled={!ds.catalog} onClick={() => onReview(ds.id)}>
                  審核 Catalog
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setForm({ isNew: false, values: { id: ds.id, dbType: ds.dbType, schemas: ds.schemas.join(', '), connectionEnv: ds.connectionEnv, timezone: ds.timezone } })}
                >
                  編輯
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => setDeleting(ds)}>
                  刪除
                </button>
              </div>
              {r && (
                <div className={`banner ${r.kind === 'ok' ? 'banner-key' : 'banner-err'}`} role="status" style={{ width: '100%', margin: '8px 0 0' }}>
                  <div>
                    {r.lines.map((l) => (
                      <div key={l}>{l}</div>
                    ))}
                    {r.warnings?.map((w) => (
                      <div key={w}>⚠ {w}</div>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {sources.length === 0 && <li className="empty">此租戶尚無資料來源。</li>}
      </ul>

      <Dialog
        isOpen={!!deleting}
        title={`刪除資料來源 ${deleting?.id ?? ''}？`}
        confirmText="刪除"
        confirmVariant="danger"
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      >
        仍有存取政策使用此資料來源時無法刪除，請先到「存取政策」移除。已掃描的 Catalog 會保留在服務端。
      </Dialog>
    </div>
  );
}
