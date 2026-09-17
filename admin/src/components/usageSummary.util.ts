/** 用量頁摘要純工具：Token 組成拆分、近 N 月趨勢。無 React 相依，供單元測試。 */
import type { Usage } from '../api';

export interface TokenPart {
  key: 'input' | 'output' | 'cache' | 'embedding';
  label: string;
  value: number;
}

/**
 * 累計 Token 拆成 輸入 / 輸出 / Cache 讀取 / 向量化。
 * 後端把 embedding 也記進 llmByModel 的 inputTokens，這裡扣回來避免重複計算。
 */
export function tokenBreakdown(usage: Pick<Usage, 'llmByModel' | 'embeddingTokens'>): TokenPart[] {
  const buckets = Object.values(usage.llmByModel ?? {});
  const sum = (pick: (b: (typeof buckets)[number]) => number) => buckets.reduce((acc, b) => acc + pick(b), 0);
  const embedding = usage.embeddingTokens ?? 0;
  return [
    { key: 'input', label: '輸入', value: Math.max(0, sum((b) => b.inputTokens) - embedding) },
    { key: 'output', label: '輸出', value: sum((b) => b.outputTokens) },
    { key: 'cache', label: 'Cache 讀取', value: sum((b) => b.cacheReadTokens) },
    { key: 'embedding', label: '向量化', value: embedding },
  ];
}

/** 以 now 所在月份（UTC，與後端 monthKey 一致）往回取 count 個月，舊→新，缺月補 0。 */
export function recentMonths(
  monthly: Record<string, number> | undefined,
  count: number,
  now = new Date(),
): { month: string; tokens: number }[] {
  const out: { month: string; tokens: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const month = d.toISOString().slice(0, 7);
    out.push({ month, tokens: monthly?.[month] ?? 0 });
  }
  return out;
}
