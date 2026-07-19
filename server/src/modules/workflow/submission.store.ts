/**
 * 「我的申請」紀錄（每租戶）：送出成功時由 form-submit 漏斗記一筆，
 * 供 oa.listMyRequests / oa.getApprovalStatus 跨對話查詢。
 * 記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND）、每租戶保留最近 200 筆。
 * 旁路性質——記錄失敗不得影響送出。
 *
 * db 後端為定向寫入：record() 對單筆 upsert、滿 200 筆時順帶刪除截掉的舊列，
 * 不做整包重寫。開機由 initSubmissionStore() 載回（index.ts 於 listen 前呼叫）。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

export interface SubmissionRecord {
  oaRequestId: string;
  formId: string;
  /** 記錄當下的表單標題（表單之後改名/刪除仍可顯示） */
  formTitle: string;
  userId: string;
  submittedAt: string;
}

const MAX_PER_TENANT = 200;
const STORE_FILE = dataFile('oa-agent-submissions.json');
const byTenant = new Map<string, SubmissionRecord[]>();

// ---- row 映射（db 後端用；pure，供測試 round-trip）----

export interface SubmissionDbRow {
  tenantId: string;
  oaRequestId: string;
  formId: string;
  formTitle: string;
  userId: string;
  submittedAt: Date;
}

export function submissionToRow(tenantId: string, rec: SubmissionRecord): SubmissionDbRow {
  return {
    tenantId,
    oaRequestId: rec.oaRequestId,
    formId: rec.formId,
    formTitle: rec.formTitle,
    userId: rec.userId,
    submittedAt: new Date(rec.submittedAt),
  };
}

export function submissionFromRow(row: SubmissionDbRow): SubmissionRecord {
  return {
    oaRequestId: row.oaRequestId,
    formId: row.formId,
    formTitle: row.formTitle,
    userId: row.userId,
    submittedAt: row.submittedAt.toISOString(),
  };
}

// ---- 持久化 ----

const writeQueue = new DbWriteQueue('submissions');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...byTenant.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist submissions');
  }
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, SubmissionRecord[]][];
      for (const [k, v] of raw) byTenant.set(k, v);
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore submissions; starting empty');
  }
}

/**
 * db 後端的開機載入：連 DB、依送出時間排序還原每租戶陣列（維持 file 後端的插入序語意）。
 * 必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initSubmissionStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.submissionRow.findMany({ orderBy: { submittedAt: 'asc' } });
  for (const r of rows) {
    const arr = byTenant.get(r.tenantId) ?? [];
    arr.push(submissionFromRow(r));
    byTenant.set(r.tenantId, arr);
  }
  logger.info({ tenants: byTenant.size, records: rows.length }, 'submissions restored from db');
}

export const submissionStore = {
  record(tenantId: string, rec: SubmissionRecord): void {
    const arr = byTenant.get(tenantId) ?? [];
    arr.push(rec);
    const trimmed = arr.length > MAX_PER_TENANT;
    if (trimmed) arr.splice(0, arr.length - MAX_PER_TENANT);
    byTenant.set(tenantId, arr);
    if (env.DATA_BACKEND === 'db') {
      const row = submissionToRow(tenantId, rec);
      const keepIds = arr.map((r) => r.oaRequestId);
      writeQueue.enqueue(async (db) => {
        await db.submissionRow.upsert({
          where: { tenantId_oaRequestId: { tenantId, oaRequestId: row.oaRequestId } },
          create: row,
          update: row,
        });
        // 超過每租戶上限才需要清掉被截掉的舊列
        if (trimmed) {
          await db.submissionRow.deleteMany({
            where: { tenantId, oaRequestId: { notIn: keepIds } },
          });
        }
      });
      return;
    }
    persistFile();
  },

  /** 該使用者的申請（新→舊，最多 limit 筆） */
  listByUser(tenantId: string, userId: string, limit = 10): SubmissionRecord[] {
    const arr = byTenant.get(tenantId) ?? [];
    return arr.filter((r) => r.userId === userId).reverse().slice(0, limit);
  },

  find(tenantId: string, oaRequestId: string): SubmissionRecord | undefined {
    return (byTenant.get(tenantId) ?? []).find((r) => r.oaRequestId === oaRequestId);
  },

  clear(): void {
    byTenant.clear();
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.submissionRow.deleteMany({});
      });
      return;
    }
    persistFile();
  },
};
