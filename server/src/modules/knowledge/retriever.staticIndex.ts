/**
 * 靜態索引檢索器：讀取 ingest 腳本產生的 knowledge-index.json，做記憶體內餘弦相似度檢索。
 *
 * 靜態網站專用——索引為一次性產出，查詢時只 embed「問題」一次，取 top-k 片段，
 * 整站內容永不進作答 LLM（省 token）。索引不存在時回空陣列，由服務退回 stub。
 * 每個租戶維護各自的索引快取，查詢向量使用索引建立時的模型。
 */
import { existsSync, readFileSync } from 'node:fs';
import { getEmbeddingProvider } from '@/lib/embedding';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { indexPathFor } from './index-path';
import type { KnowledgeIndexFile } from './knowledge-index.types';
import type { KnowledgeChunk, KnowledgeRetriever } from './retriever.types';

// 回傳候選池上限（供後續 LLM 重排挑最終前幾筆）；未開重排時消費端自行取前 K
const POOL_SIZE = 20;
const MIN_SCORE = 0.2; // 語意相似度過低者視為不相關，避免硬湊
const LEXICAL_BOOST = 0.15; // 每個命中的專有名詞/代碼加權（HyEIP、SpaceMe…）
const LEXICAL_BOOST_CAP = 0.45;

/** 取查詢中的 ASCII 專有名詞/產品代碼（≥2 字元），供 lexical 命中加權 */
function asciiTerms(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? []).map((t) => t.toLowerCase());
}

/** lexical 命中數：查詢中的專有名詞出現在 chunk 標題/內容者計數（大小寫不敏感） */
function lexicalHits(terms: string[], hay: string): number {
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

// 每個租戶維護一份快取（Map 存 null 代表已嘗試載入但不存在）
const cache = new Map<string, KnowledgeIndexFile | null>();

function loadIndex(tenantId: string): KnowledgeIndexFile | null {
  if (cache.has(tenantId)) return cache.get(tenantId) ?? null;
  const path = indexPathFor(tenantId);
  let idx: KnowledgeIndexFile | null = null;
  try {
    if (existsSync(path)) {
      idx = JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
      logger.info({ tenantId, chunks: idx.chunks.length }, 'knowledge index loaded');
    }
  } catch (err) {
    logger.warn({ err, tenantId }, 'knowledge index load failed');
    idx = null;
  }
  cache.set(tenantId, idx);
  return idx;
}

/** 測試用：注入指定租戶的索引並略過檔案讀取 */
export function _setIndexForTest(tenantId: string, idx: KnowledgeIndexFile | null): void {
  cache.set(tenantId, idx);
}

/** 清除指定租戶的索引快取（例如 ingest 後強制重載） */
export function invalidateIndexCache(tenantId: string): void {
  cache.delete(tenantId);
}

/** 是否已載入可用的靜態索引（供服務決定是否退回 stub） */
export function hasStaticIndex(tenantId: string): boolean {
  return (loadIndex(tenantId)?.chunks.length ?? 0) > 0;
}

export const staticIndexRetriever: KnowledgeRetriever = {
  name: 'static-index',
  async search(tenantId: string, query: string): Promise<KnowledgeChunk[]> {
    const idx = loadIndex(tenantId);
    const q = query.trim();
    if (!idx || idx.chunks.length === 0 || !q) return [];
    // 查詢向量必須用「索引建立時的模型」，避免維度/語意不一致
    const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
    const { vectors: [queryVec], tokens } = await embedder.embed([q], idx.model);
    usageStore.recordEmbeddingUsage(tenantId, tokens, idx.model, embedder.keySource);
    if (!queryVec) return [];
    // 混合檢索：語意相似度（dense）+ 專有名詞精確命中（lexical）融合
    const terms = asciiTerms(q);
    return idx.chunks
      .map((c) => {
        const cosine = cosineSimilarity(queryVec, c.vector);
        const hits = terms.length ? lexicalHits(terms, `${c.title}\n${c.text}`) : 0;
        const boost = Math.min(hits * LEXICAL_BOOST, LEXICAL_BOOST_CAP);
        return { id: c.id, title: c.title, content: c.text, url: c.url, cosine, hits, score: cosine + boost };
      })
      // 語意夠近，或有專有名詞精確命中（強訊號）即保留
      .filter((c) => c.cosine >= MIN_SCORE || c.hits > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL_SIZE)
      .map(({ id, title, content, url, score }) => ({ id, title, content, url, score }));
  },
};
