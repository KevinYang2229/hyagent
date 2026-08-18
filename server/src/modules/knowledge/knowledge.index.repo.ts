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
import { logger } from '@/lib/logger';
import { indexPathFor } from './index-path';
import type {
  IndexedChunk,
  KnowledgeIndexFile,
  KnowledgeIndexMetaOnly,
  KnowledgeIndexText,
} from './knowledge-index.types';
import { deleteTablesByTenant } from './knowledge.tables.repo';
import type { SourceKey } from './prompt-slots';
import { invalidatePgvectorModelCache } from './retriever.pgvector';
import { invalidateIndexCache } from './retriever.staticIndex';

/** 單次 INSERT 的最大列數：3072 維 × 200 列約 2.4MB statement，遠低於 Postgres 限制 */
export const CHUNK_INSERT_BATCH = 200;

/** 依來源別的 chunk 計數；對應 KnowledgeIndexMeta.chunkCountBySource */
export type ChunkCounts = Record<SourceKey, number>;

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

/**
 * file 後端的附加：JSON 單檔無法點狀更新，仍為 read-modify-write。
 * 該模式下不存在跨 process 寫入者（server 與 watcher 不共用檔案系統），故可接受。
 */
function appendChunksToFile(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): void {
  const existing = loadIndexFromFile(tenantId);
  saveIndexToFile(
    tenantId,
    existing
      ? { ...existing, generatedAt: new Date().toISOString(), chunks: [...existing.chunks, ...chunks] }
      : { generatedAt: new Date().toISOString(), model: meta.model, source: meta.source, chunks },
  );
}

/** file 後端的點狀刪除；該 fileId 沒有任何 chunk 時回 false 且不寫檔 */
function removeFileChunksFromFile(tenantId: string, fileId: string): boolean {
  const existing = loadIndexFromFile(tenantId);
  if (!existing) return false;
  const chunks = existing.chunks.filter((c) => c.fileId !== fileId);
  if (chunks.length === existing.chunks.length) return false;
  saveIndexToFile(tenantId, { ...existing, generatedAt: new Date().toISOString(), chunks });
  return true;
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
 * 只讀索引層級 metadata：knowledge_indexes 的單列，不碰 knowledge_chunks。
 *
 * 「取 model/source」是 ingestFile 與 preflight 唯一需要的東西，而它們原本走 loadIndex——
 * 為了兩個字串把整份向量拖過網路。6k 個 chunk 約 170MB，Supabase 的 statement timeout
 * 會直接砍掉（57014），而且每匯入一個檔就重演一次、檔案越多越慢。
 */
async function loadIndexMetaFromDb(tenantId: string): Promise<KnowledgeIndexMetaOnly | null> {
  const db = await connectDb();
  const rows = await db.$queryRaw<IndexMetaRow[]>`
    select generated_at, model, source from knowledge_indexes where tenant_id = ${tenantId}
  `;
  const meta = rows[0];
  if (!meta) return null;
  return { generatedAt: meta.generated_at.toISOString(), model: meta.model, source: meta.source };
}

/** 整份載入但**不取 embedding 欄**；供推薦問句等只讀文字的路徑使用 */
async function loadIndexTextFromDb(tenantId: string): Promise<KnowledgeIndexText | null> {
  const meta = await loadIndexMetaFromDb(tenantId);
  if (!meta) return null;
  const db = await connectDb();
  const rows = await db.$queryRaw<Omit<ChunkRow, 'embedding'>[]>`
    select id, url, title, text, file_id
    from knowledge_chunks where tenant_id = ${tenantId}
  `;
  return {
    ...meta,
    chunks: rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      text: r.text,
      ...(r.file_id ? { fileId: r.file_id } : {}),
    })),
  };
}

/** 依來源別統計 chunk 數；聚合在 DB 做完，不搬任何列回來 */
async function countChunksBySourceFromDb(tenantId: string): Promise<ChunkCounts> {
  const db = await connectDb();
  const rows = await db.$queryRaw<ChunkCounts[]>`
    select count(*) filter (where file_id is null)::int as website,
           count(*) filter (where file_id is not null)::int as file
    from knowledge_chunks where tenant_id = ${tenantId}
  `;
  return rows[0] ?? { website: 0, file: 0 };
}

/**
 * 交易逾時（毫秒）：涵蓋最大租戶整份重寫（1.5k 列 halfvec 約 40MB statement）。
 * Prisma 互動式交易預設 5 秒，對這個量級太緊；寧可放寬也不能中途 commit 一半。
 *
 * 只有 saveIndexToDb 用得到。appendChunksToDb 刻意不包交易，理由見該函式註解。
 */
const SAVE_TX_TIMEOUT_MS = 30_000;

/**
 * 整份取代：刪光該租戶 chunks 再分批寫入，最後 upsert 索引層級 metadata。
 *
 * 三段**必須**同屬一個交易。若不包交易，delete 先 commit 而中途某批 insert 失敗
 * （連線重置、statement timeout、單批內重複 id 觸發 ON CONFLICT 二次更新），
 * knowledge_indexes 的舊列會原封不動留著——hasPgvectorIndex 仍回 true、admin 仍看到
 * status='ready'，檢索器卻只剩殘缺的 chunks，機器人拿半份資料自信作答且不噴任何錯誤。
 * 而原本的向量已經沒了，只能重爬並重付一次 embedding 費用。
 *
 * 觸發窗口一點都不罕見：ingestFile／removeFile 都是把整份索引交給 saveIndex，
 * 所以每次上傳、每次刪檔都會走一次「刪 1470 列再塞回」。
 *
 * 包交易的代價很小：單表插入、沒有其他寫入者競爭這張表，1.5k 列是個位數秒。
 * 這也讓 db 後端追上 file 後端本來就有的安全性——writeFileSync 失敗時舊索引檔完好無損。
 */
async function saveIndexToDb(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  const db = await connectDb();
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`delete from knowledge_chunks where tenant_id = ${tenantId}`;

      for (let i = 0; i < idx.chunks.length; i += CHUNK_INSERT_BATCH) {
        const batch = idx.chunks.slice(i, i + CHUNK_INSERT_BATCH);
        const values = batch.map(
          (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                            ${toVectorLiteral(c.vector)}::halfvec(3072))`,
        );
        await tx.$executeRaw`
          insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, embedding)
          values ${Prisma.join(values)}
          on conflict (tenant_id, id) do update set
            url = excluded.url, title = excluded.title, text = excluded.text,
            file_id = excluded.file_id, embedding = excluded.embedding
        `;
      }

      await tx.$executeRaw`
        insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
        values (${tenantId}, ${new Date(idx.generatedAt)}, ${idx.model}, ${idx.source}, now())
        on conflict (tenant_id) do update set
          generated_at = excluded.generated_at, model = excluded.model,
          source = excluded.source, updated_at = now()
      `;
    },
    { timeout: SAVE_TX_TIMEOUT_MS },
  );
}

/**
 * 網站重爬：只取代 file_id is null 的列，**完全不碰檔案來源的 chunks**。
 *
 * 取代 saveIndex 在重爬路徑上的角色。saveIndex 的語意是「刪光整個租戶再塞回」，代價有三：
 *  1. 呼叫端得先 loadIndex 把檔案 chunks（含向量）整份撈回來才不會弄丟它們——
 *     8.8k 個 chunk 約 238MB，直接撞 Postgres 的 statement timeout；
 *  2. 寫回時連完全沒異動的檔案 chunks 也一起重寫，全部塞進同一個交易必然 P2028；
 *  3. 最嚴重的是它先刪後寫：中途失敗時檔案來源的向量已經沒了，而重爬根本產不出它們
 *     （那是使用者上傳的文件），只能請使用者重新上傳並重付一次 embedding。
 * 把範圍收斂到網站來源，三個問題一次消失：不必載入、不必重寫、失敗也波及不到檔案。
 *
 * 保留交易：這是真正的「整批取代」，delete 之後 insert 失敗會讓網站內容殘缺，
 * 而交易內的資料量只剩本次爬到的網站 chunks（不含檔案），遠低於原本的量級。
 */
async function replaceWebsiteChunksInDb(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: KnowledgeIndexMetaOnly,
): Promise<void> {
  const db = await connectDb();
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        delete from knowledge_chunks where tenant_id = ${tenantId} and file_id is null`;

      for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
        const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
        const values = batch.map(
          (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                            ${toVectorLiteral(c.vector)}::halfvec(3072))`,
        );
        await tx.$executeRaw`
          insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, embedding)
          values ${Prisma.join(values)}
          on conflict (tenant_id, id) do update set
            url = excluded.url, title = excluded.title, text = excluded.text,
            file_id = excluded.file_id, embedding = excluded.embedding
        `;
      }

      // 重爬會更新 model 與 source（與 appendChunks 相反）：這就是重新定義索引的時機
      await tx.$executeRaw`
        insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
        values (${tenantId}, ${new Date(meta.generatedAt)}, ${meta.model}, ${meta.source}, now())
        on conflict (tenant_id) do update set
          generated_at = excluded.generated_at, model = excluded.model,
          source = excluded.source, updated_at = now()
      `;
    },
    { timeout: SAVE_TX_TIMEOUT_MS },
  );
}

/** file 後端：整份 JSON 覆寫，保留帶 fileId 的列（等同 carryOverFileChunks 的語意） */
function replaceWebsiteChunksInFile(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: KnowledgeIndexMetaOnly,
): void {
  const kept = loadIndexFromFile(tenantId)?.chunks.filter((c) => c.fileId) ?? [];
  saveIndexToFile(tenantId, { ...meta, chunks: [...chunks, ...kept] });
}

/** 刪除該租戶在 knowledge_chunks／knowledge_indexes 兩張表中的所有列 */
async function deleteIndexFromDb(tenantId: string): Promise<void> {
  const db = await connectDb();
  await db.$executeRaw`delete from knowledge_chunks where tenant_id = ${tenantId}`;
  await db.$executeRaw`delete from knowledge_indexes where tenant_id = ${tenantId}`;
}

/**
 * 附加失敗後的補償刪除：把本次嘗試寫進去的列清乾淨。
 *
 * 一次刪完、不分批：id 數即參數數，Postgres 上限 65535，而 65k 個 chunk 相當於
 * 5000 萬字元的文件，遠超單檔大小上限，不可能發生。分批只會讓補償本身多出幾個
 * 失敗點——而補償失敗正是這裡最不能發生的事。
 */
async function deleteChunksByIds(
  db: Awaited<ReturnType<typeof connectDb>>,
  tenantId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.$executeRaw`
    delete from knowledge_chunks
    where tenant_id = ${tenantId} and id in (${Prisma.join(ids)})
  `;
}

/**
 * db 後端的附加：**只 INSERT，不 delete**。
 *
 * 這是與 saveIndexToDb 的關鍵差異，也是本設計不需要任何鎖的原因——
 * 兩個 process 同時匯入不同檔案寫的是不同的列，天然不衝突。
 * saveIndexToDb 的「刪光再塞回」語意保留給全站重爬（那才真的要整份取代）。
 *
 * knowledge_indexes 的 upsert **不更新 model 與 source**：既有索引的 embedding 模型
 * 一旦定型就不能被後續附加改掉（同一份索引只能用同一個模型）。
 *
 * **刻意不包交易**（與 saveIndexToDb 的第二個關鍵差異）。互動式交易的逾時是牆鐘時間，
 * 涵蓋所有批次的網路傳輸：每列 halfvec(3072) 以文字字面值送出約 27KB，1.5k 個 chunk
 * 就是 40MB 要在同一個交易裡跨網路推到 Supabase。單檔大到一定程度必然撞 30 秒上限
 * （P2028），而且是每次重試都重撞一次——重試會連 embedding 一起重跑，等於反覆付費卻
 * 永遠寫不進去。批次大小調小也救不了：總傳輸量不變，round trip 反而更多。
 *
 * 改以「補償刪除」取得同樣的對外效果（全有或全無），代價是補償本身也可能失敗，
 * 所以那條路徑要大聲記錄。這裡承受得起而 saveIndexToDb 承受不起，是因為本函式只
 * INSERT：中途失敗頂多留下多餘的列，把它們刪掉就回到原狀；saveIndexToDb 是先刪光，
 * 失敗時原始向量已經不存在，補償不回來（只能重爬並重付一次 embedding 費用）。
 */
async function appendChunksToDb(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): Promise<void> {
  const db = await connectDb();
  try {
    for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
      const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
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

    // metadata 擺最後，且同樣納入補償範圍：它是「這批 chunks 已經好了」的宣告，
    // 提早寫會讓檢索器在 chunks 還沒到齊時就把索引當成最新的
    await db.$executeRaw`
      insert into knowledge_indexes (tenant_id, generated_at, model, source, updated_at)
      values (${tenantId}, ${new Date()}, ${meta.model}, ${meta.source}, now())
      on conflict (tenant_id) do update set
        generated_at = excluded.generated_at, updated_at = now()
    `;
  } catch (err) {
    /*
     * 沒有交易可以回滾，所以自己把殘骸收掉，否則會留下孤兒 chunks：
     * ingestFile 每次重試都重新產一個 randomUUID 當 fileId，重試寫的是另一組 id，
     * 上一次的殘留永遠不會被覆寫，也不會出現在 meta.files 裡——admin 看不到、刪不掉，
     * 檢索卻照樣撈得到。機器人於是拿一份沒人知道存在的資料作答。
     */
    try {
      await deleteChunksByIds(db, tenantId, chunks.map((c) => c.id));
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, tenantId, chunks: chunks.length },
        '附加失敗後的補償刪除也失敗，knowledge_chunks 可能殘留孤兒列（需人工清理）',
      );
    }
    throw err;
  }
}

/** db 後端的點狀刪除；受影響列數為 0 時回 false */
async function removeFileChunksFromDb(tenantId: string, fileId: string): Promise<boolean> {
  const db = await connectDb();
  const deleted = await db.$executeRaw`
    delete from knowledge_chunks where tenant_id = ${tenantId} and file_id = ${fileId}
  `;
  if (deleted === 0) return false;
  await db.$executeRaw`
    update knowledge_indexes set generated_at = now(), updated_at = now() where tenant_id = ${tenantId}
  `;
  return true;
}

// ---- 對外介面 ----

/**
 * 讀取整份索引（含向量）；不存在回 null。
 *
 * ⚠️ db 後端會把該租戶所有向量以文字字面值撈回，每筆約 27KB。只需要 model/source 的
 * 呼叫端請改用 loadIndexMeta，只需要文字的請用 loadIndexText——這兩條路徑佔了絕大多數，
 * 誤用本函式在 chunks 上千之後會直接撞 Postgres 的 statement timeout。
 */
export async function loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null> {
  return env.DATA_BACKEND === 'db' ? loadIndexFromDb(tenantId) : loadIndexFromFile(tenantId);
}

/** 只讀索引層級 metadata（generatedAt/model/source），不載入任何 chunk */
export async function loadIndexMeta(tenantId: string): Promise<KnowledgeIndexMetaOnly | null> {
  if (env.DATA_BACKEND === 'db') return loadIndexMetaFromDb(tenantId);
  const idx = loadIndexFromFile(tenantId); // file 後端本來就是整份 JSON，取完丟掉 chunks
  return idx ? { generatedAt: idx.generatedAt, model: idx.model, source: idx.source } : null;
}

/** 讀取整份索引但不含向量；供推薦問句等只讀文字的路徑使用 */
export async function loadIndexText(tenantId: string): Promise<KnowledgeIndexText | null> {
  return env.DATA_BACKEND === 'db' ? loadIndexTextFromDb(tenantId) : loadIndexFromFile(tenantId);
}

/**
 * 網站重爬專用的整批取代：只換掉網站來源的 chunks，檔案來源原封不動。
 * 全站重爬請用本函式而非 saveIndex——理由見 replaceWebsiteChunksInDb 的註解。
 */
export async function replaceWebsiteChunks(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: KnowledgeIndexMetaOnly,
): Promise<void> {
  if (env.DATA_BACKEND === 'db') await replaceWebsiteChunksInDb(tenantId, chunks, meta);
  else replaceWebsiteChunksInFile(tenantId, chunks, meta);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}

/** 依來源別統計該租戶的 chunk 數 */
export async function countChunksBySource(tenantId: string): Promise<ChunkCounts> {
  if (env.DATA_BACKEND === 'db') return countChunksBySourceFromDb(tenantId);
  const chunks = loadIndexFromFile(tenantId)?.chunks ?? [];
  return {
    website: chunks.filter((c) => !c.fileId).length,
    file: chunks.filter((c) => c.fileId).length,
  };
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
  if (env.DATA_BACKEND === 'db') {
    await deleteIndexFromDb(tenantId);
    // 結構化表跟著索引走：留著會讓報告引用到已清除的資料
    await deleteTablesByTenant(tenantId);
  } else deleteIndexFromFile(tenantId);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}

/**
 * 附加 chunks 並 upsert 索引 metadata；**不觸碰其他 chunks**。索引不存在時一併建立。
 *
 * 與 saveIndex 的分工：saveIndex 是「整份取代」（全站重爬用），本函式是「點狀附加」
 * （單檔匯入用）。單檔匯入走 saveIndex 會刪光整個租戶的向量再塞回，既是效能浪費，
 * 也讓並行的另一次匯入互相覆寫。
 */
export async function appendChunks(
  tenantId: string,
  chunks: IndexedChunk[],
  meta: { model: string; source: string },
): Promise<void> {
  if (chunks.length === 0) return;
  if (env.DATA_BACKEND === 'db') await appendChunksToDb(tenantId, chunks, meta);
  else appendChunksToFile(tenantId, chunks, meta);
  invalidateIndexCache(tenantId);
  invalidatePgvectorModelCache(tenantId);
}

/** 移除指定 fileId 的所有 chunks；該檔本來就沒有 chunk 時回 false（不失效快取） */
export async function removeFileChunks(tenantId: string, fileId: string): Promise<boolean> {
  const removed =
    env.DATA_BACKEND === 'db'
      ? await removeFileChunksFromDb(tenantId, fileId)
      : removeFileChunksFromFile(tenantId, fileId);
  if (removed) {
    invalidateIndexCache(tenantId);
    invalidatePgvectorModelCache(tenantId);
  }
  return removed;
}
