/**
 * 報告產出物儲存：記憶體 Map + DATA_BACKEND=db 時 write-through。
 *
 * 與 attachment.store 的兩點差異：
 * - get 一開始就是 async。附件的檔頭明載「目前無任何呼叫端讀 bytes」，所以它只讀記憶體；
 *   報告的下載就是讀取路徑，db 模式下必須能從 Postgres 讀回，否則重啟後連結全失效。
 * - 有 TTL。附件靠對話結束清理，報告沒有對應的生命週期終點。
 *
 * 儲存單位是 (reportId, format)，不是「md 欄位 + html 欄位」——以 format 為 key，
 * 新增一種格式只是多存一列，不必改 schema 與讀寫程式。
 */
import { env } from '@/config/env';
import { DbWriteQueue, getDb } from '@/lib/db';

export interface StoredReport {
  reportId: string;
  tenantId: string;
  userId: string;
  format: string;
  filename: string;
  content: Buffer;
  expiresAt: string;
}

const docs = new Map<string, StoredReport>();
const writeQueue = new DbWriteQueue('report-docs');

const keyOf = (reportId: string, format: string): string => `${reportId}:${format}`;

export const reportStore = {
  save(input: {
    reportId: string;
    tenantId: string;
    userId: string;
    format: string;
    filename: string;
    content: Buffer;
  }): void {
    const expiresAt = new Date(Date.now() + env.REPORT_TTL_HOURS * 3600_000).toISOString();
    const stored: StoredReport = { ...input, expiresAt };
    docs.set(keyOf(input.reportId, input.format), stored);

    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.reportDocRow.upsert({
          where: { reportId_format: { reportId: input.reportId, format: input.format } },
          create: {
            reportId: input.reportId,
            format: input.format,
            tenantId: input.tenantId,
            userId: input.userId,
            filename: input.filename,
            content: input.content,
            expiresAt: new Date(expiresAt),
          },
          update: { content: input.content, expiresAt: new Date(expiresAt) },
        });
      });
    }
  },

  /** 先讀記憶體，未命中且為 db 模式時回資料庫撈（重啟後的下載走這條） */
  async get(reportId: string, format: string): Promise<StoredReport | undefined> {
    const hit = docs.get(keyOf(reportId, format));
    if (hit) return hit;
    if (env.DATA_BACKEND !== 'db') return undefined;

    const db = getDb();
    if (!db) return undefined;
    const row = await db.reportDocRow.findUnique({
      where: { reportId_format: { reportId, format } },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;

    const stored: StoredReport = {
      reportId: row.reportId,
      tenantId: row.tenantId,
      userId: row.userId,
      format: row.format,
      filename: row.filename,
      content: Buffer.from(row.content),
      expiresAt: row.expiresAt.toISOString(),
    };
    docs.set(keyOf(reportId, format), stored);
    return stored;
  },

  /** 該報告目前有哪些格式可下載（狀態端點回給前端，前端據此渲染連結） */
  formatsOf(reportId: string): string[] {
    return [...docs.values()].filter((d) => d.reportId === reportId).map((d) => d.format);
  },

  /** 清除過期產出物，回傳清除筆數 */
  purgeExpired(now: Date = new Date()): number {
    let purged = 0;
    for (const [key, doc] of docs) {
      if (new Date(doc.expiresAt).getTime() <= now.getTime()) {
        docs.delete(key);
        purged += 1;
      }
    }
    if (purged > 0 && env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.reportDocRow.deleteMany({ where: { expiresAt: { lte: now } } });
      });
    }
    return purged;
  },

  _resetForTest(): void {
    docs.clear();
  },
};
