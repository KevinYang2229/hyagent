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
import { aclModeOf, visibilityScopesOf, currentChunkScopes } from './knowledge.visibility';
import type { KnowledgeIndexFile } from './knowledge-index.types';
import {
  asciiTerms,
  cosineSimilarity,
  keepChunk,
  lexicalHits,
  POOL_SIZE,
  scoreOf,
} from './retriever.scoring';
import type { KnowledgeChunk, KnowledgeRetriever, RetrievalPrincipal } from './retriever.types';

// knowledge-rag.test.ts 由本模組 import cosineSimilarity，維持既有匯出路徑
export { cosineSimilarity };

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
  async search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]> {
    const { tenantId } = principal;
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
    // file 後端須與 db 行為一致，否則權限邏輯永遠沒被日常開發驗證
    const visible = aclModeOf(tenantId) === 'on' ? new Set(visibilityScopesOf(principal)) : null;
    const candidates = idx.chunks.filter(
      (c) => !visible || currentChunkScopes(tenantId, c).some((s) => visible.has(s)),
    );
    return candidates
      .map((c) => {
        const cosine = cosineSimilarity(queryVec, c.vector);
        const hits = terms.length ? lexicalHits(terms, `${c.title}\n${c.text}`) : 0;
        return { id: c.id, title: c.title, content: c.text, url: c.url, cosine, hits, score: scoreOf(cosine, hits) };
      })
      .filter((c) => keepChunk(c.cosine, c.hits))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL_SIZE)
      .map(({ id, title, content, url, score }) => ({ id, title, content, url, score }));
  },
};
