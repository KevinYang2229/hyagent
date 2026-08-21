import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { DatePicker } from '@hyagent/ui';
import { api, type ReportListItem } from '../../api';

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

/**
 * DatePicker 的 YYYY-MM-DD → ISO。
 *
 * 兩個坑都在這裡處理掉：
 * 1. `new Date('2026-08-13')` 依規範解析為 **UTC** 午夜，對台北使用者等於當天早上 8 點，
 *    03:00 產生的報告會被錯誤排除。改為明確組出「本地」時間再轉 ISO。
 * 2. 結束日必須含當天整日（到 23:59:59.999），否則起訖選同一天會查不到任何東西。
 */
function toIso(date: string, edge: 'start' | 'end'): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}`);
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
    void load({ q: q.trim() || undefined, from: toIso(from, 'start'), to: toIso(to, 'end') });
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

      <div className="card-body">
        <div className="form-grid">
          <div className="field">
            <label className="field-label">關鍵字</label>
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="檔名或使用者"
            />
            <span className="field-hint">報告主題未落地，故只比對檔名與使用者。</span>
          </div>
          <div className="field">
            <label className="field-label">產生日期</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <DatePicker value={from} onChange={setFrom} placeholder="起始日" />
              <span className="field-hint">至</span>
              <DatePicker value={to} onChange={setTo} placeholder="結束日" />
            </div>
            <span className="field-hint">含起訖當日；留空表示不限。</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn btn-primary btn-sm" onClick={search} disabled={busy}>
            {busy ? '查詢中…' : '查詢'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={reset} disabled={busy}>
            清除
          </button>
        </div>
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
                          className="btn btn-ghost btn-sm"
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
