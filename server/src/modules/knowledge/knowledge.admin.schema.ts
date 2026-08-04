/** 知識庫 admin API 的請求驗證 schema（zod）。 */
import { z } from 'zod';

/** 知識來源設定（PUT /knowledge/source 的 body） */
export const sourceSchema = z.object({
  startUrl: z.string().url(),
  maxPages: z.coerce.number().int().min(1).max(1000).default(100),
  pathPrefix: z.string().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  chunkChars: z.coerce.number().int().min(200).max(4000).default(800),
  embeddingModel: z.string().default('text-embedding-3-large'),
  rerank: z.coerce.boolean().default(true),
});

/** 觸發解析（POST /knowledge/ingest 的 body）：可部分覆寫已存設定 */
export const ingestSchema = sourceSchema.partial();

/** 測試查詢（POST /knowledge/query-test 的 body） */
export const queryTestSchema = z.object({ question: z.string().min(1) });

/** job 進度查詢的 path 參數：需保留 :jobId（z.object 預設會剝除未列出的 key） */
export const jobParamSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
});

/** 刪除上傳檔案的 path 參數：需保留 :fileId（z.object 預設會剝除未列出的 key） */
export const fileParamSchema = z.object({
  id: z.string().min(1),
  fileId: z.string().min(1),
});

/** 單格推薦問句的來源（POST 重新生成 / PUT 設定手動值共用） */
const promptSourceSchema = z.enum(['website', 'file']);

/** 重新生成單格（POST /knowledge/suggestion 的 body） */
export const suggestionRefreshSchema = z.object({ source: promptSourceSchema });

/**
 * 設定／清除手動值（PUT /knowledge/suggestion 的 body）；manual 為 null 代表恢復自動。
 *
 * zh-Hant 的非空檢查刻意不放在這裡：zod 驗證失敗會由全域 error handler 轉成 422，
 * 但「必填欄位空白」屬於格式錯誤，語意上該回 400——故只在此做 trim（正規化），
 * 非空檢查留給 controller 用 AppError.badRequest 處理。
 */
export const suggestionManualSchema = z.object({
  source: promptSourceSchema,
  manual: z
    .object({
      'zh-Hant': z.string().trim(),
      en: z.string().trim(),
    })
    .nullable(),
});
