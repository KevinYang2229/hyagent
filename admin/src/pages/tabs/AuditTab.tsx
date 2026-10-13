import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type AuditEntry } from '../../api';

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

/** 帶 tenantId＝該租戶稽核；不帶＝平台層稽核（建立／刪除租戶、MCP 服務等） */
export default function AuditTab({ tenantId, onError }: { tenantId?: string; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await (tenantId ? api.getTenantAudit(tenantId) : api.getPlatformAudit()));
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
          <div className="card-title">{tenantId ? '稽核紀錄' : '平台稽核紀錄'}</div>
          <div className="card-desc">
            {tenantId
              ? '有副作用的動作（寄信、送單、後台設定變更）的軌跡：誰、何時、做了什麼、成功與否。只顯示安全摘要（路徑、欄位名），不含內容。'
              : '平台層的後台變更（建立／刪除租戶、MCP 服務）。租戶內的變更請到各租戶的稽核紀錄查看。'}
          </div>
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
