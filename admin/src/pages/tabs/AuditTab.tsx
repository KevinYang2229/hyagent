import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type AuditEntry } from '../../api';

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

export default function AuditTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.getTenantAudit(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rows) return <div className="card"><div className="card-body">載入中…</div></div>;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">稽核紀錄</div>
          <div className="card-desc">有副作用的動作（寄信、送單）的軌跡：誰、何時、做了什麼、成功與否。只顯示安全摘要，不含信件內容。</div>
        </div>
      </div>
      <div className="card-body" style={{ overflowX: 'auto' }}>
        {rows.length === 0 ? (
          <div className="row-sub">尚無稽核紀錄。</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={th}>時間</th>
                <th style={th}>工具</th>
                <th style={th}>使用者</th>
                <th style={th}>摘要</th>
                <th style={th}>狀態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td style={td}>{new Date(e.at).toLocaleString()}</td>
                  <td style={td}>{e.toolId}</td>
                  <td style={td}>{e.userId}</td>
                  <td style={td}>{e.summary}</td>
                  <td style={td}>{e.ok ? '✅ 成功' : `⛔ ${e.error ?? '失敗'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
