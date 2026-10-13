/**
 * AI 回覆評價 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND），寫法同 mcp.store。
 * db 後端：每筆一列（data jsonb 整包），tenant_id／updated_at 供清除查詢；開機載回保存期限內全部。
 * 統計與篩選都在記憶體算：保存期限內的量可控，且不必為每種篩選組合建索引。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import {
  FEEDBACK_REASONS,
  type FeedbackFilter,
  type FeedbackRating,
  type FeedbackReason,
  type FeedbackStats,
  type FeedbackStatus,
  type ReplyFeedback,
} from './feedback.types';

const DAY_MS = 86_400_000;
const STORE_FILE = dataFile('oa-agent-reply-feedback.json');
const items = new Map<string, ReplyFeedback>();
/** (tenant, session, reply, user) → id：同一人對同一則回覆只有一筆 */
const byKey = new Map<string, string>();
const writeQueue = new DbWriteQueue('reply-feedback');

/** createdAt 在本程序內嚴格遞增：同毫秒建立的評價不靠隨機 id 排序，列表順序與游標才確定 */
let lastCreatedMs = 0;
function nextCreatedAt(): string {
  lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1);
  return new Date(lastCreatedMs).toISOString();
}

const keyOf = (tenantId: string, sessionId: string, replyId: string, userId: string): string =>
  JSON.stringify([tenantId, sessionId, replyId, userId]);

// ---- row 映射（db 後端用；pure，供測試 round-trip）----

export interface FeedbackDbRow {
  id: string;
  tenantId: string;
  updatedAt: Date;
  data: unknown;
}

export function feedbackToRow(f: ReplyFeedback): FeedbackDbRow {
  return { id: f.id, tenantId: f.tenantId, updatedAt: new Date(f.updatedAt), data: JSON.parse(JSON.stringify(f)) };
}

export function feedbackFromRow(row: FeedbackDbRow): ReplyFeedback {
  return row.data as ReplyFeedback;
}

// ---- 持久化 ----

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...items.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist reply feedback');
  }
}

function index(f: ReplyFeedback): void {
  items.set(f.id, f);
  byKey.set(keyOf(f.tenantId, f.sessionId, f.replyId, f.userId), f.id);
}

function unindex(f: ReplyFeedback): void {
  items.delete(f.id);
  byKey.delete(keyOf(f.tenantId, f.sessionId, f.replyId, f.userId));
}

function save(f: ReplyFeedback): void {
  index(f);
  if (env.DATA_BACKEND !== 'db') {
    persistFile();
    return;
  }
  const row = feedbackToRow(f);
  const data = row.data as Prisma.InputJsonValue;
  writeQueue.enqueue(async (db) => {
    await db.replyFeedbackRow.upsert({
      where: { id: row.id },
      create: { id: row.id, tenantId: row.tenantId, updatedAt: row.updatedAt, data },
      update: { updatedAt: row.updatedAt, data },
    });
  });
}

function removeMany(targets: ReplyFeedback[]): void {
  if (targets.length === 0) return;
  for (const f of targets) unindex(f);
  if (env.DATA_BACKEND !== 'db') {
    persistFile();
    return;
  }
  const ids = targets.map((f) => f.id);
  writeQueue.enqueue(async (db) => {
    await db.replyFeedbackRow.deleteMany({ where: { id: { in: ids } } });
  });
}

// file 後端：模組載入即同步還原
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      for (const f of JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as ReplyFeedback[]) index(f);
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore reply feedback; starting empty');
  }
}

/** db 後端的開機載入（保存期限內全部）；file 後端為 no-op。必須在開始服務請求前 await。 */
export async function initFeedbackStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const since = new Date(Date.now() - env.FEEDBACK_RETENTION_DAYS * DAY_MS);
  const rows = await db.replyFeedbackRow.findMany({ where: { updatedAt: { gte: since } } });
  for (const r of rows) index(feedbackFromRow(r));
  logger.info({ count: items.size }, 'reply feedback restored from db');
}

// ---- 游標：(createdAt, id) 編成不透明字串。用 createdAt 而非 updatedAt：改評不會讓項目在翻頁中跳位 ----

function encodeCursor(f: ReplyFeedback): string {
  return Buffer.from(`${f.createdAt}|${f.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return createdAt && id ? { createdAt, id } : undefined;
}

/** 新→舊：createdAt desc，同時間以 id desc 決定順序 */
function newerFirst(a: ReplyFeedback, b: ReplyFeedback): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function matches(f: ReplyFeedback, filter: FeedbackFilter): boolean {
  return (
    (!filter.rating || f.rating === filter.rating) &&
    (!filter.serviceId || f.serviceId === filter.serviceId) &&
    (!filter.reason || f.reason === filter.reason) &&
    (!filter.status || f.status === filter.status)
  );
}

function tenantItems(tenantId: string): ReplyFeedback[] {
  return [...items.values()].filter((f) => f.tenantId === tenantId);
}

export const feedbackStore = {
  /**
   * 建立或更新評價。快照只在第一次建立時從 ReplyRecord 複製，之後改評不重抓。
   * 改評一律回到 open：管理員處理過的倒讚若被改評，代表有新的意見要看。
   */
  upsert(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    reply: ReplyRecord;
    rating: FeedbackRating;
    reason?: FeedbackReason;
    comment?: string;
  }): ReplyFeedback {
    const now = new Date().toISOString();
    const existingId = byKey.get(keyOf(input.tenantId, input.sessionId, input.reply.id, input.userId));
    const existing = existingId ? items.get(existingId) : undefined;
    const base: ReplyFeedback = existing ?? {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      replyId: input.reply.id,
      serviceId: input.reply.serviceId,
      question: input.reply.question,
      answer: input.reply.answer,
      ...(input.reply.trace ? { trace: input.reply.trace } : {}),
      rating: input.rating,
      status: 'open',
      createdAt: nextCreatedAt(),
      updatedAt: now,
    };
    const { reason: _r, comment: _c, resolutionNote: _n, ...rest } = base;
    const next: ReplyFeedback = {
      ...rest,
      rating: input.rating,
      ...(input.rating === 'down' && input.reason ? { reason: input.reason } : {}),
      ...(input.rating === 'down' && input.comment ? { comment: input.comment } : {}),
      status: 'open',
      updatedAt: now,
    };
    save(next);
    return next;
  },

  remove(tenantId: string, sessionId: string, replyId: string, userId: string): void {
    const id = byKey.get(keyOf(tenantId, sessionId, replyId, userId));
    const f = id ? items.get(id) : undefined;
    if (f) removeMany([f]);
  },

  getById(tenantId: string, id: string): ReplyFeedback | undefined {
    const f = items.get(id);
    return f && f.tenantId === tenantId ? f : undefined;
  },

  setStatus(tenantId: string, id: string, status: FeedbackStatus, resolutionNote?: string): ReplyFeedback | undefined {
    const f = feedbackStore.getById(tenantId, id);
    if (!f) return undefined;
    const { resolutionNote: _n, ...rest } = f;
    const next: ReplyFeedback = {
      ...rest,
      status,
      ...(resolutionNote ? { resolutionNote } : {}),
      updatedAt: new Date().toISOString(),
    };
    save(next);
    return next;
  },

  list(
    tenantId: string,
    filter: FeedbackFilter,
    { before, limit }: { before?: string; limit: number },
  ): { items: ReplyFeedback[]; nextCursor: string | null } {
    const cursor = before ? decodeCursor(before) : undefined;
    const all = tenantItems(tenantId)
      .filter((f) => matches(f, filter))
      .sort(newerFirst)
      .filter((f) => !cursor || f.createdAt < cursor.createdAt || (f.createdAt === cursor.createdAt && f.id < cursor.id));
    const page = all.slice(0, limit);
    return { items: page, nextCursor: all.length > limit ? encodeCursor(page[page.length - 1]) : null };
  },

  stats(tenantId: string, days: number, now = Date.now()): FeedbackStats {
    const since = now - days * DAY_MS;
    const stats: FeedbackStats = {
      days,
      total: 0,
      up: 0,
      down: 0,
      openDown: 0,
      byService: {},
      byReason: Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, 0])) as Record<FeedbackReason, number>,
    };
    for (const f of tenantItems(tenantId)) {
      const t = Date.parse(f.updatedAt);
      if (t < since || t > now) continue;
      stats.total += 1;
      stats[f.rating] += 1;
      const svc = (stats.byService[f.serviceId] ??= { up: 0, down: 0 });
      svc[f.rating] += 1;
      if (f.rating === 'down') {
        if (f.status === 'open') stats.openDown += 1;
        if (f.reason) stats.byReason[f.reason] += 1;
      }
    }
    return stats;
  },

  /**
   * 刪除 updatedAt 早於保存期限者；回傳記憶體內刪除筆數。
   * db 後端另對整張表依 cutoff 刪除：服務停機期間到期的列開機時不會載入，只清記憶體會讓它永遠留在 db。
   */
  cleanupExpired(now = Date.now()): number {
    const cutoff = now - env.FEEDBACK_RETENTION_DAYS * DAY_MS;
    const expired = [...items.values()].filter((f) => Date.parse(f.updatedAt) < cutoff);
    removeMany(expired);
    if (env.DATA_BACKEND === 'db') {
      const cutoffDate = new Date(cutoff);
      writeQueue.enqueue(async (db) => {
        await db.replyFeedbackRow.deleteMany({ where: { updatedAt: { lt: cutoffDate } } });
      });
    }
    return expired.length;
  },

  /** 刪租戶級聯清理 */
  purgeTenant(tenantId: string): void {
    removeMany(tenantItems(tenantId));
  },

  /** 清空（測試用） */
  clear(): void {
    items.clear();
    byKey.clear();
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.replyFeedbackRow.deleteMany({});
      });
      return;
    }
    persistFile();
  },
};
