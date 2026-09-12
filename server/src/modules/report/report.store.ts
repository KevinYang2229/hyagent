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
  createdAt: string;
  expiresAt: string;
}

/** 後台查詢用：一份報告一列，多種格式收在 files 裡 */
export interface ReportListItem {
  reportId: string;
  tenantId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  files: { format: string; filename: string }[];
}

export interface ReportListFilter {
  /** 使用者端清單必須限定建立者。 */
  userId?: string;
  /** 建立時間下界（ISO，含端點） */
  from?: string;
  /** 建立時間上界（ISO，含端點） */
  to?: string;
  /** 關鍵字：比對檔名與使用者，不分大小寫 */
  q?: string;
}

const docs = new Map<string, StoredReport>();
const writeQueue = new DbWriteQueue('report-docs');

const keyOf = (reportId: string, format: string): string => `${reportId}:${format}`;

/**
 * formatsOf / filesOf 共用的查詢邏輯：記憶體與 db（DATA_BACKEND=db 時）取聯集，
 * 依 format 去重（記憶體命中優先），避免兩個公開方法各自重寫一次同樣的過期比對與併集規則。
 */
async function queryFiles(reportId: string): Promise<{ format: string; filename: string }[]> {
  const now = Date.now();
  const inMemory = [...docs.values()]
    .filter((d) => d.reportId === reportId && new Date(d.expiresAt).getTime() > now)
    .map((d) => ({ format: d.format, filename: d.filename }));

  if (env.DATA_BACKEND !== 'db') return inMemory;
  const db = getDb();
  if (!db) return inMemory;

  const rows = await db.reportDocRow.findMany({
    where: { reportId, expiresAt: { gt: new Date(now) } },
    select: { format: true, filename: true },
  });
  const seen = new Set(inMemory.map((f) => f.format));
  const merged = [...inMemory];
  for (const row of rows) {
    if (!seen.has(row.format)) {
      merged.push({ format: row.format, filename: row.filename });
      seen.add(row.format);
    }
  }
  return merged;
}

export const reportStore = {
  save(input: {
    reportId: string;
    tenantId: string;
    userId: string;
    format: string;
    filename: string;
    content: Buffer;
  }): void {
    // 一律以 Date.now() 取時間（而非 new Date()）：本模組其他地方也用它，
    // 測試覆寫 Date.now 推進時間時兩者才會一致
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + env.REPORT_TTL_HOURS * 3600_000).toISOString();
    const stored: StoredReport = { ...input, createdAt: new Date(nowMs).toISOString(), expiresAt };
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
    const key = keyOf(reportId, format);
    const hit = docs.get(key);
    if (hit) {
      // 沒有排程呼叫 purgeExpired()：記憶體命中也要自行比對過期，
      // 否則沒人手動觸發回收時，TTL 只在「剛好被 purge 過」的窗口內成立
      if (new Date(hit.expiresAt).getTime() > Date.now()) return hit;
      docs.delete(key);
    }
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
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
    docs.set(keyOf(reportId, format), stored);
    return stored;
  },

  /**
   * 後台查詢：列出該租戶未過期的報告，一份一列。
   *
   * 只回 metadata 不回 content——清單頁不需要 bytes，撈 bytea 只會讓回應肥大而無用。
   * 能篩的欄位僅限 report_docs 實際存下來的：job 的 topic／status 純記憶體、重啟即失，
   * 不在這裡（也不該在這裡）假裝查得到。
   */
  async listByTenant(
    tenantId: string,
    filter: ReportListFilter,
    now: Date = new Date(),
  ): Promise<ReportListItem[]> {
    type Row = {
      reportId: string;
      userId: string;
      format: string;
      filename: string;
      createdAt: string;
      expiresAt: string;
    };

    const rows: Row[] = [...docs.values()]
      .filter((d) => d.tenantId === tenantId && (!filter.userId || d.userId === filter.userId))
      .map((d) => ({
        reportId: d.reportId,
        userId: d.userId,
        format: d.format,
        filename: d.filename,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
      }));

    if (env.DATA_BACKEND === 'db') {
      const db = getDb();
      if (db) {
        const dbRows = await db.reportDocRow.findMany({
          where: { tenantId, ...(filter.userId ? { userId: filter.userId } : {}), expiresAt: { gt: now } },
          select: {
            reportId: true,
            userId: true,
            format: true,
            filename: true,
            createdAt: true,
            expiresAt: true,
          },
        });
        const seen = new Set(rows.map((r) => keyOf(r.reportId, r.format)));
        for (const row of dbRows) {
          if (seen.has(keyOf(row.reportId, row.format))) continue;
          rows.push({
            reportId: row.reportId,
            userId: row.userId,
            format: row.format,
            filename: row.filename,
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
          });
        }
      }
    }

    const q = filter.q?.trim().toLowerCase();
    const fromMs = filter.from ? new Date(filter.from).getTime() : undefined;
    const toMs = filter.to ? new Date(filter.to).getTime() : undefined;

    const grouped = new Map<string, ReportListItem>();
    for (const row of rows) {
      // 過期的不列：使用者端已經拿不到，後台列成可下載只會製造「點了才發現失敗」
      if (new Date(row.expiresAt).getTime() <= now.getTime()) continue;

      const createdMs = new Date(row.createdAt).getTime();
      if (fromMs !== undefined && createdMs < fromMs) continue;
      if (toMs !== undefined && createdMs > toMs) continue;
      if (q && !`${row.filename} ${row.userId}`.toLowerCase().includes(q)) continue;

      const item = grouped.get(row.reportId);
      if (item) {
        item.files.push({ format: row.format, filename: row.filename });
        // 同一份報告的各格式寫入時間差幾毫秒，取最早的當建立時間
        if (createdMs < new Date(item.createdAt).getTime()) item.createdAt = row.createdAt;
      } else {
        grouped.set(row.reportId, {
          reportId: row.reportId,
          tenantId,
          userId: row.userId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          files: [{ format: row.format, filename: row.filename }],
        });
      }
    }

    return [...grouped.values()]
      .map((item) => ({
        ...item,
        files: [...item.files].sort((a, b) => a.format.localeCompare(b.format)),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  /**
   * 該報告目前有哪些格式可下載（狀態端點回給前端，前端據此渲染連結）。
   *
   * 與 brief 原稿的同步簽名不同——特意改成 async 且 db-aware：純讀記憶體的話，
   * 重啟後、在任一 format 被 get() 撈回填之前，formatsOf 會回空陣列，但 get() 本身
   * 早就能從 db 補回內容，造成「下載打得到、狀態查不到」的矛盾（狀態端點若據此
   * 判斷 404，會與同時可成功的下載互相矛盾）。db 模式下改為記憶體與 db 兩邊查詢後取聯集。
   */
  async formatsOf(reportId: string): Promise<string[]> {
    return (await queryFiles(reportId)).map((f) => f.format);
  },

  /**
   * 同 formatsOf，多附上每個格式對應的檔名——狀態端點用它讓前端設定下載檔名
   * （<a download="…">），檔名來源與下載端點的 reportStore.get(...).filename 是同一份，
   * 不各自算一次，避免兩邊算出的檔名不一致。
   */
  async filesOf(reportId: string): Promise<{ format: string; filename: string }[]> {
    return queryFiles(reportId);
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
