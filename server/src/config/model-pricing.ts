/**
 * 模型單價表（USD / 每百萬 token）。成本在「讀取時」計算、不落地——改價免重算歷史。
 * 未列出的模型視為無單價（usd: null），UI 標示「無單價資料」。
 * 來源：各家官方定價頁；cacheRead 為 prompt cache 讀取價（Anthropic 為 input 的 10%）。
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  'text-embedding-3-large': { inputPerMTok: 0.13, outputPerMTok: 0, cacheReadPerMTok: 0 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0, cacheReadPerMTok: 0 },
};
