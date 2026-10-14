/**
 * pgvector 檢索器：在資料庫端取 top-k 候選，只把候選帶回 Node。
 *
 * 與 retriever.staticIndex 的差別只在「候選從哪來」——評分、加權、保留條件
 * 全部共用 retriever.scoring，確保換後端不改變召回與排序。
 *
 * 兩路候選以一次 union 查詢取得，兩路都以餘弦距離排序後截斷：
 *   dense   —— 全租戶列中 cosine 最好的 POOL_SIZE 筆
 *   lexical —— 專有名詞字面命中之中 cosine 最好的 LEXICAL_LIMIT 筆
 * 缺了 lexical 這路，「語意遠但精確命中產品代碼」的片段會被 dense 的 top-k 直接截掉，
 * 那是靜默的檢索退化——此行為有專門的回歸測試看守。
 *
 * 兩路都走精確掃描（seq scan + 排序），不走 ANN 索引：0005 建的 HNSW 沒有 tenant
 * 區分欄，pgvector 的 post-filter 會讓小租戶幾乎撈不到自己的列，已於 0006 移除。
 * 現況資料量（單租戶最多約 1.5k 列）精確掃描是個位數毫秒，且結果完全正確。
 */
import { Prisma } from '@prisma/client';
import { getEmbeddingProvider } from '@/lib/embedding';
import { connectDb } from '@/lib/db';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { toVectorLiteral } from './knowledge.index.repo';
import { visibilityScopesOf } from './knowledge.visibility';
import { asciiTerms, keepChunk, lexicalHits, POOL_SIZE, scoreOf } from './retriever.scoring';
import type { KnowledgeChunk, KnowledgeRetriever, RetrievalPrincipal } from './retriever.types';

/** lexical 那一路的取回上限：只為補 dense top-k 漏掉的精確命中，不必無限制 */
const LEXICAL_LIMIT = 50;

interface CandidateRow {
  id: string;
  url: string;
  title: string;
  text: string;
  cosine: number;
}

/**
 * 每租戶快取索引模型：agent-service 每回合會先 hasPgvectorIndex 再 search，
 * 兩者都要知道模型才能動作，若各自查一次 knowledge_indexes 就是每回合兩次網路往返。
 * 快取 null 也代表「已查過、目前無索引」，同樣要在重建/刪除索引時失效，
 * 否則剛建好索引的租戶會繼續被誤判成沒有索引。
 */
const modelCache = new Map<string, { model: string | null; at: number }>();

/**
 * 快取存活時間。invalidatePgvectorModelCache 只清得掉「本行程」的快取，但 db 模式下
 * 資料是跨機器共享的：A 機重建索引後，B 機的快取沒有任何人會去清。最糟的是快取住 null
 * 的情形——剛建好第一份索引的租戶，凡是落到 B 機的請求會永遠拿到「查無相關資料」，
 * 直到重啟為止，而且從 admin 面板重現不出來。用短 TTL 讓這種歪斜自己收斂。
 */
const MODEL_CACHE_TTL_MS = 60_000;

/** 該租戶索引所用的 embedding 模型；未建索引回 null（有快取，見 invalidatePgvectorModelCache） */
async function indexModelOf(tenantId: string): Promise<string | null> {
  const cached = modelCache.get(tenantId);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.model;
  const db = await connectDb();
  const rows = await db.$queryRaw<{ model: string }[]>`
    select model from knowledge_indexes where tenant_id = ${tenantId}
  `;
  const model = rows[0]?.model ?? null;
  modelCache.set(tenantId, { model, at: Date.now() });
  return model;
}

/**
 * 索引重建或刪除後使快取失效，避免撈到舊模型（維度或語意不一致會讓檢索整個壞掉）。
 * 由 knowledge.index.repo 的 saveIndex/deleteIndex 掛勾呼叫；測試也用它重置快取。
 */
export function invalidatePgvectorModelCache(tenantId: string): void {
  modelCache.delete(tenantId);
}

/** 是否已建立可用的 pgvector 索引（供服務決定是否退回 stub） */
export async function hasPgvectorIndex(tenantId: string): Promise<boolean> {
  return (await indexModelOf(tenantId)) !== null;
}

export const pgvectorRetriever: KnowledgeRetriever = {
  name: 'pgvector',
  async search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]> {
    const { tenantId } = principal;
    const q = query.trim();
    if (!q) return [];

    // 查詢向量必須用「索引建立時的模型」，避免維度/語意不一致
    const model = await indexModelOf(tenantId);
    if (!model) return [];

    const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig, tenantId);
    const { vectors: [queryVec], tokens } = await embedder.embed([q], model);
    usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
    if (!queryVec) return [];

    const terms = asciiTerms(q);
    const vec = toVectorLiteral(queryVec);
    const db = await connectDb();

    /**
     * 可見性條件必須與 tenant_id 並排（pre-filter），不可撈回 Node 再濾。
     * POOL_SIZE=20，post-filter 會讓權限窄的使用者候選池被無權 chunk 佔滿而濾剩零筆
     * ——與 0006 移除 HNSW 索引時記載的 post-filter 問題是同一個。
     */
    const visible = Prisma.sql`and visibility_scopes && ${visibilityScopesOf(principal)}::text[]`;

    // lexical 沒有詞可比對時只跑 dense 那一路，省一次全租戶掃描。
    // order by 不可省：asciiTerms 會抽出任何 ≥2 字元的 ASCII token，像「HyEIP 的請假流程」
    // 在整站都在講 HyEIP 的租戶上會命中好幾百列（英文問句更是幾乎命中整個語料庫）。
    // 沒有 order by 時 Postgres 就在實體掃描順序下取前 50 停手——這 50 列全都 hits > 0，
    // 會無條件通過 keepChunk、各自拿到最多 +0.45 加權，再去擠掉 dense 真正相關的候選。
    // 重排（FINAL_K）丟得掉爛候選，卻救不回從來沒進候選池的好候選。
    // 排序後語意才是「lexical 命中之中 cosine 最好的 50 筆」——確定且可重現。
    const lexicalBranch = terms.length
      ? Prisma.sql`
          union
          (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
           from knowledge_chunks
           where tenant_id = ${tenantId}
             ${visible}
             and (lower(title) like any(${terms.map((t) => `%${t}%`)}::text[])
               or lower(text)  like any(${terms.map((t) => `%${t}%`)}::text[]))
           order by embedding <=> ${vec}::halfvec(3072)
           limit ${LEXICAL_LIMIT})`
      : Prisma.empty;

    const rows = await db.$queryRaw<CandidateRow[]>`
      (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
       from knowledge_chunks
       where tenant_id = ${tenantId}
         ${visible}
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
