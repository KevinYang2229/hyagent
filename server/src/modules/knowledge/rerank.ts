/**
 * LLM 重排（第二階段檢索）：向量取回候選池後，用便宜的 Haiku 對「問題 × 候選」聯合評分，
 * 挑出真正最相關的前 K 筆。cross-encoder 式的聯合判讀比純向量相似度精準得多。
 *
 * 失敗或關閉時回退第一階段（向量融合）排序，不中斷作答。
 */
import { env } from '@/config/env';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import type { KnowledgeChunk } from './retriever.types';

const SNIPPET_CHARS = 160;

const RERANK_SYSTEM = [
  '你是知識檢索的重排器，全程只輸出 JSON。',
  '給定「問題」與若干候選片段，依「能回答該問題的相關度」由高到低排序。',
  '只輸出候選編號的 JSON 陣列（最相關在前），例如 [3,1,4]；完全不相關的可省略，不要任何其他文字。',
].join('\n');

/**
 * 對候選片段重排，回傳前 topK 筆。
 * 候選數不多於 topK 時直接回傳（無需重排、省一次呼叫）。
 */
export async function rerankChunks(
  tenantId: string,
  query: string,
  chunks: KnowledgeChunk[],
  topK: number,
): Promise<KnowledgeChunk[]> {
  if (!env.KNOWLEDGE_RERANK || chunks.length <= topK) return chunks.slice(0, topK);

  const list = chunks
    .map((c, i) => `[${i}] ${c.title}：${c.content.slice(0, SNIPPET_CHARS)}`)
    .join('\n');
  try {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig, tenantId).createMessage({
      system: RERANK_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `問題：${query}\n\n候選：\n${list}` }] }],
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 128,
    });
    usageStore.recordLLMUsage(tenantId, result);
    const match = result.text.match(/\[[\s\S]*?\]/);
    if (!match) return chunks.slice(0, topK);
    const order = JSON.parse(match[0]) as unknown[];
    const picked = order
      .filter((n): n is number => typeof n === 'number' && n >= 0 && n < chunks.length)
      .map((n) => chunks[n]);
    // 尊重 reranker 取捨：判為不相關而省略的片段不補回（避免不相關內容硬進作答 LLM）。
    // reranker 全數剔除 → 回空，交由上層顯示「查無相關資料」。
    return picked.slice(0, topK);
  } catch (err) {
    logger.warn({ err }, 'knowledge rerank failed — 回退向量排序');
    return chunks.slice(0, topK);
  }
}
