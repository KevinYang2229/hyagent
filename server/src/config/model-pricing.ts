/**
 * 模型單價表（USD / 每百萬 token）。成本在「讀取時」計算、不落地——改價免重算歷史。
 * 未列出的模型視為無單價（usd: null），UI 標示「無單價資料」。
 * 來源：各家官方定價頁；cacheRead 為 prompt cache 讀取價（Anthropic 為 input 的 10%）。
 *
 * 表以「別名（不帶日期）」為 key，如 claude-haiku-4-5。同一模型的日期快照
 * （claude-haiku-4-5-20251001、gpt-4o-2024-08-06…）與別名同價，查表由 pricingFor
 * 去掉尾端日期後對應，故快照不需在此重列。
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  'text-embedding-3-large': { inputPerMTok: 0.13, outputPerMTok: 0, cacheReadPerMTok: 0 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0, cacheReadPerMTok: 0 },
};

/** 去掉尾端日期快照後綴：-YYYYMMDD（Anthropic）或 -YYYY-MM-DD（OpenAI） */
function stripDateSuffix(model: string): string {
  return model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

/**
 * 查模型單價：先精確比對，再退而以「去掉日期快照後綴的別名」比對。
 * 讓 claude-haiku-4-5 與 claude-haiku-4-5-20251001 對到同一價，避免同模型別名/快照
 * 分別記帳時其一顯示「無單價資料」。查無則回 undefined（UI 標無單價）。
 */
export function pricingFor(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model] ?? MODEL_PRICING[stripDateSuffix(model)];
}
