import { useEffect, useState } from 'react';
import { api, type ApiKey, type LLMConfigPatch, type LLMConfigView, type Tenant } from '../../api';
import { useAuth } from '../../auth';
import { IconCopy, IconKey } from '../../components/icons';
import { useUnsavedChanges } from '../../components/unsaved';
import UnsavedBadge from '../../components/UnsavedBadge';
import { useConfirm } from '../../components/confirm';

/**
 * 接入設定。依 section 分成兩頁：
 * - basic：租戶設定（名稱、嵌入來源、用量上限、訪客）與 API 金鑰
 * - ai：AI 模型（租戶自帶金鑰）
 * 兩頁共用同一份狀態與儲存邏輯，只是分開呈現，讓導覽一眼找得到 AI 模型。
 */
export default function SettingsTab({
  tenant,
  onSaved,
  onError,
  section = 'basic',
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
  section?: 'basic' | 'ai';
}) {
  const { isSuper } = useAuth();
  const [name, setName] = useState(tenant.name);
  const [origins, setOrigins] = useState((tenant.allowedOrigins ?? []).join('\n'));
  const [quota, setQuota] = useState(
    tenant.quotaMonthlyLlmTokens ? String(tenant.quotaMonthlyLlmTokens) : '',
  );
  const [guestAccess, setGuestAccess] = useState(tenant.guestAccess === true);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const [newKeys, setNewKeys] = useState<ApiKey[]>([]);

  const [llmCfg, setLlmCfg] = useState<LLMConfigView | null>(null);
  const [llmProvider, setLlmProvider] = useState<'' | 'anthropic' | 'openai' | 'local'>('');
  const [llmModel, setLlmModel] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [llmBusy, setLlmBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getLlmConfig(tenant.id)
      .then((c) => {
        if (cancelled) return;
        setLlmCfg(c);
        setLlmProvider(c.provider ?? '');
        setLlmModel(c.model ?? '');
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [tenant.id, onError]);

  // 未儲存判斷：與目前生效的值比對（儲存後外層重新載入 tenant，比對結果自然歸零）
  const originList = (text: string) => text.split('\n').map((x) => x.trim()).filter(Boolean);
  const tenantDirty = name.trim() !== tenant.name
    || originList(origins).join('\n') !== (tenant.allowedOrigins ?? []).join('\n')
    || (isSuper && (quota.trim() === '' ? 0 : Math.max(0, Number(quota) || 0)) !== (tenant.quotaMonthlyLlmTokens ?? 0))
    || guestAccess !== (tenant.guestAccess === true);
  const llmDirty = !!llmCfg && (
    llmProvider !== (llmCfg.provider ?? '') || llmModel.trim() !== (llmCfg.model ?? '')
    || !!anthropicKey.trim() || !!openaiKey.trim());
  useUnsavedChanges('基本設定：租戶設定', section === 'basic' && tenantDirty);
  useUnsavedChanges('AI 模型', section === 'ai' && llmDirty);

  async function saveLlm() {
    setLlmBusy(true);
    try {
      const patch: LLMConfigPatch = {
        provider: llmProvider === '' ? null : llmProvider,
        model: llmModel.trim() === '' ? null : llmModel.trim(),
      };
      if (anthropicKey.trim()) patch.anthropicApiKey = anthropicKey.trim();
      if (openaiKey.trim()) patch.openaiApiKey = openaiKey.trim();
      const view = await api.putLlmConfig(tenant.id, patch);
      setLlmCfg(view);
      setAnthropicKey('');
      setOpenaiKey('');
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setLlmBusy(false);
    }
  }

  async function clearKey(field: 'anthropicApiKey' | 'openaiApiKey') {
    const provider = field === 'anthropicApiKey' ? 'Anthropic' : 'OpenAI';
    const ok = await confirm({
      title: `清除 ${provider} 金鑰？`,
      message: '已儲存的金鑰會被刪除且無法再查看；之後此租戶改用平台預設金鑰，要恢復需重新輸入金鑰。',
      confirmText: '清除',
    });
    if (!ok) return;
    try {
      const view = await api.putLlmConfig(tenant.id, { [field]: null });
      setLlmCfg(view);
    } catch (e) {
      onError(e);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const allowedOrigins = origins.split('\n').map((s) => s.trim()).filter(Boolean);
      const patch: Parameters<typeof api.updateTenant>[1] = { name: name.trim(), allowedOrigins, guestAccess };
      // 配額只有超級管理者能改：租戶管理者的請求帶這個欄位，整個會被 403
      if (isSuper) {
        // 空字串或 0 = 不限（送 0 以清除既有配額）
        patch.quotaMonthlyLlmTokens = quota.trim() === '' ? 0 : Math.max(0, Number(quota) || 0);
      }
      await api.updateTenant(tenant.id, patch);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function genKey(type: 'publishable' | 'secret') {
    try {
      const k = await api.createKey(tenant.id, type);
      setNewKeys((ks) => [k, ...ks]);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="settings-stack">
      {section === 'basic' && <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">租戶設定<UnsavedBadge dirty={tenantDirty} /></div>
            <div className="card-desc">名稱、允許嵌入來源、用量配額與訪客使用。</div>
          </div>
        </div>
        <div className="card-body">
          <div className="field">
            <label className="field-label">名稱</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label className="field-label">允許嵌入來源</label>
            <span className="field-hint">每行一個網域，<code>*</code> 代表全放行。</span>
            <textarea
              className="textarea"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              rows={4}
              placeholder="https://acme.com"
            />
          </div>

          <div className="field">
            <label className="field-label">每月 AI 用量上限（Token）</label>
            <span className="field-hint">
              Token 是 AI 的計費單位（一個中文字約 1–2 個）。對話與知識庫檢索合計；留空或 0＝不限。超過上限後，當月的 AI 對話會暫停到下個月。{!isSuper && ' 此欄位只有平台管理者能修改。'}
            </span>
            <input
              className="input"
              type="number"
              min={0}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              readOnly={!isSuper}
              placeholder="例：1000000（100 萬 tokens／月）"
            />
          </div>

          <div className="field">
            <label className="field-label">
              <input type="checkbox" checked={guestAccess} onChange={(e) => setGuestAccess(e.target.checked)} /> 允許訪客免登入使用
            </label>
            <span className="field-hint">
              給沒有登入機制的公開 App（例如產品導覽 App）。開啟後，帶此租戶 pk_ 金鑰即可取得訪客身分，權限依「訪客部門」設定；關閉後既有訪客立即失效。
            </span>
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? '儲存中…' : '儲存設定'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">API 金鑰</div>
            <div className="card-desc">公開金鑰（pk_）放在網站嵌入碼中，只能用於前台聊天視窗；私密金鑰（sk_）供伺服器呼叫 API，不可外流。金鑰只在產生當下顯示完整字串，請立即保存。</div>
          </div>
          <div className="toolbar">
            <button className="btn btn-ghost btn-sm" onClick={() => genKey('publishable')}>
              <IconKey />
              產生公開金鑰（pk_）
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => genKey('secret')}>
              <IconKey />
              產生私密金鑰（sk_）
            </button>
          </div>
        </div>
        {newKeys.length > 0 ? (
          <ul className="list">
            {newKeys.map((k) => (
              <li key={k.key} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <span className={`badge ${k.type === 'publishable' ? 'badge-on' : 'badge-off'}`}>
                      {k.type === 'publishable' ? '公開（pk_）' : '私密（sk_）'}
                    </span>
                  </div>
                  <div className="row-sub mono">{k.key}</div>
                </div>
                <button
                  className="icon-btn"
                  title="複製"
                  onClick={() => void navigator.clipboard.writeText(k.key)}
                >
                  <IconCopy />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">尚未在本次工作階段產生金鑰。</div>
        )}
      </div>
      </>}
      {section === 'ai' && <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">AI 模型（租戶自帶金鑰）<UnsavedBadge dirty={llmDirty} /></div>
            <div className="card-desc">
              未設定時使用平台預設模型與金鑰；設定後此租戶的 AI 費用計入自帶金鑰。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label className="field-label">供應商</label>
              <select
                className="select"
                value={llmProvider}
                onChange={(e) => setLlmProvider(e.target.value as '' | 'anthropic' | 'openai' | 'local')}
              >
                <option value="">平台預設</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
                <option value="local">地端（自架模型）</option>
              </select>
              {llmProvider === 'local' && (
                <div className="card-desc">
                  地端對話模型使用平台部署層設定的端點。注意：知識庫查詢使用的向量模型（embedding）是否地端化由平台部署層決定，非此處設定。
                </div>
              )}
            </div>

            <div className="field">
              <label className="field-label">模型</label>
              <input
                className="input"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                disabled={llmProvider === ''}
                placeholder="未填用供應商預設（如 gpt-4o-mini / claude-sonnet-5-5）"
              />
            </div>
          </div>

          {llmProvider !== 'local' && (
            <div className="field">
              <label className="field-label">Anthropic 金鑰</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={llmCfg?.anthropicApiKey ?? '未設定'}
                />
                {llmCfg?.anthropicApiKey != null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void clearKey('anthropicApiKey')}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          )}

          {llmProvider !== 'local' && (
            <div className="field">
              <label className="field-label">OpenAI 金鑰</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder={llmCfg?.openaiApiKey ?? '未設定'}
                />
                {llmCfg?.openaiApiKey != null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void clearKey('openaiApiKey')}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => void saveLlm()} disabled={llmBusy}>
              {llmBusy ? '儲存中…' : '儲存設定'}
            </button>
          </div>
        </div>
      </div>

      </>}
    </div>
  );
}
