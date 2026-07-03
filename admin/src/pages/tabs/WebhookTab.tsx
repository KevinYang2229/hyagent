import { useCallback, useEffect, useState } from 'react';
import { api, type WebhookEndpoint } from '../../api';
import { IconPlus } from '../../components/icons';

export default function WebhookTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [list, setList] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listWebhooks(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      await api.createWebhook(tenantId, { url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) });
      setUrl('');
      setSecret('');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(w: WebhookEndpoint) {
    try {
      await api.toggleWebhook(tenantId, w.id, !w.disabledAt);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function remove(w: WebhookEndpoint) {
    try {
      await api.deleteWebhook(tenantId, w.id);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Webhook 端點</div>
          <div className="card-desc">表單送出成功後以 HMAC 簽章推送 form.submitted。</div>
        </div>
      </div>

      <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
        <div className="toolbar">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://接收端/hook"
          />
          <input
            className="input"
            style={{ maxWidth: 200 }}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="簽章密鑰（選填）"
          />
          <button className="btn btn-primary" onClick={add} disabled={busy}>
            <IconPlus />
            新增
          </button>
        </div>
      </div>

      <ul className="list">
        {list.map((w) => (
          <li key={w.id} className="row">
            <div className="row-main">
              <div className="row-title">
                <span className={`badge ${w.disabledAt ? 'badge-off' : 'badge-on'}`}>
                  {w.disabledAt ? '已停用' : '啟用中'}
                </span>
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 500 }}>{w.url}</span>
              </div>
              <div className="row-sub">secret: {w.secret}</div>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => toggle(w)}>
                {w.disabledAt ? '啟用' : '停用'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => remove(w)}>
                刪除
              </button>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="empty">尚無 webhook 端點。</li>}
      </ul>
    </div>
  );
}
