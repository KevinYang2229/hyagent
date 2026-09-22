/**
 * 自動登入分頁：Assertion 公鑰與逐租戶設定（規格 §7.3、§7.4、§10.4、§11.1）。
 *
 * 取代改造前的「SSO 共享密鑰」輸入框。最重要的差別：**這裡只收公鑰**。
 * HyAgent 自此不持有任何可偽造客戶身分的秘密——誤貼私鑰會被後端擋下並要求換一組金鑰對。
 *
 * 不變條件（上限 2 把、不得停用最後一把）由後端強制（規格 §7.3 明文「不得僅在 UI 層」），
 * 這裡只負責把後端回的錯誤講清楚，不自行複製一份判斷邏輯——兩份遲早會不一致。
 *
 * 自成分頁而不是塞在「設定」裡的理由：這裡每個動作都**立即生效**，與設定分頁那顆
 * 一次送出的「儲存設定」語意不同。混在同一張卡時，改完公鑰或時鐘容忍的人會去按
 * 底下那顆「儲存設定」，以為沒按就沒生效——而那顆按鈕根本不送這些欄位。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AssertionKeysView,
  type AssertionSettings,
  type TenantPublicKey,
} from '../../api';

const STATUS_LABEL: Record<TenantPublicKey['status'], string> = {
  active: '啟用中',
  disabled: '已停用',
  revoked: '已撤銷',
};

export default function SsoTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const [view, setView] = useState<AssertionKeysView | null>(null);
  const [pem, setPem] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [revokeSub, setRevokeSub] = useState('');

  const load = useCallback(() => {
    void api.listAssertionKeys(tenantId).then(setView).catch(onError);
  }, [tenantId, onError]);

  useEffect(load, [load]);

  async function run(fn: () => Promise<string>): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      setNotice(await fn());
      load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const result = await api.addAssertionKey(tenantId, {
        publicKey: pem.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setPem('');
      setLabel('');
      return result.created
        ? `已新增公鑰 ${result.key.kid}`
        : `這把公鑰已經登記過了（${result.key.kid}，${STATUS_LABEL[result.key.status]}），未重複新增`;
    });

  const setStatus = (key: TenantPublicKey, status: TenantPublicKey['status']) =>
    run(async () => {
      const r = await api.setAssertionKeyStatus(tenantId, key.kid, status);
      return status === 'revoked'
        ? `已撤銷 ${key.kid}，並登出以它建立的 ${r.revokedSessions} 個 Session`
        : `已將 ${key.kid} 設為${STATUS_LABEL[status]}`;
    });

  /**
   * 撤銷前的二次確認（規格 §2.6 要求）。
   *
   * 文案必須明說「會一併登出正常使用者」——撤銷的動機通常是私鑰外洩，
   * 按下去的人多半沒想到它同時會把當下在線的所有人踢出去。
   */
  const confirmRevoke = (key: TenantPublicKey): void => {
    const remaining = (view?.keys ?? []).filter((k) => k.status === 'active' && k.kid !== key.kid);
    const extra = remaining.length
      ? ''
      : '\n\n這是最後一把啟用中的公鑰，撤銷後該租戶將無法登入，直到你上傳新的公鑰。';
    if (
      window.confirm(
        `確定撤銷公鑰 ${key.kid}？\n\n撤銷後，以這把金鑰建立的所有 Session 會立刻失效，` +
          `包含目前正常使用中的使用者。此操作無法復原。${extra}`,
      )
    ) {
      void setStatus(key, 'revoked');
    }
  };

  const saveSettings = (patch: Partial<AssertionSettings>) =>
    run(async () => {
      await api.updateAssertionSettings(tenantId, patch);
      return '已更新設定';
    });

  if (!view) return <p className="field-hint">載入中…</p>;

  const activeCount = view.keys.filter((k) => k.status === 'active').length;

  return (
    <div className="settings-stack">
      {/* 操作結果固定顯示在頂端：三張卡的按鈕散在整頁，訊息跟著按鈕跑會看不到 */}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Assertion 簽章公鑰</div>
            <div className="card-desc">
              客戶以自家私鑰簽發身分憑證，這裡只登記對應的<strong>公鑰</strong>。最多 2 把啟用中，
              且至少保留 1 把。kid 由系統依 RFC 7638 自公鑰算出，不需填寫。
            </div>
          </div>
        </div>
        <div className="card-body">
          {activeCount === 0 && (
            <p className="field-hint" style={{ color: '#b45309' }}>
              尚無啟用中的公鑰 —— 此租戶目前無法以 SSO 登入。
            </p>
          )}

          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>kid</th>
                <th>演算法</th>
                <th>狀態</th>
                <th>備註</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="field-hint">
                    尚未登記任何公鑰
                  </td>
                </tr>
              )}
              {view.keys.map((k) => (
                <tr key={k.kid}>
                  <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{k.kid}</td>
                  <td>{k.alg}</td>
                  <td>{STATUS_LABEL[k.status]}</td>
                  <td>{k.label ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {k.status === 'active' && (
                      <button className="btn" disabled={busy} onClick={() => void setStatus(k, 'disabled')}>
                        停用
                      </button>
                    )}
                    {k.status === 'disabled' && (
                      <button className="btn" disabled={busy} onClick={() => void setStatus(k, 'active')}>
                        啟用
                      </button>
                    )}
                    {k.status !== 'revoked' && (
                      <button className="btn" disabled={busy} onClick={() => confirmRevoke(k)}>
                        撤銷
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="field">
            <label className="field-label">上傳公鑰</label>
            <span className="field-hint">
              貼上 SPKI PEM（<code>-----BEGIN PUBLIC KEY-----</code>）或 JWK。請客戶只提供公鑰，
              私鑰絕不可離開他們的環境。
            </span>
            <textarea
              className="input"
              rows={5}
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              placeholder="-----BEGIN PUBLIC KEY-----"
            />
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="備註（選填），例如「2026 正式環境」"
            />
            <div className="form-actions">
              <button className="btn btn-primary" disabled={busy || !pem.trim()} onClick={() => void add()}>
                新增公鑰
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">時間與 Session 設定</div>
            <div className="card-desc">
              時鐘容忍 0–30 秒，且不得超過 Assertion 有效期的 ¼；Session 有效期 300–28800 秒。
              每個欄位各自儲存，按下即生效。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <NumberField
              label="時鐘容忍（秒）"
              value={view.settings.clockSkewSeconds}
              defaultValue={15}
              disabled={busy}
              onSave={(v) => void saveSettings({ clockSkewSeconds: v })}
            />
            <NumberField
              label="Assertion 有效期（秒）"
              value={view.settings.assertionLifetimeSeconds}
              defaultValue={60}
              disabled={busy}
              onSave={(v) => void saveSettings({ assertionLifetimeSeconds: v })}
            />
            <NumberField
              label="Session 有效期（秒）"
              value={view.settings.sessionExpiresIn}
              defaultValue={3600}
              disabled={busy}
              onSave={(v) => void saveSettings({ sessionExpiresIn: v })}
            />
          </div>

          {view.clockOffset && (
            <p className="field-hint">
              近期時鐘偏移：{view.clockOffset.count} 次觀測，中位數 {view.clockOffset.median} 秒，
              範圍 {view.clockOffset.min} ～ {view.clockOffset.max} 秒
              {view.clockOffset.warnCount > 0 &&
                `，其中 ${view.clockOffset.warnCount} 次超過容忍值一半（請雙方檢查 NTP）`}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">作廢使用者的所有 Session</div>
            <div className="card-desc">
              用於帳號停權、離職。<strong>請先在客戶自家系統停權</strong>，否則對方的 Identity
              Endpoint 還會繼續簽發新憑證，作廢完馬上又能登入。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={revokeSub}
              onChange={(e) => setRevokeSub(e.target.value)}
              placeholder="使用者識別（Assertion 的 sub）"
            />
            <button
              className="btn"
              disabled={busy || !revokeSub.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await api.revokeSessionsBySub(tenantId, revokeSub.trim());
                  setRevokeSub('');
                  return `已作廢 ${r.revoked} 個 Session`;
                })
              }
            >
              作廢
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 數值設定：顯示現行值並標示是否偏離規格預設（規格 §11.1 的收斂呈現要求）。 */
function NumberField({
  label,
  value,
  defaultValue,
  disabled,
  onSave,
}: {
  label: string;
  value: number;
  defaultValue: number;
  disabled: boolean;
  onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const changed = Number(draft) !== value;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span className="field-hint">
        {label}
        {value !== defaultValue && `（預設 ${defaultValue}）`}
      </span>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          className="input"
          type="number"
          style={{ width: 110 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn" disabled={disabled || !changed} onClick={() => onSave(Number(draft))}>
          儲存
        </button>
      </div>
    </div>
  );
}
