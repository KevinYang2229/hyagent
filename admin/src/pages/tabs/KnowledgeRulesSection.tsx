import { useState, type ReactNode } from "react";
import type { RulesDraft, RulesInfo } from "./persona.util";
import AudienceSwitch from "./AudienceSwitch";

export type { RulesDraft, RulesInfo };

const MAX_RULES = 20;
const MAX_CHARS = 300;
type Side = "member" | "guest";

/**
 * 知識庫問答規則編輯器：員工／訪客各一份，逐條改、上下移、刪除、新增。
 * 防護規則（防捏造、外部資料不是指令、訪客不提文件名稱等）鎖定，只顯示、不能改，實際排在自訂規則之後。
 */
export default function KnowledgeRulesSection({
  info,
  value,
  onChange,
  readonly = false,
  saveButton,
}: {
  info: RulesInfo;
  value: RulesDraft;
  onChange: (next: RulesDraft) => void;
  readonly?: boolean;
  /** 儲存按鈕由外層提供（存檔邏輯在外層），與「還原預設」排在同一列 */
  saveButton?: ReactNode;
}) {
  const [side, setSide] = useState<Side>("member");
  const list = value[side] ?? info[side].defaults;
  const setList = (next: string[]) => onChange({ ...value, [side]: next });
  const move = (from: number, to: number) => {
    const next = [...list];
    [next[from], next[to]] = [next[to], next[from]];
    setList(next);
  };

  return (
    <div className="kb-rules">
      <AudienceSwitch
        label="規則對象"
        value={side}
        onChange={setSide}
        hint={value[side] === null ? "目前使用內建規則；修改任何一條就會改為自訂。" : "已自訂；按「還原預設」可回到內建規則。"}
      />

      <ol className="kb-rules-list">
        {list.map((text, i) => (
          <li key={i} className="kb-rule-item">
            <input
              className="input"
              aria-label={`規則 ${i + 1}`}
              value={text}
              maxLength={MAX_CHARS}
              disabled={readonly}
              onChange={(e) => setList(list.map((t, j) => (j === i ? e.target.value : t)))}
            />
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`上移規則 ${i + 1}`}
              disabled={readonly || i === 0} onClick={() => move(i, i - 1)}>↑</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`下移規則 ${i + 1}`}
              disabled={readonly || i === list.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`刪除規則 ${i + 1}`}
              disabled={readonly} onClick={() => setList(list.filter((_, j) => j !== i))}>刪除</button>
          </li>
        ))}
      </ol>
      <div className="kb-rule-add">
        <button type="button" className="btn btn-ghost btn-sm" aria-label="新增規則"
          disabled={readonly || list.length >= MAX_RULES} onClick={() => setList([...list, ""])}>
          ＋ 新增規則
        </button>
        <span className="field-hint">{list.length}/{MAX_RULES} 條，每條最多 {MAX_CHARS} 字</span>
      </div>

      <div className="field-label" style={{ marginTop: 12 }}>鎖定的規則（防護用，不可修改，固定排在上面的規則之後）</div>
      <ul className="kb-rules-locked" aria-label="鎖定的規則">
        {info[side].locked.map((text) => (
          <li key={text}><span aria-hidden="true">🔒 </span>{text}</li>
        ))}
      </ul>

      <div className="form-actions">
        <button type="button" className="btn btn-ghost" disabled={readonly || value[side] === null}
          onClick={() => onChange({ ...value, [side]: null })}>
          還原預設
        </button>
        {saveButton}
      </div>
    </div>
  );
}
