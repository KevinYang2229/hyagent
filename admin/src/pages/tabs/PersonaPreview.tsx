import { useEffect, useRef, useState } from "react";
import { PERSONA_SERVICES, type AssistantPersona, type KbRuleItem, type PersonaServiceKey } from "@hyagent/shared";
import { api } from "../../api";
import AudienceSwitch from "./AudienceSwitch";
import { sideHasRole, toPersonaPatch, type RulesDraft } from "./persona.util";

const DEBOUNCE_MS = 400;
type Locale = "zh-Hant" | "en";
type Result = { member: string[]; guest: string[]; rules: { member: KbRuleItem[]; guest: KbRuleItem[] } };

/**
 * AI 角色預覽：把還沒存檔的設定送到 server，由與真實對話相同的函式產生角色文字。
 * 角色區塊在上，平台規則（知識庫問答那套）可展開。預覽失敗只影響這一區，不影響編輯與存檔。
 */
export default function PersonaPreview({
  tenantId,
  persona,
  rules,
  notice,
}: {
  tenantId: string;
  persona: AssistantPersona;
  /** 知識庫規則草稿（尚未存檔）；不帶時 server 用已存的自訂 */
  rules?: RulesDraft;
  /** 草稿尚未儲存時的提醒，取代對象說明顯示在切換鈕下方 */
  notice?: string;
}) {
  const [locale, setLocale] = useState<Locale>("zh-Hant");
  const [service, setService] = useState<PersonaServiceKey>("knowledge");
  // 預覽對象：一次只顯示一側；API 一次回兩側，切換只換顯示、不重新取得
  const [side, setSide] = useState<"member" | "guest">("member");
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  // 遞增的請求序號：較早發出但較晚回來的回應直接丟棄，避免舊結果蓋掉新結果
  const latest = useRef(0);
  const patch = toPersonaPatch(persona);
  const patchKey = JSON.stringify(patch);
  const rulesKey = rules ? JSON.stringify(rules) : "";

  useEffect(() => {
    const timer = setTimeout(() => {
      const id = ++latest.current;
      Promise.resolve()
        .then(() =>
          api.previewPersona(tenantId, {
            assistantPersona: JSON.parse(patchKey),
            locale,
            service,
            ...(rulesKey ? { knowledgeAnswerRules: JSON.parse(rulesKey) } : {}),
          }),
        )
        .then((r) => {
          if (id !== latest.current) return;
          setResult(r ?? null);
          setFailed(false);
        })
        .catch(() => {
          if (id !== latest.current) return;
          setFailed(true);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tenantId, patchKey, rulesKey, locale, service]);

  return (
    <div className="persona-preview-block">
      {/* 與「設定」「知識庫規則」同一套：切換在最上方（右側語言），下面依序是功能、預覽內容、規則 */}
      <AudienceSwitch
        label="預覽對象"
        value={side}
        onChange={setSide}
        hint={notice ?? (side === "member" ? "已登入的公司員工會收到的指示。" : "未登入的訪客會收到的指示；不附知識庫出處。")}
        extra={
          <div className="seg-group" role="group" aria-label="預覽語言">
            {(["zh-Hant", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                className={`btn btn-sm ${locale === l ? "btn-primary" : "btn-ghost"}`}
                aria-pressed={locale === l}
                onClick={() => setLocale(l)}
              >
                {l === "en" ? "English" : "中文"}
              </button>
            ))}
          </div>
        }
      />
      <div className="field">
        <label className="field-label" htmlFor="persona-preview-service">功能</label>
        <select id="persona-preview-service" className="input" aria-label="預覽功能" value={service} onChange={(e) => setService(e.target.value as PersonaServiceKey)}>
          {PERSONA_SERVICES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>
      {failed ? (
        <p className="field-hint">預覽暫時無法產生</p>
      ) : (
        // 是否有角色看草稿本身、且依目前功能：有 AI 名稱時 server 每側都會回名稱句，不能用「有沒有行」判斷
        <PreviewBox
          key={side}
          lines={result?.[side]}
          rules={service === "knowledge" ? result?.rules[side] : null}
          hasRole={sideHasRole(patch[side], service)}
        />
      )}
    </div>
  );
}

function PreviewBox({ lines, rules, hasRole }: { lines?: string[]; rules?: KbRuleItem[] | null; hasRole: boolean }) {
  return (
    <>
      <div className="field">
        <span className="field-label">AI 收到的角色指示</span>
        {lines === undefined ? (
          <pre className="persona-preview">…</pre>
        ) : (
          <>
            {lines.length > 0 && <pre className="persona-preview">{lines.join("\n")}</pre>}
            {/* 沒選角色時：有 AI 名稱句就說明「只帶入名稱」，否則寫「維持預設行為」會跟上面那行看起來矛盾 */}
            {!hasRole && (
              <pre className="persona-preview">
                {lines.length > 0 ? "未選擇角色：只帶入 AI 名稱，不加角色描述" : "維持預設行為，不加角色指示"}
              </pre>
            )}
          </>
        )}
      </div>
      {lines !== undefined && (
        <div className="field">
          {rules === null ? (
            <span className="field-hint">此功能的平台規則不在預覽範圍；填表、代理等服務另有各自的規則。</span>
          ) : (
            <details className="persona-rules">
              <summary>展開知識庫規則（🔒 為不可修改的防護規則）</summary>
              <ul className="persona-preview persona-rules-list">
                {(rules ?? []).map((r, i) => (
                  <li key={i}>{r.locked ? `🔒 ${r.text}` : r.text}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </>
  );
}
