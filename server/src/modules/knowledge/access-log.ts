/**
 * 知識庫敏感文件存取紀錄（設計：docs/superpowers/specs/2026-11-10-knowledge-access-log-design.md）。
 *
 * ACL 回答「誰可以看」，這裡回答出事時被問的「誰看過」。
 *
 * - 只記**非公開**檔案：目前的可見性標籤與網站訪客可見範圍沒有交集。不另外維護「哪些標籤算公開」，
 *   直接沿用後台「可見範圍與標籤」的設定，兩邊永遠一致。
 * - 只記實際交給模型或寫進產出物的內容（呼叫端負責只交出用到的），不記檢索候選池。
 * - **絕不影響回應**：recordKnowledgeAccess 同步回傳 void、內部吞掉所有例外，寫入走 DbWriteQueue。
 * - **不存內容**：問句、回答、chunk 文字一律不進紀錄，否則紀錄本身就成了要保護的個資庫。
 */
import { env } from '@/config/env';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { Prisma } from '@prisma/client';
import { knowledgeStore } from './knowledge.store';
import { currentChunkScopes, guestVisibilityScopesOf } from './knowledge.visibility';
import type { RetrievalPrincipal } from './retriever.types';

export const ACCESS_PATHS = ['chat', 'table', 'report', 'admin_test'] as const;
export type AccessPath = (typeof ACCESS_PATHS)[number];

export interface AccessLogEntry {
  id: string;
  tenantId: string;
  userId: string;
  actorId?: string;
  path: AccessPath;
  /** 未設＝網站來源 */
  fileId?: string;
  fileName: string;
  scopes: string[];
  refId?: string;
  at: string;
}

/** 呼叫端交出的取用項：檔案以 fileId 辨識；網站來源沒有 fileId，以 label（網址或標題）顯示 */
export interface AccessItem {
  fileId?: string;
  label?: string;
}

export interface AccessContext {
  refId?: string;
  actorId?: string;
}

/** 同一請求內重複取用同一檔（多個 chunk、chunk 加表格、報告多節）只記一筆 */
const DEDUPE_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 5000;
const recent = new Map<string, number>();

/** file 後端（開發）：記憶體保存，每租戶上限，重啟即清空 */
const MEMORY_MAX_PER_TENANT = 1000;
const memory = new Map<string, AccessLogEntry[]>();
let memorySeq = 0;

const writeQueue = new DbWriteQueue('knowledge access log');
const DAY_MS = 24 * 60 * 60 * 1000;

function seenRecently(key: string, now: number): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < DEDUPE_MS) return true;
  recent.set(key, now);
  if (recent.size > DEDUPE_MAX) {
    for (const [k, t] of recent) if (now - t >= DEDUPE_MS) recent.delete(k);
    // 全部都還在窗口內時，丟掉最舊的一半，避免無上限成長
    if (recent.size > DEDUPE_MAX) for (const k of [...recent.keys()].slice(0, DEDUPE_MAX / 2)) recent.delete(k);
  }
  return false;
}

interface Resolved {
  fileId?: string;
  fileName: string;
  scopes: string[];
}

/** 解析一個取用項的標籤與名稱；公開或無法判定（未設定的網站來源、stub FAQ）回 undefined */
function resolveNonPublic(tenantId: string, item: AccessItem, guest: Set<string>): Resolved | undefined {
  if (item.fileId) {
    const file = knowledgeStore.getMeta(tenantId).files?.find((f) => f.fileId === item.fileId);
    const scopes = currentChunkScopes(tenantId, { fileId: item.fileId });
    if (scopes.some((s) => guest.has(s))) return undefined;
    return { fileId: item.fileId, fileName: file?.name ?? item.label ?? item.fileId, scopes };
  }
  // 網站來源：沒有設定可見範圍時，沒有「非公開網站」可言（stub 的固定 FAQ 也落在這裡，全部視為公開）
  const source = knowledgeStore.getSource(tenantId);
  if (!source.audience && source.visibilityScopes === undefined) return undefined;
  const scopes = currentChunkScopes(tenantId, {});
  if (scopes.some((s) => guest.has(s))) return undefined;
  return { fileName: item.label || source.startUrl || '網站', scopes };
}

/**
 * 記錄一次取用。同步回傳、不拋錯：任何失敗只寫 log，呼叫端不必（也不該）await 或 try。
 */
export function recordKnowledgeAccess(
  principal: RetrievalPrincipal,
  path: AccessPath,
  items: readonly AccessItem[],
  ctx: AccessContext = {},
): void {
  try {
    if (items.length === 0) return;
    const { tenantId, userId } = principal;
    const guest = new Set(guestVisibilityScopesOf(tenantId));
    const now = Date.now();
    const rows: Resolved[] = [];
    const inThisCall = new Set<string>();
    for (const item of items) {
      const r = resolveNonPublic(tenantId, item, guest);
      if (!r) continue;
      const fileKey = r.fileId ?? `web:${r.fileName}`;
      if (inThisCall.has(fileKey)) continue;
      inThisCall.add(fileKey);
      if (seenRecently([tenantId, userId, path, ctx.refId ?? '', ctx.actorId ?? '', fileKey].join('|'), now)) continue;
      rows.push(r);
    }
    if (rows.length === 0) return;
    const at = new Date(now).toISOString();

    if (env.DATA_BACKEND !== 'db') {
      const list = memory.get(tenantId) ?? [];
      for (const r of rows) {
        list.push({
          id: String(++memorySeq),
          tenantId,
          userId,
          ...(ctx.actorId ? { actorId: ctx.actorId } : {}),
          path,
          ...(r.fileId ? { fileId: r.fileId } : {}),
          fileName: r.fileName,
          scopes: r.scopes,
          ...(ctx.refId ? { refId: ctx.refId } : {}),
          at,
        });
      }
      memory.set(tenantId, list.slice(-MEMORY_MAX_PER_TENANT));
      return;
    }

    const values = rows.map(
      (r) => Prisma.sql`(${tenantId}, ${userId}, ${ctx.actorId ?? null}, ${path}, ${r.fileId ?? null},
                         ${r.fileName}, ${r.scopes}::text[], ${ctx.refId ?? null}, ${at}::timestamptz)`,
    );
    writeQueue.enqueue(async (db) => {
      await db.$executeRaw`
        insert into knowledge_access_logs
          (tenant_id, user_id, actor_id, path, file_id, file_name, scopes, ref_id, at)
        values ${Prisma.join(values)}`;
    });
  } catch (err) {
    logger.warn({ err, tenantId: principal.tenantId, path }, 'knowledge access log record failed (ignored)');
  }
}

/** chunks → 取用項（呼叫端用） */
export function accessItemsOf(chunks: readonly { fileId?: string; url?: string; title?: string }[]): AccessItem[] {
  return chunks.map((c) => (c.fileId ? { fileId: c.fileId, label: c.title } : { label: c.url || c.title }));
}

// ---- 查詢（後台，平台管理者） ----

export interface AccessLogFilter {
  fileId?: string;
  userId?: string;
  path?: AccessPath;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export const ACCESS_LOG_PAGE_SIZE = 50;

/** 游標：(at, id) 編成不透明字串；新→舊 */
function encodeCursor(e: { at: string; id: string }): string {
  return Buffer.from(`${e.at}|${e.id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } | undefined {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return at && id && !Number.isNaN(Date.parse(at)) && /^\d+$/.test(id) ? { at, id } : undefined;
}

interface AccessLogRow {
  id: bigint;
  tenant_id: string;
  user_id: string;
  actor_id: string | null;
  path: string;
  file_id: string | null;
  file_name: string;
  scopes: string[];
  ref_id: string | null;
  at: Date;
}

function fromRow(r: AccessLogRow): AccessLogEntry {
  return {
    id: String(r.id),
    tenantId: r.tenant_id,
    userId: r.user_id,
    ...(r.actor_id ? { actorId: r.actor_id } : {}),
    path: r.path as AccessPath,
    ...(r.file_id ? { fileId: r.file_id } : {}),
    fileName: r.file_name,
    scopes: r.scopes ?? [],
    ...(r.ref_id ? { refId: r.ref_id } : {}),
    at: r.at.toISOString(),
  };
}

export async function listKnowledgeAccessLogs(
  tenantId: string,
  filter: AccessLogFilter = {},
): Promise<{ items: AccessLogEntry[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(filter.limit ?? ACCESS_LOG_PAGE_SIZE, 1), 200);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;

  let items: AccessLogEntry[];
  if (env.DATA_BACKEND !== 'db') {
    const fromMs = filter.from ? Date.parse(filter.from) : undefined;
    const toMs = filter.to ? Date.parse(filter.to) : undefined;
    items = [...(memory.get(tenantId) ?? [])]
      .filter((e) => (filter.fileId ? e.fileId === filter.fileId : true))
      .filter((e) => (filter.userId !== undefined ? e.userId === filter.userId : true))
      .filter((e) => (filter.path ? e.path === filter.path : true))
      .filter((e) => (fromMs !== undefined ? Date.parse(e.at) >= fromMs : true))
      .filter((e) => (toMs !== undefined ? Date.parse(e.at) < toMs : true))
      .sort((a, b) => b.at.localeCompare(a.at) || Number(b.id) - Number(a.id))
      .filter((e) => !cursor || e.at < cursor.at || (e.at === cursor.at && Number(e.id) < Number(cursor.id)))
      .slice(0, limit + 1);
  } else {
    const conds: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];
    if (filter.fileId) conds.push(Prisma.sql`file_id = ${filter.fileId}`);
    if (filter.userId !== undefined) conds.push(Prisma.sql`user_id = ${filter.userId}`);
    if (filter.path) conds.push(Prisma.sql`path = ${filter.path}`);
    if (filter.from) conds.push(Prisma.sql`at >= ${filter.from}::timestamptz`);
    if (filter.to) conds.push(Prisma.sql`at < ${filter.to}::timestamptz`);
    if (cursor) conds.push(Prisma.sql`(at, id) < (${cursor.at}::timestamptz, ${BigInt(cursor.id)})`);
    const db = await connectDb();
    const rows = await db.$queryRaw<AccessLogRow[]>`
      select id, tenant_id, user_id, actor_id, path, file_id, file_name, scopes, ref_id, at
      from knowledge_access_logs
      where ${Prisma.join(conds, ' and ')}
      order by at desc, id desc
      limit ${limit + 1}`;
    items = rows.map(fromRow);
  }

  const page = items.slice(0, limit);
  return {
    items: page,
    ...(items.length > limit ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}),
  };
}

// ---- 保存期限 ----

/** 租戶實際適用的保存天數：租戶覆寫優先，否則平台預設 */
export function accessLogRetentionDaysOf(tenantId: string): number {
  return tenantStore.getTenant(tenantId)?.knowledgeAccessLogRetentionDays ?? env.KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS;
}

/**
 * 刪除過期紀錄（每日排程與開機各跑一次）。db 後端依整張表刪除：停機期間到期的列不會殘留。
 * 有覆寫的租戶逐一以自己的天數刪；其餘租戶一句以平台預設刪。
 */
export function cleanupExpiredAccessLogs(now = Date.now()): void {
  try {
    const overrides = tenantStore
      .listTenants()
      .filter((t) => t.knowledgeAccessLogRetentionDays !== undefined)
      .map((t) => ({ tenantId: t.id, cutoff: new Date(now - t.knowledgeAccessLogRetentionDays! * DAY_MS) }));
    const defaultCutoff = new Date(now - env.KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS * DAY_MS);

    if (env.DATA_BACKEND !== 'db') {
      const cutoffOf = new Map(overrides.map((o) => [o.tenantId, o.cutoff.getTime()]));
      for (const [tenantId, list] of memory) {
        const cutoff = cutoffOf.get(tenantId) ?? defaultCutoff.getTime();
        memory.set(tenantId, list.filter((e) => Date.parse(e.at) >= cutoff));
      }
      return;
    }

    const overrideIds = overrides.map((o) => o.tenantId);
    writeQueue.enqueue(async (db) => {
      for (const o of overrides) {
        await db.$executeRaw`delete from knowledge_access_logs where tenant_id = ${o.tenantId} and at < ${o.cutoff}`;
      }
      await db.$executeRaw`
        delete from knowledge_access_logs
        where tenant_id <> all(${overrideIds}::text[]) and at < ${defaultCutoff}`;
    });
  } catch (err) {
    logger.warn({ err }, 'knowledge access log cleanup failed');
  }
}

/** 刪租戶級聯清理 */
export function purgeTenantAccessLogs(tenantId: string): void {
  memory.delete(tenantId);
  for (const k of [...recent.keys()]) if (k.startsWith(`${tenantId}|`)) recent.delete(k);
  if (env.DATA_BACKEND === 'db') {
    writeQueue.enqueue(async (db) => {
      await db.$executeRaw`delete from knowledge_access_logs where tenant_id = ${tenantId}`;
    });
  }
}

/** 測試用 */
export function resetAccessLogsForTest(): void {
  memory.clear();
  recent.clear();
  memorySeq = 0;
}
