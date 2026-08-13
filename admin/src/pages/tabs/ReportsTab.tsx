import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type ReportListItem } from '../../api';

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

/** datetime-local 的值（本地時間、無時區）→ ISO；空字串回 undefined */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default function ReportsTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<ReportListItem[] | null>(null);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (filter: { q?: string; from?: string; to?: string }) => {
      setBusy(true);
      try {
        setRows(await api.listReports(tenantId, filter));
      } catch (e) {
        onError(e);
      } finally {
        setBusy(false);
      }
    },
    [tenantId, onError],
  );

  useEffect(() => {
    void load({});
  }, [load]);

  function search() {
    void load({ q: q.trim() || undefined, from: toIso(from), to: toIso(to) });
  }

  function reset() {
    setQ('');
    setFrom('');
    setTo('');
    void load({});
  }

  async function download(row: ReportListItem, format: string, filename: string) {
    try {
      await api.downloadReport(tenantId, row.reportId, format, filename);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">報告</div>
          <div className="card-desc">
            由對話觸發、依知識庫檢索彙整而成的報告。可依時間區間與關鍵字（檔名／使用者）查詢並下載。
            報告主題與產生進度只存在於記憶體，重啟即失，因此這裡查得到的是實際留存的產出物；
            超過保存期限者自動回收、不再列出。<strong>後台下載會寫入稽核紀錄。</strong>
          </div>
        </div>
      </div>

      <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          關鍵字
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="檔名或使用者"
            style={{ padding: '6px 8px' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          起始時間
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} style={{ padding: '6px 8px' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          結束時間
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: '6px 8px' }} />
        </label>
        <button className="btn" onClick={search} disabled={busy}>
          {busy ? '查詢中…' : '查詢'}
        </button>
        <button className="btn btn-ghost" onClick={reset} disabled={busy}>
          清除
        </button>
      </div>

      <div className="card-body" style={{ overflowX: 'auto' }}>
        {rows === null ? (
          <div className="row-sub">載入中…</div>
        ) : rows.length === 0 ? (
          <div className="row-sub">查無符合條件的報告。</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={th}>產生時間</th>
                <th style={th}>使用者</th>
                <th style={th}>報告</th>
                <th style={th}>到期時間</th>
                <th style={th}>下載</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reportId}>
                  <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={td}>{r.userId}</td>
                  {/* 檔名去掉副檔名當作報告名稱：主題沒有被持久化，檔名是最接近的東西 */}
                  <td style={td}>{r.files[0]?.filename.replace(/\.[^.]+$/, '') ?? r.reportId}</td>
                  <td style={td}>{new Date(r.expiresAt).toLocaleString()}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {r.files.map((f) => (
                        <button
                          key={f.format}
                          className="btn btn-ghost"
                          onClick={() => void download(r, f.format, f.filename)}
                        >
                          {f.format.toUpperCase()}
                        </button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
