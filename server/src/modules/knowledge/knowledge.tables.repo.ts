/**
 * 試算表結構化留存的持久化層。
 *
 * 與 knowledge.index.repo 分開：那邊管的是向量與 chunk（回答「這在講什麼」），
 * 這邊管的是原始資料列（回答「數字是多少」）。兩者的讀寫形態、生命週期都不同，
 * 唯一的交集是同一個 fileId——刪檔時要一起清掉。
 *
 * 僅 db 後端；file 後端不留結構化表（那條路徑是單機開發用，報告圖表不是它的重點）。
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { toVectorLiteral } from './knowledge.index.repo';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import type { ParsedTable } from './doc-parse';

/** 目錄項：供 LLM 挑選用，刻意不含 rows——幾千列塞進 prompt 既貴又沒必要 */
export interface TableCatalogEntry {
  id: string;
  source: string;
  sheet: string;
  caption?: string;
  headers: string[];
  rowCount: number;
}

/** 完整的一張表 */
export interface StoredTable extends TableCatalogEntry {
  rows: string[][];
}

interface TableRow {
  id: string;
  source: string;
  sheet: string;
  caption: string | null;
  headers: string[];
  rows?: string[][];
  row_count: number;
}

function toEntry(r: TableRow): TableCatalogEntry {
  return {
    id: r.id,
    source: r.source,
    sheet: r.sheet,
    ...(r.caption ? { caption: r.caption } : {}),
    headers: r.headers,
    rowCount: r.row_count,
  };
}

/**
 * 一張表的「描述句」——拿去 embed 的文字。
 *
 * 只用來源、工作表名、橫幅與欄位名，不含資料列：要比對的是「這張表在講什麼」，
 * 幾千列數字進去只會把語意稀釋掉。
 */
export function tableDescriptor(t: {
  source: string;
  sheet: string;
  caption?: string;
  headers: string[];
}): string {
  return [t.source, t.sheet, t.caption ?? '', `欄位：${t.headers.join('、')}`]
    .filter(Boolean)
    .join(' ');
}

/** 寫入某檔案的所有結構化表；空陣列為 no-op。vectors 省略時 embedding 留空（選表退回 bigram） */
export async function saveTables(
  tenantId: string,
  fileId: string,
  source: string,
  tables: ParsedTable[],
  vectors?: number[][],
): Promise<number> {
  if (env.DATA_BACKEND !== 'db' || tables.length === 0) return 0;
  const db = await connectDb();
  const values = tables.map((t, i) => {
    const vec = vectors?.[i];
    const embedding = vec
      ? Prisma.sql`${toVectorLiteral(vec)}::halfvec(3072)`
      : Prisma.sql`null`;
    return Prisma.sql`(${randomUUID()}, ${tenantId}, ${fileId}, ${source}, ${t.sheet},
                       ${t.caption ?? null}, ${JSON.stringify(t.headers)}::jsonb,
                       ${JSON.stringify(t.rows)}::jsonb, ${t.rows.length}, ${embedding})`;
  });
  return db.$executeRaw`
    insert into knowledge_tables
      (id, tenant_id, file_id, source, sheet, caption, headers, rows, row_count, embedding)
    values ${Prisma.join(values)}
  `;
}

/**
 * 依語意相似度取回候選表。查無任何已 embed 的表時回空陣列，由呼叫端退回 bigram。
 *
 * 精確掃描（無 ANN 索引）：單一租戶的表數是百的量級，而 chunks 是萬的量級——
 * 對這個規模建索引只是多一份寫入成本與 post-filter 的風險。
 */
export async function searchTableCatalog(
  tenantId: string,
  vector: number[],
  limit: number,
): Promise<TableCatalogEntry[]> {
  if (env.DATA_BACKEND !== 'db') return [];
  const db = await connectDb();
  const rows = await db.$queryRaw<TableRow[]>`
    select id, source, sheet, caption, headers, row_count
    from knowledge_tables
    where tenant_id = ${tenantId} and embedding is not null
    order by embedding <=> ${toVectorLiteral(vector)}::halfvec(3072)
    limit ${limit}
  `;
  return rows.map(toEntry);
}

/** 該租戶可用的表清單（不含資料列） */
export async function listTableCatalog(tenantId: string): Promise<TableCatalogEntry[]> {
  if (env.DATA_BACKEND !== 'db') return [];
  const db = await connectDb();
  const rows = await db.$queryRaw<TableRow[]>`
    select id, source, sheet, caption, headers, row_count
    from knowledge_tables where tenant_id = ${tenantId}
    order by source, sheet
  `;
  return rows.map(toEntry);
}

/** 取單一張表的完整內容；查無回 null */
export async function loadTable(tenantId: string, id: string): Promise<StoredTable | null> {
  if (env.DATA_BACKEND !== 'db') return null;
  const db = await connectDb();
  const rows = await db.$queryRaw<TableRow[]>`
    select id, source, sheet, caption, headers, rows, row_count
    from knowledge_tables where tenant_id = ${tenantId} and id = ${id}
  `;
  const r = rows[0];
  return r ? { ...toEntry(r), rows: r.rows ?? [] } : null;
}

/** 刪除某檔的所有表（比照 removeFileChunks，刪檔時一併呼叫） */
export async function deleteTablesByFile(tenantId: string, fileId: string): Promise<number> {
  if (env.DATA_BACKEND !== 'db') return 0;
  const db = await connectDb();
  return db.$executeRaw`
    delete from knowledge_tables where tenant_id = ${tenantId} and file_id = ${fileId}`;
}

/** 刪除該租戶所有表（比照 deleteIndex，清除索引時一併呼叫） */
export async function deleteTablesByTenant(tenantId: string): Promise<number> {
  if (env.DATA_BACKEND !== 'db') return 0;
  const db = await connectDb();
  return db.$executeRaw`delete from knowledge_tables where tenant_id = ${tenantId}`;
}
