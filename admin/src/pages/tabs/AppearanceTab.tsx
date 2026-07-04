import { useCallback, useEffect, useRef, useState } from 'react';
import type { TenantAppearance } from '@oa-agent/shared';
import { api, type Tenant } from '../../api';

const POSITIONS = [
  { v: 'br', label: '右下' },
  { v: 'bl', label: '左下' },
] as const;

// 介面支援語系（對應 client i18n：zh-Hant / en）
const LOCALES = [
  { v: 'zh-Hant', label: '繁體中文' },
  { v: 'en', label: 'English' },
] as const;

// 預覽 widget client 來源；postMessage targetOrigin 與 iframe 來源一致。
// production 由 VITE_WIDGET_ORIGIN 指定部署網址（避免公開後台 iframe 連到 localhost 被瀏覽器封鎖）；dev 走本機 5173。
const PREVIEW_ORIGIN = (import.meta.env.VITE_WIDGET_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');

// 「開啟示範網站」按鈕的外部網址；可由 VITE_DEMO_SITE_URL 覆寫，預設指向 presale demo 部署。
const DEMO_SITE_URL = import.meta.env.VITE_DEMO_SITE_URL ?? 'https://oa-agent-presale-tenant.zeabur.app/';

export default function AppearanceTab({
  tenant,
  onSaved,
  onError,
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [form, setForm] = useState<TenantAppearance>(tenant.appearance ?? {});
  const [busy, setBusy] = useState(false);

  function set<K extends keyof TenantAppearance>(k: K, v: TenantAppearance[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setBusy(true);
    try {
      await api.updateTenant(tenant.id, { appearance: form });
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  // 即時預覽：嵌入 widget client（5173）。iframe URL 固定不變（避免每次編輯重載閃爍），
  // 改用 postMessage 把目前外觀即時推進去，預覽免重載即時反映。
  const previewSrc = `${PREVIEW_ORIGIN}/?embed=1&preview=1`;
  const previewRef = useRef<HTMLIFrameElement>(null);

  const pushPreview = useCallback(() => {
    previewRef.current?.contentWindow?.postMessage(
      { source: 'oa-admin-preview', appearance: form },
      PREVIEW_ORIGIN,
    );
  }, [form]);

  // 表單任一欄位變更 → 即時推送到預覽
  useEffect(() => pushPreview(), [pushPreview]);

  // 預覽 client 載入完成會發 ready 握手；收到後補推一次目前狀態（避免時序競態）
  useEffect(() => {
    function onReady(e: MessageEvent) {
      if ((e.data as { source?: string } | null)?.source === 'oa-widget-ready') pushPreview();
    }
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [pushPreview]);

  const primary = form.primaryColor ?? '#4f46e5';

  return (
    <div className="appearance-grid">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Widget 外觀</div>
            <div className="card-desc">儲存後依租戶套用；widget 載入時讀取，data-* 參數仍優先。</div>
          </div>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <span className="field-label">主色</span>
              <div className="color-field">
                <input
                  type="color"
                  value={primary}
                  onChange={(e) => set('primaryColor', e.target.value)}
                />
                <span className="color-hex">{primary.toUpperCase()}</span>
              </div>
            </div>

            <div className="field">
              <label className="field-label">主題</label>
              <select
                className="select"
                value={form.theme ?? 'light'}
                onChange={(e) => set('theme', e.target.value as TenantAppearance['theme'])}
              >
                <option value="light">淺色</option>
                <option value="dark">深色</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label">啟動按鈕位置</label>
              <select
                className="select"
                value={form.position ?? 'br'}
                onChange={(e) => set('position', e.target.value as TenantAppearance['position'])}
              >
                {POSITIONS.map((p) => (
                  <option key={p.v} value={p.v}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label">距側邊（px）</label>
              <input
                className="input"
                type="number"
                min={0}
                max={200}
                value={form.offsetX ?? 20}
                onChange={(e) => set('offsetX', e.target.value === '' ? undefined : Number(e.target.value))}
              />
              <span className="field-hint">啟動按鈕距左／右邊緣的距離，預設 20。</span>
            </div>

            <div className="field">
              <label className="field-label">距底部（px）</label>
              <input
                className="input"
                type="number"
                min={0}
                max={200}
                value={form.offsetY ?? 20}
                onChange={(e) => set('offsetY', e.target.value === '' ? undefined : Number(e.target.value))}
              />
              <span className="field-hint">距底部距離，預設 20；調高可避開頁面的 go-to-top 按鈕。</span>
            </div>

            <div className="field">
              <label className="field-label">預設語言</label>
              <select
                className="select"
                value={form.defaultLocale ?? ''}
                onChange={(e) => set('defaultLocale', e.target.value || undefined)}
              >
                <option value="">未設定（依使用者裝置）</option>
                {LOCALES.map((l) => (
                  <option key={l.v} value={l.v}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label">AI 名稱</label>
              <input
                className="input"
                value={form.assistantName ?? ''}
                onChange={(e) => set('assistantName', e.target.value)}
                maxLength={30}
                placeholder="AI 小幫手"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 18 }}>
            <label className="field-label">Logo URL</label>
            <input
              className="input"
              type="url"
              value={form.logoUrl ?? ''}
              onChange={(e) => set('logoUrl', e.target.value)}
              placeholder="https://…/logo.png"
            />
          </div>

          <div className="field">
            <label className="field-label">歡迎語</label>
            <input
              className="input"
              value={form.welcomeMessage ?? ''}
              onChange={(e) => set('welcomeMessage', e.target.value)}
              maxLength={200}
              placeholder="嗨！我可以協助你填寫表單。"
            />
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? '儲存中…' : '儲存外觀'}
            </button>
          </div>
        </div>
      </div>

      <div className="card preview-card">
        <div className="card-head">
          <div className="card-title">即時預覽</div>
          <a
            className="btn btn-ghost btn-sm"
            href={DEMO_SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            開啟示範網站 ↗
          </a>
        </div>
        <div className="card-body">
          <iframe
            ref={previewRef}
            title="widget-preview"
            src={previewSrc}
            className="preview-frame"
            onLoad={pushPreview}
          />
          <p className="field-hint" style={{ marginTop: 10 }}>
            預覽載入自 {PREVIEW_ORIGIN}。外觀會即時反映；按「儲存外觀」後才會真正生效。
          </p>
        </div>
      </div>
    </div>
  );
}
