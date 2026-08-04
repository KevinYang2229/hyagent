/**
 * 檢索評分的共用公式：file 靜態索引與 pgvector 兩個 retriever 共用同一份，
 * 確保換後端不會悄悄改變排序與召回。常數即行為契約，改動請連同測試一起。
 */

/** 回傳候選池上限（供後續 LLM 重排挑最終前幾筆）；未開重排時消費端自行取前 K */
export const POOL_SIZE = 20;
/** 語意相似度過低者視為不相關，避免硬湊 */
export const MIN_SCORE = 0.2;
/** 每個命中的專有名詞/代碼加權（HyEIP、SpaceMe…） */
export const LEXICAL_BOOST = 0.15;
export const LEXICAL_BOOST_CAP = 0.45;

/** 取查詢中的 ASCII 專有名詞/產品代碼（≥2 字元），供 lexical 命中加權 */
export function asciiTerms(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? []).map((t) => t.toLowerCase());
}

/** lexical 命中數：查詢中的專有名詞出現在 chunk 標題/內容者計數（大小寫不敏感） */
export function lexicalHits(terms: string[], hay: string): number {
  const lower = hay.toLowerCase();
  return terms.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 混合檢索最終分數：語意相似度 + 專有名詞精確命中加權（有上限） */
export function scoreOf(cosine: number, hits: number): number {
  return cosine + Math.min(hits * LEXICAL_BOOST, LEXICAL_BOOST_CAP);
}

/** 保留條件：語意夠近「或」有專有名詞精確命中（強訊號）。注意是 or 不是 and */
export function keepChunk(cosine: number, hits: number): boolean {
  return cosine >= MIN_SCORE || hits > 0;
}
