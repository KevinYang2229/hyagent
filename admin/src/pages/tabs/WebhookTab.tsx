import { useCallback, useEffect, useState } from 'react';
import { api, type WebhookEndpoint } from '../../api';
import { IconCopy, IconPlus } from '../../components/icons';
import { useConfirm } from '../../components/confirm';
import { useUnsavedChanges } from '../../components/unsaved';

export default function WebhookTab({
  tenantId,
  onError,
  readonly = false,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
  /** 唯讀：只列出端點，不能新增、啟停或刪除 */
  readonly?: boolean;
}) {
  const confirm = useConfirm();
  const [list, setList] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  useUnsavedChanges('事件通知：新增端點', url.trim() !== '' || secret.trim() !== '');
  const [busy, setBusy] = useState(false);
  // 建立當下伺服器回的完整 secret；列表只有遮罩值，所以只在這裡顯示一次
  const [created, setCreated] = useState<WebhookEndpoint | null>(null);

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
      const endpoint = await api.createWebhook(tenantId, { url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) });
      setCreated(endpoint);
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
    if (!(await confirm({ title: '刪除事件通知端點？', message: `之後表單送出不會再推送到 ${w.url}。若只是暫時不要，可改用「停用」。` }))) return;
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
          <div className="card-title">事件通知端點（Webhook）</div>
          <div className="card-desc">表單送出成功後，系統會把結果推送到這些網址（事件 form.submitted），並附上 HMAC 簽章供對方驗證來源。</div>
        </div>
      </div>

      {!readonly && <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
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
      </div>}

      {created && (
        <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <div className="row">
            <div className="row-main">
              <div className="row-title">已新增 {created.url}</div>
              <div className="row-sub">簽章密鑰只在此顯示一次，請立即複製並交給接收端保存。</div>
              <div className="row-sub mono">{created.secret}</div>
            </div>
            <button
              className="icon-btn"
              title="複製"
              aria-label="複製"
              onClick={() => void navigator.clipboard.writeText(created.secret)}
            >
              <IconCopy />
            </button>
          </div>
        </div>
      )}

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
              <div className="row-sub mono">secret: {w.secret}</div>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => toggle(w)} disabled={readonly}>
                {w.disabledAt ? '啟用' : '停用'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => remove(w)} disabled={readonly}>
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
