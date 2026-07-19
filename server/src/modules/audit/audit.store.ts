/**
 * 工具稽核紀錄（每租戶）：記憶體 ＋ 可切換持久化後端（env.DATA_BACKEND）。
 * 只由 toolRegistry.invoke 對 audit 工具寫入；旁路性質——記錄失敗不得影響主流程。
 *
 * - file（預設）：整包 JSON 檔，每租戶保留最近 N 筆（沿用既有行為）。
 * - db：append-only insert，**DB 留全史**（稽核本該可回溯）；記憶體仍只保最近 N 筆
 *   供 list() 查詢，開機由 initAuditStore() 以每租戶最近 N 筆還原。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

export interface AuditEntry {
  toolId: string;
  userId: string;
  at: string;
  ok: boolean;
  summary: string;
  error?: string;
}

const MAX_PER_TENANT = 500;
const STORE_FILE = dataFile('oa-agent-audit.json');
const logs = new Map<string, AuditEntry[]>();

// ---- row 映射（db 後端用；pure，供測試 round-trip）----

export interface AuditDbRow {
  tenantId: string;
  toolId: string;
  userId: string;
  at: Date;
  ok: boolean;
  summary: string;
  error: string | null;
}

export function auditToRow(tenantId: string, e: AuditEntry): AuditDbRow {
  return {
    tenantId,
    toolId: e.toolId,
    userId: e.userId,
    at: new Date(e.at),
    ok: e.ok,
    summary: e.summary,
    error: e.error ?? null,
  };
}

export function auditFromRow(row: AuditDbRow): AuditEntry {
  return {
    toolId: row.toolId,
    userId: row.userId,
    at: row.at.toISOString(),
    ok: row.ok,
    summary: row.summary,
    ...(row.error != null ? { error: row.error } : {}),
  };
}

// ---- 持久化 ----

const writeQueue = new DbWriteQueue('audit');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...logs.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist audit log');
  }
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, AuditEntry[]][];
      for (const [k, v] of raw) logs.set(k, v);
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore audit log; starting empty');
  }
}

/**
 * db 後端的開機載入：每租戶取最近 MAX_PER_TENANT 筆還原（舊→新，維持記憶體排序語意）。
 * 必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initAuditStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  // 窗函數取每租戶最近 N 筆；全表載入會隨全史成長，這裡固定只撈需要的量
  const rows = await db.$queryRaw<AuditDbRow[]>`
    select tenant_id as "tenantId", tool_id as "toolId", user_id as "userId", at, ok, summary, error
    from (
      select *, row_number() over (partition by tenant_id order by at desc, id desc) as rn
      from audit_logs
    ) t
    where rn <= ${MAX_PER_TENANT}
    order by at asc`;
  for (const r of rows) {
    const arr = logs.get(r.tenantId) ?? [];
    arr.push(auditFromRow(r));
    logs.set(r.tenantId, arr);
  }
  logger.info({ tenants: logs.size, records: rows.length }, 'audit log restored from db');
}

export const auditStore = {
  record(tenantId: string, entry: AuditEntry): void {
    const arr = logs.get(tenantId) ?? [];
    arr.push(entry);
    if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT); // 捨最舊
    logs.set(tenantId, arr);
    if (env.DATA_BACKEND === 'db') {
      // append-only：DB 不截尾、留全史
      const row = auditToRow(tenantId, entry);
      writeQueue.enqueue(async (db) => {
        await db.auditLogRow.create({ data: row });
      });
      return;
    }
    persistFile();
  },

  /** 回最近 limit 筆（新→舊）。 */
  list(tenantId: string, limit = 100): AuditEntry[] {
    const arr = logs.get(tenantId) ?? [];
    return [...arr].reverse().slice(0, limit);
  },

  clear(): void {
    logs.clear();
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.auditLogRow.deleteMany({});
      });
      return;
    }
    persistFile();
  },
};
