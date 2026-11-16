import { useEffect, useRef, useState } from "react";
import { PERSONA_SERVICES, type AssistantPersona, type KbRuleItem, type PersonaServiceKey } from "@hyagent/shared";
import { api } from "../../api";
import { toPersonaPatch, type RulesDraft } from "./persona.util";

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
}: {
  tenantId: string;
  persona: AssistantPersona;
  /** 知識庫規則草稿（尚未存檔）；不帶時 server 用已存的自訂 */
  rules?: RulesDraft;
}) {
  const [locale, setLocale] = useState<Locale>("zh-Hant");
  const [service, setService] = useState<PersonaServiceKey>("knowledge");
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
    <div className="persona-preview-block" style={{ marginTop: 20 }}>
      <div className="persona-preview-head">
        <div className="persona-preview-title">
          <span className="field-label">預覽（AI 實際收到的角色指示）</span>
          <select className="input" aria-label="預覽功能" value={service} onChange={(e) => setService(e.target.value as PersonaServiceKey)}>
            {PERSONA_SERVICES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>
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
      </div>
      {failed ? (
        <p className="field-hint">預覽暫時無法產生</p>
      ) : (
        <>
          {/* 是否有角色看草稿本身：有 AI 名稱時 server 每側都會回名稱句，不能用「有沒有行」判斷 */}
          <PreviewBox title="登入員工" lines={result?.member} rules={service === "knowledge" ? result?.rules.member : null} hasRole={patch.member !== null} />
          <PreviewBox title="網站訪客" lines={result?.guest} rules={service === "knowledge" ? result?.rules.guest : null} hasRole={patch.guest !== null} />
          {service === "knowledge" && <p className="field-hint">填表、代理等服務另有各自的規則。</p>}
        </>
      )}
    </div>
  );
}

function PreviewBox({ title, lines, rules, hasRole }: { title: string; lines?: string[]; rules?: KbRuleItem[] | null; hasRole: boolean }) {
  return (
    <div className="field" style={{ marginTop: 8 }}>
      <div className="field-hint">{title}</div>
      {lines === undefined ? (
        <pre className="persona-preview">…</pre>
      ) : (
        <>
          {lines.length > 0 && <pre className="persona-preview">{lines.join("\n")}</pre>}
          {!hasRole && <pre className="persona-preview">維持預設行為，不加角色指示</pre>}
          {rules === null ? (
            <div className="field-hint">此功能的平台規則不在預覽範圍</div>
          ) : (
          <details className="persona-rules">
            <summary>展開平台規則（知識庫問答，不可修改）</summary>
            <ul className="persona-preview persona-rules-list">
              {(rules ?? []).map((r, i) => (
                <li key={i}>{r.locked ? `🔒 ${r.text}` : r.text}</li>
              ))}
            </ul>
          </details>
          )}
        </>
      )}
    </div>
  );
}
