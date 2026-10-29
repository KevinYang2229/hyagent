import { useCallback, useEffect, useState } from 'react';
import { api, type DbiDataSource } from '../../../api';
import { parseJson, policyTemplate } from './database.util';

interface Props {
  serverId: string;
  tenantId: string;
  sources: DbiDataSource[];
  onSaved: (message: string) => void;
  onError: (e: unknown) => void;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** 政策版本是 ISO 時間：顯示成本地時間，其他格式原樣顯示 */
function formatVersion(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : `${d.toLocaleString('zh-TW', { hour12: false })} 更新`;
}

export default function PoliciesSection({ serverId, tenantId, sources, onSaved, onError }: Props) {
  const [policies, setPolicies] = useState('');
  const [version, setVersion] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [principals, setPrincipals] = useState('');
  const [parseError, setParseError] = useState<{ policies?: string; principals?: string }>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api.dbiGetPolicies(serverId, tenantId), api.dbiGetPrincipals(serverId, tenantId)]);
      setPolicies(pretty(p.policies));
      setVersion(p.version);
      setPrincipals(pretty(d));
      setWarnings([]);
      setParseError({});
    } catch (e) {
      onError(e);
    }
  }, [serverId, tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePolicies() {
    const parsed = parseJson(policies);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
      setParseError((e) => ({ ...e, policies: parsed.ok ? '政策必須是陣列' : parsed.error }));
      return;
    }
    setParseError((e) => ({ ...e, policies: undefined }));
    setBusy(true);
    try {
      const r = await api.dbiPutPolicies(serverId, tenantId, parsed.value);
      setPolicies(pretty(r.policies));
      setVersion(r.version);
      setWarnings(r.warnings ?? []);
      onSaved('已儲存存取政策');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function savePrincipals() {
    const parsed = parseJson(principals);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      setParseError((e) => ({ ...e, principals: parsed.ok ? '使用者目錄必須是物件（帳號 → 角色與屬性）' : parsed.error }));
      return;
    }
    setParseError((e) => ({ ...e, principals: undefined }));
    setBusy(true);
    try {
      setPrincipals(pretty(await api.dbiPutPrincipals(serverId, tenantId, parsed.value)));
      onSaved('已儲存使用者目錄');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  function addTemplate() {
    const parsed = parseJson(policies || '[]');
    const list = parsed.ok && Array.isArray(parsed.value) ? parsed.value : [];
    setPolicies(pretty([...list, policyTemplate(tenantId, sources[0]?.id ?? 'ds_id', 'public.table_name')]));
  }

  return (
    <div className="settings-stack">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">存取政策</div>
            <div className="card-desc">預設拒絕：沒有政策涵蓋的資料集一律查不到。一個查詢必須由「單一」政策完整允許，多條政策不會合併成更大的權限。</div>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            版本 {version ? formatVersion(version) : '—'}
          </span>
        </div>
        <div className="card-body">
          <ul className="field-hint" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 2.1 }}>
            <li>
              <span className="code-pill">principals.roles</span>：角色。在「權限」分頁把 <span className="code-pill">mcp:{serverId}:角色</span> 授予部門或帳號即可擁有該角色；也可寫在下方使用者目錄。
            </li>
            <li>
              <span className="code-pill">columns</span>：允許的欄位；<span className="code-pill">"*"</span> 只涵蓋公開、內部欄位。
            </li>
            <li>
              <span className="code-pill">rowScope</span>：資料列範圍，如 <span className="code-pill">{'{ "column": "department_id", "attribute": "departmentId" }'}</span>，屬性取自使用者目錄。
            </li>
            <li>
              <span className="code-pill">masked</span>（只能顯示、自動遮罩）、<span className="code-pill">aggregateOnly</span>＋<span className="code-pill">minGroupSize</span>（只能統計、每組至少 N 筆）、<span className="code-pill">maxRows</span>。
            </li>
          </ul>
          <label className="field">
            <span className="field-label">政策（JSON 陣列）</span>
            <textarea className="textarea dbi-json" aria-label="存取政策 JSON" style={{ minHeight: 340 }} value={policies} onChange={(e) => setPolicies(e.target.value)} spellCheck={false} />
          </label>
          {parseError.policies && <div className="form-errors" role="alert">{parseError.policies}</div>}
          {warnings.length > 0 && (
            <div className="banner banner-err" role="status" style={{ marginTop: 10 }}>
              <div>
                {warnings.map((w) => (
                  <div key={w}>⚠ {w}</div>
                ))}
              </div>
            </div>
          )}
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void savePolicies()}>
              儲存政策
            </button>
            <button className="btn btn-sm" onClick={addTemplate}>
              插入範本
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
              重新載入
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">使用者目錄</div>
            <div className="card-desc">補充角色與資料列範圍屬性（如部門）。格式：帳號 → {'{ "roles": [...], "attributes": { "departmentId": 1 } }'}；帳號需與 SSO 登入的使用者 ID 相同。</div>
          </div>
        </div>
        <div className="card-body">
          <label className="field">
            <span className="field-label">使用者目錄（JSON 物件）</span>
            <textarea className="textarea dbi-json" aria-label="使用者目錄 JSON" style={{ minHeight: 200 }} value={principals} onChange={(e) => setPrincipals(e.target.value)} spellCheck={false} />
          </label>
          {parseError.principals && <div className="form-errors" role="alert">{parseError.principals}</div>}
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void savePrincipals()}>
              儲存使用者目錄
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
