/**
 * 向量索引的持久化層：收斂原本散在 ingest.service / knowledge-file.service /
 * retriever.staticIndex 的三處讀寫。
 *
 * file 後端＝單一 JSON 檔（原行為）；db 後端＝knowledge_chunks + knowledge_indexes。
 * 語意固定為「整份載入 / 整份取代」，與原本的檔案覆寫一致，呼叫端邏輯不必改寫。
 *
 * 註：整份載入在 db 後端會把該租戶所有向量撈回（1.5k chunks 約 9MB）。
 * 這只發生在上傳檔／重爬／推薦詞生成等低頻路徑；查詢熱路徑走 retriever.pgvector 的
 * SQL top-k，永遠不會全量載入。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { indexPathFor } from './index-path';
import type { IndexedChunk, KnowledgeIndexFile } from './knowledge-index.types';
import { invalidatePgvectorModelCache } from './retriever.pgvector';
import { invalidateIndexCache } from './retriever.staticIndex';

/** 單次 INSERT 的最大列數：3072 維 × 200 列約 2.4MB statement，遠低於 Postgres 限制 */
export const CHUNK_INSERT_BATCH = 200;

/** number[] → pgvector 字面值（'[1,-0.5,0]'）。查詢與寫入共用，格式不可分歧 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** pgvector 回傳的字面值 → number[] */
function parseVectorLiteral(lit: string): number[] {
  const inner = lit.slice(1, -1);
  return inner ? inner.split(',').map(Number) : [];
}

// ---- file 後端 ----

function loadIndexFromFile(tenantId: string): KnowledgeIndexFile | null {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

function saveIndexToFile(tenantId: string, idx: KnowledgeIndexFile): void {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx), 'utf8');
}

/** 索引檔存在就刪；本來就不存在也視為成功（冪等） */
function deleteIndexFromFile(tenantId: string): void {
  const path = indexPathFor(tenantId);
  if (existsSync(path)) rmSync(path);
}

// ---- db 後端 ----

interface IndexMetaRow {
  generated_at: Date;
  model: string;
  source: string;
}

interface ChunkRow {
  id: string;
  url: string;
  title: string;
  text: string;
  file_id: string | null;
  embedding: string;
}

async function loadIndexFromDb(tenantId: string): Promise<KnowledgeIndexFile | null> {
  const db = await connectDb();
  const metaRows = await db.$queryRaw<IndexMetaRow[]>`
    select generated_at, model, source from knowledge_indexes where tenant_id = ${tenantId}
  `;
  const meta = metaRows[0];
  if (!meta) return null;
  const rows = await db.$queryRaw<ChunkRow[]>`
    select id, url, title, text, file_id, embedding::text as embedding
    from knowledge_chunks where tenant_id = ${tenantId}
  `;
  const chunks: IndexedChunk[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    text: r.text,
    vector: parseVectorLiteral(r.embedding),
    // file_id 為 null 代表網站來源；不設此欄以維持與 file 後端相同的物件形狀
    ...(r.file_id ? { fileId: r.file_id } : {}),
  }));
  return {
    generatedAt: meta.generated_at.toISOString(),
    model: meta.model,
    source: meta.source,
    chunks,
  };
}

/**
 * 整份取代：刪光該租戶 chunks 再分批寫入，最後 upsert 索引層級 metadata。
 * 不包 transaction——1470 列的交易會長時間持鎖，且失敗時的語意與 file 後端
 * （寫檔失敗即保留舊檔）本就不同；重跑 ingest 即可修復。
 */
async function saveIndexToDb(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  const db = await connectDb();
  await db.$executeRaw`delete from knowledge_chunks where tenant_id = ${tenantId}`;

  for (let i = 0; i < idx.chunks.length; i += CHUNK_INSERT_BATCH) {
    const batch = idx.chunks.slice(i, i + CHUNK_INSERT_BATCH);
    const values = batch.map(
      (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                        ${toVectorLiteral(c.vector)}::halfvec(3072))`,
    );
    await db.$executeRaw`
      insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, embedding)
      values ${Prisma.join(values)}
      on conflict (tenant_id, id) do update set
        url = excluded.url, title = excluded.title, text = excluded.text,
        file_id = excluded.file_id, embedding = excluded.embedding
    `;
  }

  await db.$executeRaw`
    insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
    values (${tenantId}, ${new Date(idx.generatedAt)}, ${idx.model}, ${idx.source}, now())
    on conflict (tenant_id) do update set
      generated_at = excluded.generated_at, model = excluded.model,
      source = excluded.source, updated_at = now()
  `;
}

/** 刪除該租戶在 knowledge_chunks／knowledge_indexes 兩張表中的所有列 */
async function deleteIndexFromDb(tenantId: string): Promise<void> {
  const db = await connectDb();
  await db.$executeRaw`delete from knowledge_chunks where tenant_id = ${tenantId}`;
  await db.$executeRaw`delete from knowledge_indexes where tenant_id = ${tenantId}`;
}

// ---- 對外介面 ----

/** 讀取整份索引；不存在回 null */
export async function loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null> {
  return env.DATA_BACKEND === 'db' ? loadIndexFromDb(tenantId) : loadIndexFromFile(tenantId);
}

/** 整份取代該租戶的索引；同時清 file 與 db 兩種檢索器的快取，避免任一邊撈到舊資料 */
export async function saveIndex(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  if (env.DATA_BACKEND === 'db') await saveIndexToDb(tenantId, idx);
  else saveIndexToFile(tenantId, idx);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}

/** 刪除該租戶整份索引；本來就不存在也視為成功（冪等） */
export async function deleteIndex(tenantId: string): Promise<void> {
  if (env.DATA_BACKEND === 'db') await deleteIndexFromDb(tenantId);
  else deleteIndexFromFile(tenantId);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}
