import { usageStore } from '@/modules/usage/usage.store';
import { computeUsageCost } from '@/modules/usage/usage.cost';

const T = `usage-cost-test-${Date.now()}`; // 每次跑用新租戶 id，避免磁碟殘留干擾

describe('usage 按模型×key 來源聚合', () => {
  it('recordLLMUsage 聚合到 llmByModel，llmTokens 總數照舊累加', () => {
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 500, outputTokens: 100 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 400, outputTokens: 50 },
      model: 'gpt-4o',
      keySource: 'tenant',
    });

    const u = usageStore.get(T);
    expect(u.llmTokens).toBe(1000 + 200 + 300 + 500 + 100 + 400 + 50);
    expect(u.llmByModel['platform|claude-sonnet-4-5']).toEqual({
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 300,
    });
    expect(u.llmByModel['tenant|gpt-4o'].inputTokens).toBe(400);
  });

  it('recordEmbeddingUsage 累加 embeddingTokens 並進 llmByModel', () => {
    usageStore.recordEmbeddingUsage(T, 8000, 'text-embedding-3-large', 'platform');
    const u = usageStore.get(T);
    expect(u.embeddingTokens).toBe(8000);
    expect(u.llmByModel['platform|text-embedding-3-large'].inputTokens).toBe(8000);
  });

  it('無 usage 或 0 token 不寫入', () => {
    const before = JSON.stringify(usageStore.get(T));
    usageStore.recordLLMUsage(T, undefined);
    usageStore.recordLLMUsage(T, { usage: { inputTokens: 0, outputTokens: 0 } });
    expect(JSON.stringify(usageStore.get(T))).toBe(before);
  });
});

describe('computeUsageCost', () => {
  it('已知模型按單價表計價，平台/租戶分開加總', () => {
    const cost = computeUsageCost(usageStore.get(T));
    // claude-sonnet-4-5（platform）：in 1500*3 + out 300*15 + cache 300*0.3 = (4500+4500+90)/1e6
    const sonnet = cost.byModel.find((m) => m.model === 'claude-sonnet-4-5');
    expect(sonnet?.usd).toBeCloseTo((1500 * 3 + 300 * 15 + 300 * 0.3) / 1_000_000, 8);
    expect(cost.platformUsd).toBeGreaterThan(0);
    expect(cost.tenantUsd).toBeGreaterThan(0); // gpt-4o（tenant）
    expect(cost.totalUsd).toBeCloseTo(cost.platformUsd + cost.tenantUsd, 8);
  });

  it('未知模型 usd=null 且不計入總額', () => {
    const T2 = `usage-cost-unknown-${Date.now()}`;
    usageStore.recordLLMUsage(T2, {
      usage: { inputTokens: 100, outputTokens: 100 },
      model: 'some-unknown-model',
      keySource: 'platform',
    });
    const cost = computeUsageCost(usageStore.get(T2));
    expect(cost.byModel[0].usd).toBeNull();
    expect(cost.totalUsd).toBe(0);
  });

  it('recordLLMUsage 未帶 model（舊呼叫端防禦）→ 只加總數、不進 byModel', () => {
    const T3 = `usage-cost-nomodel-${Date.now()}`;
    usageStore.recordLLMUsage(T3, { usage: { inputTokens: 10, outputTokens: 5 } });
    const u = usageStore.get(T3);
    expect(u.llmTokens).toBe(15);
    expect(Object.keys(u.llmByModel)).toHaveLength(0);
  });
});
