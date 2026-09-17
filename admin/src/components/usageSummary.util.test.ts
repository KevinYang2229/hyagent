import { describe, it, expect } from 'vitest';
import { recentMonths, tokenBreakdown } from './usageSummary.util';

describe('tokenBreakdown', () => {
  it('加總各模型並從輸入扣掉向量化', () => {
    const parts = tokenBreakdown({
      embeddingTokens: 300,
      llmByModel: {
        a: { model: 'a', keySource: 'platform', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 },
        e: { model: 'e', keySource: 'platform', inputTokens: 300, outputTokens: 0, cacheReadTokens: 0 },
      },
    });
    expect(parts.map((p) => p.value)).toEqual([1000, 200, 50, 300]);
  });
  it('沒有資料時全為 0', () => {
    expect(tokenBreakdown({}).every((p) => p.value === 0)).toBe(true);
  });
});

describe('recentMonths', () => {
  it('跨年往回取、舊到新、缺月補 0', () => {
    const now = new Date(Date.UTC(2026, 1, 15)); // 2026-02
    expect(recentMonths({ '2025-12': 5, '2026-02': 9 }, 4, now)).toEqual([
      { month: '2025-11', tokens: 0 },
      { month: '2025-12', tokens: 5 },
      { month: '2026-01', tokens: 0 },
      { month: '2026-02', tokens: 9 },
    ]);
  });
});
