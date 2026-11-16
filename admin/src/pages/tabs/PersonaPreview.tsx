import { useEffect, useRef, useState } from "react";
import type { AssistantPersona } from "@hyagent/shared";
import { api } from "../../api";
import { toPersonaPatch } from "./persona.util";

const DEBOUNCE_MS = 400;
type Locale = "zh-Hant" | "en";
type Result = { member: string[]; guest: string[] };

/**
 * AI 角色預覽：把還沒存檔的設定送到 server，由與真實對話相同的函式產生角色文字。
 * 只顯示角色區塊；平台規則以一行說明帶過。預覽失敗只影響這一區，不影響編輯與存檔。
 */
export default function PersonaPreview({ tenantId, persona }: { tenantId: string; persona: AssistantPersona }) {
  const [locale, setLocale] = useState<Locale>("zh-Hant");
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  // 遞增的請求序號：較早發出但較晚回來的回應直接丟棄，避免舊結果蓋掉新結果
  const latest = useRef(0);
  const patchKey = JSON.stringify(toPersonaPatch(persona));

  useEffect(() => {
    const timer = setTimeout(() => {
      const id = ++latest.current;
      Promise.resolve()
        .then(() => api.previewPersona(tenantId, { assistantPersona: JSON.parse(patchKey), locale }))
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
  }, [tenantId, patchKey, locale]);

  return (
    <div className="persona-preview-block" style={{ marginTop: 20 }}>
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <div className="field-label">預覽（AI 實際收到的角色指示）</div>
        <div className="row" role="group" aria-label="預覽語言" style={{ gap: 4 }}>
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
          <PreviewBox title="登入員工" lines={result?.member} rulesNote="⋯ 以下接平台規則（不得捏造、寫入需確認等），不可修改" />
          <PreviewBox title="網站訪客" lines={result?.guest} rulesNote="⋯ 以下接平台規則；訪客的回答不附知識庫出處" />
        </>
      )}
    </div>
  );
}

function PreviewBox({ title, lines, rulesNote }: { title: string; lines?: string[]; rulesNote: string }) {
  return (
    <div className="field" style={{ marginTop: 8 }}>
      <div className="field-hint">{title}</div>
      {lines === undefined ? (
        <pre className="persona-preview">…</pre>
      ) : lines.length === 0 ? (
        <pre className="persona-preview">維持預設行為，不加角色指示</pre>
      ) : (
        <>
          <pre className="persona-preview">{lines.join("\n")}</pre>
          <div className="field-hint">{rulesNote}</div>
        </>
      )}
    </div>
  );
}
