/**
 * 數字輸入欄：可以正常打字（含刪空重打），也保留上下鍵微調。
 * 編輯中的內容以字串保存，失焦才定案成數字回報給外部——原因見 numberField.util.ts 的說明。
 */
import { useEffect, useState } from "react";
import { parseTypedNumber, settleNumber } from "./numberField.util";

interface NumberFieldProps {
  value: number;
  onChange: (next: number) => void;
  /** 上下限：請與 server 的 zod schema 對齊，失焦時會夾進範圍 */
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
}

export default function NumberField({
  value,
  onChange,
  min,
  max,
  disabled,
  className = "input",
}: NumberFieldProps) {
  const [text, setText] = useState(() => String(value));

  // 外部值變動（載入後端設定、切租戶）時同步顯示。
  // 打字造成的回報不會誤觸重寫：那時 text 解析出來就等於 value，維持使用者正在打的字面（如 '05'）。
  useEffect(() => {
    setText((cur) => (parseTypedNumber(cur) === value ? cur : String(value)));
  }, [value]);

  return (
    <input
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // 空字串／亂打先不回報，讓欄位留得住空值；失焦時再回落原值
        const n = parseTypedNumber(raw);
        if (n !== null) onChange(n);
      }}
      onBlur={() => {
        const n = settleNumber(text, { fallback: value, min, max });
        setText(String(n));
        if (n !== value) onChange(n);
      }}
    />
  );
}
