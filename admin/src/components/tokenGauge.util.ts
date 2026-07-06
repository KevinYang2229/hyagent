/** Token 錶盤純工具：動態刻度上限與 K/M 縮寫。無 React 相依，供單元測試。 */

/** {1,2,5}×10ⁿ 數列中「≥ target 的最小值」。target 必須 > 0。 */
function niceCeil(target: number): number {
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  // 含 10 的一輪吸收 log10 在整數次方的浮點誤差（如 log10(1000)=2.999…）
  for (const m of [1, 2, 5, 10]) {
    const candidate = m * base;
    if (candidate >= target) return candidate;
  }
  return 10 * base;
}

/**
 * 依目前累計 token 決定錶盤上限：
 * v<=0 → 1000；否則取 nice(v/0.8)，並統一套用 1000 下限
 * （token 很快破千，上限若為個/百位毫無意義）。
 */
export function niceGaugeMax(v: number): number {
  if (v <= 0) return 1000;
  return Math.max(1000, niceCeil(v / 0.8));
}

/** token 數→K/M 縮寫（去尾零、最多一位小數）：850→'850'、1500→'1.5K'、2_400_000→'2.4M'。 */
export function formatTokens(n: number): string {
  const trim = (x: number): string => parseFloat(x.toFixed(1)).toString();
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}K`;
  return `${trim(n / 1_000_000)}M`;
}
