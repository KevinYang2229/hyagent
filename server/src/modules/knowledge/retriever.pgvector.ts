/**
 * pgvector 檢索器：以 HNSW 索引在資料庫端取 top-k，只把候選帶回 Node。
 *
 * 與 retriever.staticIndex 的差別只在「候選從哪來」——評分、加權、保留條件
 * 全部共用 retriever.scoring，確保換後端不改變召回與排序。
 *
 * 兩路候選以一次 union 查詢取得：
 *   dense   —— order by embedding <=> $vec limit POOL_SIZE（走 HNSW 索引）
 *   lexical —— 專有名詞字面命中（走 tenant_id 索引後掃該租戶列）
 * 缺了 lexical 這路，「語意遠但精確命中產品代碼」的片段會被 ANN 直接截掉，
 * 那是靜默的檢索退化——此行為有專門的回歸測試看守。
 */
import { Prisma } from '@prisma/client';
import { getEmbeddingProvider } from '@/lib/embedding';
import { connectDb } from '@/lib/db';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { toVectorLiteral } from './knowledge.index.repo';
import { asciiTerms, keepChunk, lexicalHits, POOL_SIZE, scoreOf } from './retriever.scoring';
import type { KnowledgeChunk, KnowledgeRetriever } from './retriever.types';

/** lexical 那一路的取回上限：只為補 ANN 漏掉的精確命中，不必無限制 */
const LEXICAL_LIMIT = 50;

interface CandidateRow {
  id: string;
  url: string;
  title: string;
  text: string;
  cosine: number;
}

/** 該租戶索引所用的 embedding 模型；未建索引回 null */
async function indexModelOf(tenantId: string): Promise<string | null> {
  const db = await connectDb();
  const rows = await db.$queryRaw<{ model: string }[]>`
    select model from knowledge_indexes where tenant_id = ${tenantId}
  `;
  return rows[0]?.model ?? null;
}

/** 是否已建立可用的 pgvector 索引（供服務決定是否退回 stub） */
export async function hasPgvectorIndex(tenantId: string): Promise<boolean> {
  return (await indexModelOf(tenantId)) !== null;
}

export const pgvectorRetriever: KnowledgeRetriever = {
  name: 'pgvector',
  async search(tenantId: string, query: string): Promise<KnowledgeChunk[]> {
    const q = query.trim();
    if (!q) return [];

    // 查詢向量必須用「索引建立時的模型」，避免維度/語意不一致
    const model = await indexModelOf(tenantId);
    if (!model) return [];

    const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
    const { vectors: [queryVec], tokens } = await embedder.embed([q], model);
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
    if (!queryVec) return [];

    const terms = asciiTerms(q);
    const vec = toVectorLiteral(queryVec);
    const db = await connectDb();

    // lexical 沒有詞可比對時只跑 dense 那一路，省一次全租戶掃描
    const lexicalBranch = terms.length
      ? Prisma.sql`
          union
          (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
           from knowledge_chunks
           where tenant_id = ${tenantId}
             and (lower(title) like any(${terms.map((t) => `%${t}%`)}::text[])
               or lower(text)  like any(${terms.map((t) => `%${t}%`)}::text[]))
           limit ${LEXICAL_LIMIT})`
      : Prisma.empty;

    const rows = await db.$queryRaw<CandidateRow[]>`
      (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
       from knowledge_chunks
       where tenant_id = ${tenantId}
       order by embedding <=> ${vec}::halfvec(3072)
       limit ${POOL_SIZE})
      ${lexicalBranch}
    `;

    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .map((r) => {
        const cosine = Number(r.cosine);
        const hits = terms.length ? lexicalHits(terms, `${r.title}\n${r.text}`) : 0;
        return { id: r.id, title: r.title, content: r.text, url: r.url, cosine, hits, score: scoreOf(cosine, hits) };
      })
      .filter((c) => keepChunk(c.cosine, c.hits))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL_SIZE)
      .map(({ id, title, content, url, score }) => ({ id, title, content, url, score }));
  },
};
