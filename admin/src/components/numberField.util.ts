/**
 * NumberField 的兩個純函式：打字中的解析、失焦時的定案。
 *
 * 為什麼需要它們——受控 <input type="number"> 直接寫 value={n} / onChange={Number(...)} 會壞：
 * 使用者刪空欄位時 Number('') 是 0，0 被寫回欄位；而 React 對 type=number 是用寬鬆比較
 * （node.value != props.value）決定要不要改 DOM，'05' == 5 成立，所以前導 0 永遠不會被清掉，
 * 越打越長（'0' → '05' → '050'）。結果就是欄位實質上只能用上下鍵微調。
 * 解法是編輯中保留字串、空值不回報，失焦才定案。
 */

/**
 * 打字中的內容 → 要回報給外部的數值。
 * 回 null 代表「這串還不是有效數字」（空白或亂打），此時外部值維持不動，
 * 欄位才留得住空字串讓使用者重打。
 */
export function parseTypedNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 失焦時定案：空白／亂打回落 fallback（欄位原值），並取整、夾到上下限。
 * 上下限要跟 server 的 zod schema 一致，避免使用者以為存好了卻被後端 400 退回。
 * 只在失焦時夾，不在打字時夾——否則往 200 打的過程中，第一個字 '2' 就會被夾成 200。
 */
export function settleNumber(
  raw: string,
  opts: { fallback: number; min?: number; max?: number },
): number {
  const parsed = parseTypedNumber(raw);
  let n = Math.round(parsed ?? opts.fallback);
  if (opts.min !== undefined) n = Math.max(opts.min, n);
  if (opts.max !== undefined) n = Math.min(opts.max, n);
  return n;
}
