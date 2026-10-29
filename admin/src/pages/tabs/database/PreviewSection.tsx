import { useState } from 'react';
import { api, UnauthorizedError, type DbiDataSource, type DbiPreview } from '../../../api';
import { parseJson, parseList, SAMPLE_PLAN } from './database.util';

interface Props {
  serverId: string;
  tenantId: string;
  sources: DbiDataSource[];
  onError: (e: unknown) => void;
}

/** 以指定使用者的身分驗證 Query Plan 並顯示會執行的 SQL；不會真的查詢資料庫 */
export default function PreviewSection({ serverId, tenantId, sources, onError }: Props) {
  const [userId, setUserId] = useState('');
  const [scopes, setScopes] = useState('');
  const [plan, setPlan] = useState(() => SAMPLE_PLAN(sources[0]?.id ?? 'ds_id', 'projects'));
  const [result, setResult] = useState<DbiPreview | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function preview() {
    const parsed = parseJson(plan);
    if (!parsed.ok) {
      setResult(null);
      setDenied(parsed.error);
      return;
    }
    if (!userId.trim()) {
      setDenied('請輸入要模擬的使用者帳號');
      return;
    }
    setBusy(true);
    try {
      setResult(await api.dbiPreview(serverId, { tenant_id: tenantId, user_id: userId.trim(), scopes: parseList(scopes), query_plan: parsed.value }));
      setDenied(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        onError(e);
        return;
      }
      // 被政策或驗證拒絕是預覽的正常結果，就地顯示原因
      setResult(null);
      setDenied(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">查詢預覽</div>
          <div className="card-desc">模擬某位使用者送出 Query Plan，檢查會套用哪條政策、資料列範圍與實際 SQL。不會執行查詢。</div>
        </div>
      </div>
      <div className="card-body">
        <div className="form-grid">
          <label className="field">
            <span className="field-label">使用者帳號</span>
            <input className="input" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="alice" />
          </label>
          <label className="field">
            <span className="field-label">模擬的 scope（選填）</span>
            <input className="input" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder={`mcp:${serverId}:manager`} />
            <span className="field-hint">實際查詢時由「權限」分頁的授權決定</span>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Query Plan（JSON）</span>
          <textarea className="textarea dbi-json" aria-label="Query Plan JSON" style={{ minHeight: 220 }} value={plan} onChange={(e) => setPlan(e.target.value)} spellCheck={false} />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void preview()}>
            預覽
          </button>
        </div>

        {denied && (
          <div className="banner banner-err" role="alert" style={{ marginTop: 12 }}>
            <div>{denied}</div>
          </div>
        )}
        {result && (
          <div style={{ marginTop: 12 }}>
            <div className="row-sub" style={{ marginBottom: 6 }}>
              角色：{result.principal.roles.join('、') || '（無）'} · 套用政策：{result.policy_ids.join('、')} · 最多 {result.limit} 筆
              {result.min_group_size && <> · 每組至少 {result.min_group_size} 筆</>}
            </div>
            {result.row_scope.map((r) => (
              <div key={r.dataset} className="row-sub">
                資料列範圍 {r.dataset}：{r.conditions.map((c) => `${c.column} = ${JSON.stringify(c.value)}`).join(' 且 ')}
              </div>
            ))}
            {result.masked.length > 0 && <div className="row-sub">遮罩欄位：{result.masked.map((m) => m.output).join('、')}</div>}
            <pre className="dbi-pre" aria-label="SQL">{result.sql}</pre>
            <div className="row-sub">
              參數：<span className="code-pill">{JSON.stringify(result.params)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
