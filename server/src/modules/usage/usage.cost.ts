/**
 * 用量 → 預估成本（讀取時計算，spec D4）。
 * platform key = 應向租戶收的錢；tenant key = 參考資訊（錢已直接付給 AI 廠商）。
 */
import { pricingFor } from '@/config/model-pricing';
import type { ModelTokenUsage, TenantUsage } from './usage.store';

export interface UsageCost {
  totalUsd: number;
  platformUsd: number;
  tenantUsd: number;
  byModel: Array<ModelTokenUsage & { usd: number | null }>;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function computeUsageCost(usage: TenantUsage): UsageCost {
  let platformUsd = 0;
  let tenantUsd = 0;
  const byModel = Object.values(usage.llmByModel).map((m) => {
    const price = pricingFor(m.model);
    if (!price) return { ...m, usd: null };
    const usd =
      (m.inputTokens * price.inputPerMTok +
        m.outputTokens * price.outputPerMTok +
        m.cacheReadTokens * price.cacheReadPerMTok) /
      1_000_000;
    if (m.keySource === 'platform') platformUsd += usd;
    else tenantUsd += usd;
    return { ...m, usd: round(usd) };
  });
  return {
    totalUsd: round(platformUsd + tenantUsd),
    platformUsd: round(platformUsd),
    tenantUsd: round(tenantUsd),
    byModel,
  };
}
