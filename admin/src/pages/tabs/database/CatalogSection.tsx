import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DbiApproval, type DbiCatalog, type DbiDataSource, type DbiDataset, type DbiSensitivity } from '../../../api';
import { buildCatalogReview, parseList, unreviewedCount } from './database.util';

interface Props {
  serverId: string;
  sources: DbiDataSource[];
  dataSourceId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}

const APPROVAL: { value: DbiApproval; label: string }[] = [
  { value: 'pending', label: '待審' },
  { value: 'approved', label: '核准' },
  { value: 'rejected', label: '拒絕' },
];
const SENSITIVITY: { value: DbiSensitivity; label: string }[] = [
  { value: 'public', label: '公開' },
  { value: 'internal', label: '內部' },
  { value: 'confidential', label: '機密' },
  { value: 'restricted', label: '限制' },
];
const ORIGIN: Record<string, string> = { foreign_key: '外鍵', inferred: '推論', manual: '人工' };

export default function CatalogSection({ serverId, sources, dataSourceId, onSelect, onChanged, onError }: Props) {
  const [original, setOriginal] = useState<DbiCatalog | null>(null);
  const [edited, setEdited] = useState<DbiCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  // 同義詞輸入框於失焦時才寫回；重新載入時換 key 讓它重設成伺服器上的值
  const [resetKey, setResetKey] = useState(0);
  const scanned = sources.filter((s) => s.catalog);
  const current = dataSourceId ?? scanned[0]?.id ?? null;

  const load = useCallback(async () => {
    if (!current) return;
    try {
      const c = await api.dbiGetCatalog(serverId, current);
      setOriginal(c);
      setEdited(structuredClone(c));
      setResetKey((k) => k + 1);
      setMissing(false);
    } catch (e) {
      setOriginal(null);
      setEdited(null);
      setMissing(true);
      onError(e);
    }
  }, [serverId, current, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = useMemo(() => (original && edited ? buildCatalogReview(original, edited) : null), [original, edited]);

  function patchDataset(id: string, fn: (d: DbiDataset) => void) {
    setEdited((c) => {
      if (!c) return c;
      const next = structuredClone(c);
      fn(next.datasets.find((d) => d.id === id)!);
      return next;
    });
  }

  async function submit(body: Parameters<typeof api.dbiReviewCatalog>[2]) {
    if (!current) return;
    setBusy(true);
    try {
      const c = await api.dbiReviewCatalog(serverId, current, body);
      setOriginal(c);
      setEdited(structuredClone(c));
      setResetKey((k) => k + 1);
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  if (scanned.length === 0) {
    return (
      <div className="card">
        <div className="empty">尚無已掃描的資料來源。請先在「資料來源」執行「掃描 Schema」。</div>
      </div>
    );
  }

  return (
    <div className="settings-stack">
      {/* 審核欄位很長：儲存／發布列固定在上方，捲到底也看得到 */}
      <div className="card dbi-sticky">
        <div className="card-head">
          <div>
            <div className="card-title">Catalog 審核</div>
            <div className="card-desc">
              預設拒絕：只有「核准」的資料集裡「可查詢」的欄位，再加上存取政策允許，AI 才查得到。新掃到或型別變更的欄位一律不可查詢。
            </div>
          </div>
          <select className="select" style={{ maxWidth: 220 }} aria-label="資料來源" value={current ?? ''} onChange={(e) => onSelect(e.target.value)}>
            {scanned.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
        {edited && (
          <div className="card-body">
            <div className="toolbar">
              <span className={`badge ${edited.published ? 'badge-on' : 'badge-warn'}`}>{edited.published ? '已發布' : '未發布'}</span>
              <span className="muted">
                v{edited.version} · {unreviewedCount(edited)} 個欄位待審核
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-primary btn-sm" disabled={!review || busy} onClick={() => review && void submit(review)}>
                {review ? '儲存審核' : '沒有變更'}
              </button>
              <button className="btn btn-sm" disabled={busy || !!review} onClick={() => void submit({ publish: !edited.published })} title={review ? '請先儲存或放棄變更' : undefined}>
                {edited.published ? '取消發布' : '發布'}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load()}>
                {review ? '放棄變更' : '重新載入'}
              </button>
            </div>
          </div>
        )}
      </div>

      {missing && (
        <div className="card">
          <div className="empty">無法載入 Catalog。</div>
        </div>
      )}

      {edited?.datasets.map((ds) => (
        <div key={ds.id} className="card">
          <div className="card-head">
            <div>
              <div className="card-title">
                {ds.key} <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>{ds.id}・{ds.kind === 'table' ? '資料表' : '檢視表'}</span>
              </div>
              {ds.comment && (
                <div className="card-desc dbi-comment">
                  資料庫註解（未審核，不會提供給 AI）：{ds.comment}
                </div>
              )}
            </div>
            <select
              className="select"
              style={{ maxWidth: 120 }}
              aria-label={`${ds.key} 審核狀態`}
              value={ds.approvalStatus}
              onChange={(e) => patchDataset(ds.id, (d) => (d.approvalStatus = e.target.value as DbiApproval))}
            >
              {APPROVAL.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <label className="field">
                <span className="field-label">業務描述（提供給 AI）</span>
                <input className="input" value={ds.description ?? ''} onChange={(e) => patchDataset(ds.id, (d) => (d.description = e.target.value))} />
              </label>
              <label className="field">
                <span className="field-label">同義詞</span>
                <input
                  key={`syn-${ds.id}-${resetKey}`}
                  className="input"
                  defaultValue={ds.synonyms.join(', ')}
                  placeholder="以逗號分隔，例如：專案, 案子"
                  onBlur={(e) => patchDataset(ds.id, (d) => (d.synonyms = parseList(e.target.value)))}
                />
              </label>
            </div>
          </div>
          <div className="mcp-tools-wrap">
            <table className="mcp-tools dbi-columns">
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '26%' }} />
                <col style={{ width: '22%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>欄位</th>
                  <th>型別</th>
                  <th className="center">可查詢</th>
                  <th>敏感度</th>
                  <th>業務描述（提供給 AI）</th>
                  <th>資料庫註解（未審核）</th>
                </tr>
              </thead>
              <tbody>
                {ds.columns.map((c) => (
                  <tr key={c.name}>
                    <td>
                      <span className="mcp-tool-name">{c.name}</span>
                      {ds.primaryKey.includes(c.name) && <span className="muted"> PK</span>}{' '}
                      {c.reviewStatus === 'new' && <span className="badge badge-warn">新欄位</span>}
                      {c.reviewStatus === 'changed' && <span className="badge badge-warn">型別變更</span>}
                    </td>
                    <td className="muted">{c.dataType}</td>
                    <td className="center">
                      <input
                        type="checkbox"
                        aria-label={`${ds.key}.${c.name} 可查詢`}
                        checked={c.isQueryable}
                        disabled={c.typeCategory === 'other'}
                        title={c.typeCategory === 'other' ? '此型別不支援查詢' : undefined}
                        onChange={(e) => patchDataset(ds.id, (d) => (d.columns.find((x) => x.name === c.name)!.isQueryable = e.target.checked))}
                      />
                    </td>
                    <td>
                      <select
                        className="select"
                        aria-label={`${ds.key}.${c.name} 敏感度`}
                        value={c.sensitivity}
                        onChange={(e) => patchDataset(ds.id, (d) => (d.columns.find((x) => x.name === c.name)!.sensitivity = e.target.value as DbiSensitivity))}
                      >
                        {SENSITIVITY.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        aria-label={`${ds.key}.${c.name} 描述`}
                        value={c.description ?? ''}
                        onChange={(e) => patchDataset(ds.id, (d) => (d.columns.find((x) => x.name === c.name)!.description = e.target.value))}
                      />
                    </td>
                    <td className="dbi-comment">{c.comment ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="field-hint" style={{ marginTop: 8 }}>
              機密、限制欄位不會被政策的 <span className="code-pill">columns: ["*"]</span> 涵蓋，必須在政策中逐欄列出。
            </div>
          </div>
          {ds.metrics.length > 0 && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
              <div className="field-label">計算指標</div>
              <ul className="list">
                {ds.metrics.map((m) => (
                  <li key={m.key} className="row">
                    <div className="row-main">
                      <div className="row-title">
                        <span className="code-pill">{m.key}</span>
                        <span className={`badge ${m.approvalStatus === 'approved' ? 'badge-on' : 'badge-warn'}`}>{APPROVAL.find((a) => a.value === m.approvalStatus)?.label}</span>
                      </div>
                      <div className="row-sub">{m.description}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}

      {edited && edited.relationships.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">資料集關聯（JOIN）</div>
              <div className="card-desc">AI 只能沿「核准」的關聯 join。資料庫外鍵預設核准；推論或人工建立的關聯需審核。</div>
            </div>
          </div>
          <div className="mcp-tools-wrap">
            <table className="mcp-tools">
              <thead>
                <tr>
                  <th>關聯</th>
                  <th>來源</th>
                  <th>審核</th>
                </tr>
              </thead>
              <tbody>
                {edited.relationships.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="code-pill">
                        {r.from.dataset}({r.from.columns.join(',')}) → {r.to.dataset}({r.to.columns.join(',')})
                      </span>
                    </td>
                    <td className="muted">{ORIGIN[r.origin]}</td>
                    <td>
                      <select
                        className="select"
                        aria-label={`關聯 ${r.id} 審核狀態`}
                        value={r.approvalStatus}
                        onChange={(e) =>
                          setEdited((c) => c && { ...c, relationships: c.relationships.map((x) => (x.id === r.id ? { ...x, approvalStatus: e.target.value as DbiApproval } : x)) })
                        }
                      >
                        {APPROVAL.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
