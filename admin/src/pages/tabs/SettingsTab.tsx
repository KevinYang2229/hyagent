import { useEffect, useState } from 'react';
import { api, type ApiKey, type LLMConfigPatch, type LLMConfigView, type Tenant } from '../../api';
import { IconCopy, IconKey } from '../../components/icons';

export default function SettingsTab({
  tenant,
  onSaved,
  onError,
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [origins, setOrigins] = useState((tenant.allowedOrigins ?? []).join('\n'));
  const [quota, setQuota] = useState(
    tenant.quotaMonthlyLlmTokens ? String(tenant.quotaMonthlyLlmTokens) : '',
  );
  const [guestAccess, setGuestAccess] = useState(tenant.guestAccess === true);
  const [busy, setBusy] = useState(false);
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
      // 空字串或 0 = 不限（送 0 以清除既有配額）
      patch.quotaMonthlyLlmTokens = quota.trim() === '' ? 0 : Math.max(0, Number(quota) || 0);
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
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">租戶設定</div>
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
            <label className="field-label">月度 AI Token 配額</label>
            <span className="field-hint">
              LLM＋embedding 合計；留空或 0＝不限。超過當月配額時對話 API 回 429。
            </span>
            <input
              className="input"
              type="number"
              min={0}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
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
            <div className="card-title">AI 模型（租戶自帶金鑰）</div>
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
                  地端對話模型使用平台部署層設定的端點。注意：知識庫查詢的 embedding 是否地端化由平台部署層決定，非此處設定。
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
                placeholder="未填用供應商預設（如 gpt-4o-mini / claude-sonnet-4-5）"
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

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">API Keys</div>
            <div className="card-desc">金鑰僅在產生當下顯示完整字串，請立即保存。</div>
          </div>
          <div className="toolbar">
            <button className="btn btn-ghost btn-sm" onClick={() => genKey('publishable')}>
              <IconKey />
              產生 pk_
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => genKey('secret')}>
              <IconKey />
              產生 sk_
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
                      {k.type === 'publishable' ? 'publishable' : 'secret'}
                    </span>
                  </div>
                  <div className="row-sub">{k.key}</div>
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
    </div>
  );
}
