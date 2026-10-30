import { useCallback, useEffect, useState } from 'react';
import { api, type DbiAuditEvent } from '../../../api';

interface Props {
  serverId: string;
  tenantId: string;
  onError: (e: unknown) => void;
}

const STATUS: Record<DbiAuditEvent['status'], { label: string; badge: string }> = {
  success: { label: '成功', badge: 'badge-on' },
  denied: { label: '拒絕', badge: 'badge-warn' },
  invalid: { label: '格式錯誤', badge: 'badge-off' },
  error: { label: '錯誤', badge: 'badge-warn' },
};

/** 最近的 AI 查詢稽核（服務端記憶體保留最近 5000 筆；長期保存在服務的 log） */
export default function AuditSection({ serverId, tenantId, onError }: Props) {
  const [events, setEvents] = useState<DbiAuditEvent[]>([]);
  const [status, setStatus] = useState('');
  const [requestId, setRequestId] = useState('');
  /** 按「查詢」才套用的 request_id（輸入時不即時重查） */
  const [appliedRequestId, setAppliedRequestId] = useState('');

  const load = useCallback(async () => {
    try {
      setEvents(await api.dbiAudit(serverId, { tenantId, status: status || undefined, requestId: appliedRequestId || undefined, limit: 100 }));
    } catch (e) {
      onError(e);
    }
  }, [serverId, tenantId, status, appliedRequestId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">查詢稽核</div>
          <div className="card-desc">每一次 AI 查詢都會記錄：誰、用哪條政策、查了哪些資料集、筆數與耗時。不記錄查詢結果與比較值。</div>
        </div>
      </div>
      <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
        <div className="toolbar">
          <select className="select" style={{ maxWidth: 140 }} aria-label="狀態" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部狀態</option>
            {Object.entries(STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <input className="input" style={{ maxWidth: 320 }} value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="request_id（req_…）" />
          <button
            className="btn btn-sm"
            onClick={() => (requestId.trim() === appliedRequestId ? void load() : setAppliedRequestId(requestId.trim()))}
          >
            查詢
          </button>
        </div>
      </div>
      <div className="mcp-tools-wrap" style={{ paddingTop: 8 }}>
        <table className="mcp-tools">
          <thead>
            <tr>
              <th>時間</th>
              <th>使用者</th>
              <th>狀態</th>
              <th>資料集</th>
              <th>政策</th>
              <th>筆數</th>
              <th>耗時</th>
              <th>request_id</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.request_id}>
                <td className="muted">{new Date(e.created_at).toLocaleString('zh-TW', { hour12: false })}</td>
                <td>{e.principal_id}</td>
                <td>
                  <span className={`badge ${STATUS[e.status].badge}`}>{STATUS[e.status].label}</span>
                  {e.reason_code && <div className="muted" style={{ fontSize: 12 }}>{e.reason_code}</div>}
                </td>
                <td>
                  {e.datasets?.join('、') ?? '—'}
                  {e.sensitive_columns?.length ? (
                    <div>
                      <span className="badge badge-warn" title={e.sensitive_columns.join('、')}>
                        敏感欄位 {e.sensitive_columns.length}
                      </span>
                    </div>
                  ) : null}
                </td>
                <td className="muted">{e.policy_ids?.join('、') ?? '—'}</td>
                <td>
                  {e.row_count ?? '—'}
                  {e.truncated && <span className="muted">（截斷）</span>}
                </td>
                <td className="muted">{e.duration_ms} ms</td>
                <td>
                  <span className="code-pill">{e.request_id}</span>
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  沒有符合的查詢紀錄。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
