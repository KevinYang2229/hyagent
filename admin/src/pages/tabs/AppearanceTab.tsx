import { useCallback, useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "../../components/unsaved";
import UnsavedBadge from "../../components/UnsavedBadge";
import type { TenantAppearance } from "@hyagent/shared";
import { api, type Tenant } from "../../api";
import { resolveDemoSiteUrl, resolvePreviewOrigin, resolvePrimaryColor } from "./appearance.util";

const POSITIONS = [
  { v: "br", label: "右下" },
  { v: "bl", label: "左下" },
  { v: "tr", label: "右上" },
  { v: "tl", label: "左上" },
] as const;

// 啟動按鈕尺寸；與 widget.js 的 VALID_SIZES 對應，只開放五段固定值
const LAUNCHER_SIZES = [40, 44, 48, 52, 56] as const;

// 介面支援語系（對應 client i18n：zh-Hant / en）
const LOCALES = [
  { v: "zh-Hant", label: "繁體中文" },
  { v: "en", label: "English" },
] as const;

// 預覽 widget client 來源；postMessage targetOrigin 與 iframe 來源一致。
// 部署時由 admin 服務的 runtime 環境變數 WIDGET_ORIGIN 指定（改了重啟即可），
// 其次為 build 時的 VITE_WIDGET_ORIGIN；都沒有時 dev 走本機 5173。
const DEV_PREVIEW_ORIGIN = "http://localhost:5173";
const PREVIEW_ORIGIN = resolvePreviewOrigin(
  window.__HYAGENT_ADMIN_CONFIG__?.widgetOrigin,
  import.meta.env.VITE_WIDGET_ORIGIN,
  DEV_PREVIEW_ORIGIN,
);
// 公開後台卻落到本機預設：瀏覽器會擋（連到私有網段），提示管理員去設定
const PREVIEW_MISCONFIGURED =
  PREVIEW_ORIGIN === DEV_PREVIEW_ORIGIN && !["localhost", "127.0.0.1"].includes(window.location.hostname);

// 「開啟示範網站」按鈕的外部網址：runtime 的 DEMO_SITE_URL → build 時的 VITE_DEMO_SITE_URL → Hyweb OA 示範站。
const DEMO_SITE_URL = resolveDemoSiteUrl(
  window.__HYAGENT_ADMIN_CONFIG__?.demoSiteUrl,
  import.meta.env.VITE_DEMO_SITE_URL,
  "https://hyweb-oa-react-five.vercel.app",
);

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

  // 未儲存判斷：忽略值為空的欄位與鍵的順序（清空欄位與從未設定視為相同）
  const normalized = (a: TenantAppearance) => JSON.stringify(
    Object.entries(a).filter(([, v]) => v !== undefined && v !== '').sort(([x], [y]) => x.localeCompare(y)),
  );
  const dirty = normalized(form) !== normalized(tenant.appearance ?? {});
  useUnsavedChanges('外觀', dirty);

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
      { source: "oa-admin-preview", appearance: form },
      PREVIEW_ORIGIN,
    );
  }, [form]);

  // 表單任一欄位變更 → 即時推送到預覽
  useEffect(() => pushPreview(), [pushPreview]);

  // 預覽 client 載入完成會發 ready 握手；收到後補推一次目前狀態（避免時序競態）
  useEffect(() => {
    function onReady(e: MessageEvent) {
      if ((e.data as { source?: string } | null)?.source === "oa-widget-ready")
        pushPreview();
    }
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [pushPreview]);

  // 色票與右側即時預覽必須同一個來源：未設定主色時 widget 用的是設計系統預設
  // （依主題 light/dark 不同），後台不能自己另外寫死一個值，否則一重整就對不起來。
  const primary = resolvePrimaryColor(form);

  return (
    <div className="appearance-grid">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">聊天視窗外觀<UnsavedBadge dirty={dirty} /></div>
            <div className="card-desc">
              儲存後套用到此租戶的聊天視窗。若網站的嵌入碼另外指定了外觀參數（data-*），以嵌入碼為準。
            </div>
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
                  onChange={(e) => set("primaryColor", e.target.value)}
                />
                <span className="color-hex">{primary.toUpperCase()}</span>
              </div>
            </div>

            <div className="field">
              <label className="field-label">主題</label>
              <select
                className="select"
                value={form.theme ?? "light"}
                onChange={(e) =>
                  set("theme", e.target.value as TenantAppearance["theme"])
                }
              >
                <option value="light">淺色</option>
                <option value="dark">深色</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label">啟動按鈕位置</label>
              <select
                className="select"
                value={form.position ?? "br"}
                onChange={(e) =>
                  set(
                    "position",
                    e.target.value as TenantAppearance["position"],
                  )
                }
              >
                {POSITIONS.map((p) => (
                  <option key={p.v} value={p.v}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label">啟動按鈕尺寸</label>
              <select
                className="select"
                value={form.launcherSize ?? 56}
                onChange={(e) =>
                  set(
                    "launcherSize",
                    Number(e.target.value) as TenantAppearance["launcherSize"],
                  )
                }
              >
                {LAUNCHER_SIZES.map((sz) => (
                  <option key={sz} value={sz}>
                    {sz}px
                  </option>
                ))}
              </select>
              <span className="field-hint">
                浮動按鈕的直徑，預設 56px；icon 會等比例縮放。
              </span>
            </div>

            <div className="field">
              <label className="field-label">距側邊（px）</label>
              <input
                className="input"
                type="number"
                min={0}
                max={200}
                value={form.offsetX ?? 20}
                onChange={(e) =>
                  set(
                    "offsetX",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
              <span className="field-hint">
                啟動按鈕距左／右邊緣的距離，預設 20。
              </span>
            </div>

            <div className="field">
              <label className="field-label">距上／下緣（px）</label>
              <input
                className="input"
                type="number"
                min={0}
                max={200}
                value={form.offsetY ?? 20}
                onChange={(e) =>
                  set(
                    "offsetY",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
              <span className="field-hint">
                距下緣（右下／左下）或上緣（右上／左上）的距離，預設 20；調高可避開頁面的
                go-to-top 按鈕。
              </span>
            </div>

            <div className="field">
              <label className="field-label">預設語言</label>
              <select
                className="select"
                value={form.defaultLocale ?? ""}
                onChange={(e) =>
                  set("defaultLocale", e.target.value || undefined)
                }
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
                value={form.assistantName ?? ""}
                onChange={(e) => set("assistantName", e.target.value)}
                maxLength={30}
                placeholder="AI 小幫手"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">Logo URL</label>
            <input
              className="input"
              type="url"
              value={form.logoUrl ?? ""}
              onChange={(e) => set("logoUrl", e.target.value)}
              placeholder="https://…/logo.png"
            />
          </div>

          <div className="field">
            <label className="field-label">歡迎語</label>
            <input
              className="input"
              value={form.welcomeMessage ?? ""}
              onChange={(e) => set("welcomeMessage", e.target.value)}
              maxLength={200}
              placeholder="嗨！我可以協助你填寫表單。"
            />
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "儲存中…" : "儲存外觀"}
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
            預覽載入自 {PREVIEW_ORIGIN}
            。外觀會即時反映；按「儲存外觀」後才會真正生效。
            {PREVIEW_MISCONFIGURED && (
              <>
                <br />
                尚未設定預覽網址：請在 admin 服務的環境變數設定 WIDGET_ORIGIN 為 client 服務網址，重新啟動後生效。
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
