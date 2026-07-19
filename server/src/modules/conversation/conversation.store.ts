/**
 * Session store：記憶體 Map ＋ 可切換的持久化後端（env.DATA_BACKEND）。
 *
 * - file（預設）：整包 JSON 檔。持久化原因：dev 用 `tsx watch`，存檔（甚至 Google Drive
 *   背景同步碰檔）都會重啟進程，純記憶體 store 會讓進行中的對話消失。檔案放 os.tmpdir()
 *   （專案目錄之外）：避免落在 tsx 監看路徑或 Drive 同步範圍而引發重啟迴圈。
 * - db：Postgres（Prisma）——save/create 對單一 session upsert（呼叫端都帶 session，
 *   不需整包重寫）。開機由 initConversationStore() 載回（index.ts 於 listen 前呼叫）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';

const STORE_FILE = dataFile('oa-agent-sessions.json');

const sessions = new Map<string, Session>();

// ---- row 映射（db 後端用；pure，供測試 round-trip）----
// 查詢用欄位開實體 column，整個 Session 物件存 data jsonb（single source）。

export interface SessionDbRow {
  id: string;
  tenantId: string;
  userId: string;
  formId: string;
  data: unknown;
  createdAt: Date;
}

export function sessionToRow(s: Session): SessionDbRow {
  return {
    id: s.id,
    // 既有資料無 tenantId → 視為預設租戶（與讀取端 get() 的向後相容邏輯一致）
    tenantId: s.tenantId ?? 'default',
    userId: s.userId,
    formId: s.formId,
    // 與 file 後端同語意：undefined 欄位序列化時剔除
    data: JSON.parse(JSON.stringify(s)),
    createdAt: new Date(s.createdAt),
  };
}

export function sessionFromRow(row: SessionDbRow): Session {
  return row.data as Session;
}

// ---- db 後端 ----

const writeQueue = new DbWriteQueue('sessions');

function persistSessionToDb(session: Session): void {
  const row = sessionToRow(session);
  const data = row.data as Prisma.InputJsonValue;
  writeQueue.enqueue(async (db) => {
    await db.sessionRow.upsert({
      where: { id: row.id },
      create: { ...row, data },
      update: { data },
    });
  });
}

// ---- file 後端（沿用既有行為）----

// 將整個 map 寫回磁碟（持久化失敗不影響當前請求流程）
function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...sessions.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist sessions');
  }
}

function persist(session?: Session): void {
  if (env.DATA_BACKEND === 'db') {
    if (session) {
      persistSessionToDb(session);
    } else {
      // 防禦性：無指定 session 時整包寫回（現有呼叫端都會帶）
      for (const s of sessions.values()) persistSessionToDb(s);
    }
    return;
  }
  persistFile();
}

// file 後端：啟動時載入既有 session（壞檔則略過，等同空 store）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Session[];
      for (const s of raw) sessions.set(s.id, s);
      logger.info({ count: sessions.size, file: STORE_FILE }, 'sessions restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore sessions; starting empty');
  }
}

/**
 * db 後端的開機載入：連 DB、還原 session Map。
 * 必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initConversationStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.sessionRow.findMany();
  for (const r of rows) {
    const s = sessionFromRow(r);
    sessions.set(s.id, s);
  }
  logger.info({ count: sessions.size }, 'sessions restored from db');
}

export const conversationStore = {
  create(tenantId: string, userId: string, formId: string): Session {
    const session: Session = {
      id: randomUUID(),
      tenantId,
      userId,
      formId,
      values: {},
      status: 'collecting',
      messages: [],
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    persist(session);
    return session;
  },

  get(id: string, tenantId: string, userId: string): Session {
    const session = sessions.get(id);
    if (!session) throw AppError.notFound('Conversation not found');
    // 租戶隔離：跨租戶一律當作不存在（不洩漏其他租戶有此 id）。
    // 既有磁碟資料無 tenantId → 視為預設租戶，維持向後相容。
    if ((session.tenantId ?? 'default') !== tenantId) throw AppError.notFound('Conversation not found');
    if (session.userId !== userId) throw AppError.forbidden('Not your conversation');
    return session;
  },

  /**
   * 將 session 目前狀態 flush 到持久層。
   * 呼叫端拿到的是 map 內同一個物件參照、會就地 mutate，故在每輪/每次變更後呼叫此方法。
   */
  save(session?: Session): void {
    persist(session);
  },
};
