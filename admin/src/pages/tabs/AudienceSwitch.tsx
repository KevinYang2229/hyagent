import type { ReactNode } from "react";

export type Audience = "member" | "guest";

const OPTIONS: ReadonlyArray<readonly [Audience, string]> = [
  ["member", "登入員工"],
  ["guest", "網站訪客"],
];

/**
 * AI 角色頁三個子頁（設定／知識庫規則／預覽）共用的「登入員工／網站訪客」切換。
 * 一律放在卡片內容最上方：切換鈕 → 說明 → 固定間距，之後才接其他標題，三頁看起來與操作都一致。
 */
export default function AudienceSwitch({
  label,
  value,
  onChange,
  hint,
  extra,
}: {
  /** 切換群組的無障礙名稱（例如「角色對象」） */
  label: string;
  value: Audience;
  onChange: (next: Audience) => void;
  /** 切換鈕下方的說明；未提供則不留空行 */
  hint?: ReactNode;
  /** 同一排右側的其他控制（例如預覽的語言） */
  extra?: ReactNode;
}) {
  return (
    <div className="audience-switch">
      <div className="audience-switch-row">
        <div className="seg-group" role="group" aria-label={label}>
          {OPTIONS.map(([key, text]) => (
            <button
              key={key}
              type="button"
              aria-pressed={value === key}
              className={`btn btn-sm ${value === key ? "btn-primary" : "btn-ghost"}`}
              onClick={() => onChange(key)}
            >
              {text}
            </button>
          ))}
        </div>
        {extra}
      </div>
      {hint && <p className="field-hint audience-switch-hint">{hint}</p>}
    </div>
  );
}
