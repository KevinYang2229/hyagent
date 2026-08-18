/**
 * 索引對帳：找出 knowledge_chunks 與 meta.files／tenants 對不起來的資料。
 *
 * 三種漂移各有不同成因，也各有不同的處置權限：
 *
 *  1. 孤兒 chunks —— 有 file_id，但該 file_id 不在 meta.files 裡。
 *     成因是匯入寫到一半 process 被中止（Ctrl-C、crash）：appendChunks 的補償刪除
 *     處理得了查詢失敗，處理不了自己被砍掉。而 ingestFile 每次重試都換一個新的
 *     randomUUID，殘留永遠不會被覆寫。這是唯一可以自動刪的一類——它們在正確的租戶
 *     底下、檢索照樣撈得到，但後台看不到也刪不掉，機器人會拿一份沒人知道存在的
 *     資料作答。
 *
 *  2. 幽靈租戶 —— chunks 的 tenant_id 不存在於 tenants 表。
 *     成因是批次匯入曾經把資料夾名當 tenantId（已於 folder-ingest 加閘攔截）。
 *     **只報告不自動刪**：那些 chunks 的 embedding 已經付過錢，正確處置往往是搬去
 *     真正的租戶而不是刪掉，需要人判斷。
 *
 *  3. 反向缺漏 —— meta.files 有登記，但資料庫查無對應 chunks。
 *     這是 meta 的問題而非垃圾資料，刪 chunks 解決不了，同樣只報告。
 */
import { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { AppError } from '@/utils/app-error';

/** 未被 meta.files 登記的檔案來源 chunks */
export interface OrphanFile {
  tenantId: string;
  fileId: string;
  title: string;
  chunks: number;
}

/** tenants 表查無此 id，但 knowledge_chunks 有資料 */
export interface PhantomTenant {
  tenantId: string;
  chunks: number;
}

/** meta.files 有登記但資料庫查無 chunks */
export interface MissingFile {
  tenantId: string;
  fileId: string;
  name: string;
}

export interface ReconcileReport {
  orphans: OrphanFile[];
  phantoms: PhantomTenant[];
  missing: MissingFile[];
}

/** 對帳只在 db 後端有意義：file 後端整份 JSON 原子覆寫，不會寫到一半留下殘骸 */
function assertDbBackend(): void {
  if (env.DATA_BACKEND !== 'db') {
    throw AppError.badRequest('索引對帳僅適用於 DATA_BACKEND=db（file 後端不會產生部分寫入）');
  }
}

/** 掃描三種漂移；tenantId 省略時掃全部租戶。純唯讀。 */
export async function scanIndexDrift(tenantId?: string): Promise<ReconcileReport> {
  assertDbBackend();
  const db = await connectDb();
  const only = (col: string): Prisma.Sql =>
    tenantId ? Prisma.sql`and ${Prisma.raw(col)} = ${tenantId}` : Prisma.empty;

  // join knowledge_sources：沒有 sources 列的租戶無從判定「該登記什麼」，
  // 一律不列入——寧可漏報也不能因為讀不到 meta 就把人家的資料判成孤兒
  const orphans = await db.$queryRaw<OrphanFile[]>`
    select c.tenant_id as "tenantId", c.file_id as "fileId",
           min(c.title) as title, count(*)::int as chunks
    from knowledge_chunks c
    join knowledge_sources s on s.tenant_id = c.tenant_id
    where c.file_id is not null
      ${only('c.tenant_id')}
      and not exists (
        select 1 from jsonb_array_elements(coalesce(s.meta->'files', '[]'::jsonb)) f
        where f->>'fileId' = c.file_id
      )
    group by c.tenant_id, c.file_id
    order by chunks desc
  `;

  const phantoms = await db.$queryRaw<PhantomTenant[]>`
    select c.tenant_id as "tenantId", count(*)::int as chunks
    from knowledge_chunks c
    where not exists (select 1 from tenants t where t.id = c.tenant_id)
      ${only('c.tenant_id')}
    group by c.tenant_id
    order by chunks desc
  `;

  const missing = await db.$queryRaw<MissingFile[]>`
    select s.tenant_id as "tenantId", f->>'fileId' as "fileId", f->>'name' as name
    from knowledge_sources s,
         lateral jsonb_array_elements(coalesce(s.meta->'files', '[]'::jsonb)) f
    where not exists (
      select 1 from knowledge_chunks c
      where c.tenant_id = s.tenant_id and c.file_id = f->>'fileId'
    )
    ${only('s.tenant_id')}
    order by s.tenant_id
  `;

  return { orphans, phantoms, missing };
}

/**
 * 刪除孤兒 chunks，回傳實際刪除的列數。
 *
 * 刻意逐筆列出 (tenant_id, file_id) 而不是把掃描用的相關子查詢直接寫成 DELETE：
 * 這樣刪的一定是報告上印出來、人看過的那幾筆，掃描與刪除之間的任何資料變動都不會
 * 擴大刪除範圍。對正式資料庫的破壞性操作，可稽核比少一次查詢重要得多。
 */
export async function deleteOrphanChunks(orphans: OrphanFile[]): Promise<number> {
  assertDbBackend();
  if (orphans.length === 0) return 0;
  const db = await connectDb();
  const pairs = orphans.map((o) => Prisma.sql`(${o.tenantId}, ${o.fileId})`);
  return db.$executeRaw`
    delete from knowledge_chunks
    where (tenant_id, file_id) in (${Prisma.join(pairs)})
  `;
}
