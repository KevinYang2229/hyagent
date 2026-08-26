/** 知識庫 admin API 的請求驗證 schema（zod）。 */
import { z } from 'zod';

/** 知識來源設定（PUT /knowledge/source 的 body） */
export const sourceSchema = z.object({
  // 檔案 RAG 不需要網站來源，因此尚未設定網址時允許空字串；
  // 真正啟動網站 ingest 時仍由 controller 機制擋下空值。
  startUrl: z.union([z.literal(''), z.string().url()]),
  maxPages: z.coerce.number().int().min(1).max(1000).default(100),
  pathPrefix: z.string().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  chunkChars: z.coerce.number().int().min(200).max(4000).default(800),
  embeddingModel: z.string().default('text-embedding-3-large'),
  rerank: z.coerce.boolean().default(true),
  /**
   * 網站來源的可見性標籤（整個來源一組）。
   *
   * 「未帶時保留既有值」只在 POST /knowledge/ingest（knowledge.admin.controller.ts 的
   * ingest handler）成立——那裡是 `{ ...knowledgeStore.getSource(tenantId), ...body }`
   * 的 merge 寫法。PUT /knowledge/source（saveSource）不是：knowledgeStore.saveSource
   * 直接把 body 整包存成新的 KnowledgeSource（`{ ...src, updatedAt }`），不帶這個欄位
   * 就等於把既有值清掉，不是「保留」。
   */
  visibilityScopes: z.array(z.string()).optional(),
});

/** 觸發解析（POST /knowledge/ingest 的 body）：可部分覆寫已存設定 */
export const ingestSchema = sourceSchema.partial();

/** 測試查詢（POST /knowledge/query-test 的 body） */
export const queryTestSchema = z.object({
  question: z.string().min(1),
  /** 以此使用者身分試查；未帶時用管理者自身 */
  asUserId: z.string().min(1).optional(),
});

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
      // 上限與自動生成路徑的 MAX_ZH_CHARS 一致：手動值一樣要塞進 widget 的 chip，
      // 版面寬度沒有例外可言。
      'zh-Hant': z.string().trim().max(20),
      en: z.string().trim(),
    })
    .nullable(),
});

/** 建立標籤（POST /knowledge/labels） */
export const labelCreateSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
});

/** 更新標籤顯示名稱（PATCH /knowledge/labels/:labelId） */
export const labelUpdateSchema = z.object({ label: z.string().min(1).max(60) });

/** 標籤 path 參數：需保留 :labelId（z.object 預設會剝除未列出的 key） */
export const labelParamSchema = z.object({
  id: z.string().min(1),
  labelId: z.string().min(1),
});

/** 檔案可見性標註（PATCH /knowledge/files/:fileId/visibility） */
export const fileVisibilitySchema = z.object({ scopes: z.array(z.string()).default([]) });
