/** 知識庫 admin API 的請求驗證 schema（zod）。 */
import { z } from 'zod';
import { MAX_ZH_CHARS } from './knowledge.suggest';

/** 知識來源設定（PUT /knowledge/source 的 body） */
export const sourceSchema = z.object({
  // 檔案 RAG 不需要網站來源，因此尚未設定網址時允許空字串；
  // 真正啟動網站 ingest 時仍由 controller 機制擋下空值。
  startUrl: z.union([z.literal(''), z.string().url()]).describe('爬取起點網址；只用檔案知識庫時可留空字串'),
  renderJavaScript: z.boolean().optional().describe('是否用瀏覽器執行 JavaScript 後再擷取內容（前端渲染的網站需要開啟）'),
  renderWaitMs: z.number().int().min(0).max(10_000).optional().describe('開啟 renderJavaScript 時，頁面載入後再等待的時間（毫秒），0–10000'),
  maxPages: z.coerce.number().int().min(1).max(1000).default(100).describe('最多爬取頁數，1–1000，預設 100'),
  pathPrefix: z.string().optional().describe('只爬路徑以此開頭的頁面，例如 /docs/'),
  includePatterns: z.array(z.string()).optional().describe('只爬網址符合任一條正規表示式的頁面；省略＝不限制'),
  excludePatterns: z.array(z.string()).optional().describe('網址符合任一條正規表示式的頁面不爬，優先於 includePatterns'),
  chunkChars: z.coerce.number().int().min(200).max(4000).default(800).describe('內容切塊的字數，200–4000，預設 800'),
  embeddingModel: z.string().default('text-embedding-3-large').describe('建立向量索引用的 embedding 模型，預設 text-embedding-3-large'),
  rerank: z.coerce.boolean().default(true).describe('是否啟用重新排序（rerank）兩階段檢索，預設開啟'),
  /**
   * 網站來源的可見性標籤（整個來源一組）。
   *
   * 「未帶時保留既有值」只在 POST /knowledge/ingest（knowledge.admin.controller.ts 的
   * ingest handler）成立——那裡是 `{ ...knowledgeStore.getSource(tenantId), ...body }`
   * 的 merge 寫法。PUT /knowledge/source（saveSource）不是：knowledgeStore.saveSource
   * 直接把 body 整包存成新的 KnowledgeSource（`{ ...src, updatedAt }`），不帶這個欄位
   * 就等於把既有值清掉，不是「保留」。
   */
  visibilityScopes: z.array(z.string()).optional()
    .describe('audience.mode 為 labels 時，整個網站來源套用的可見性標籤（kb:<標籤 id>）；PUT /knowledge/source 不帶等於清空'),
  audience: z.object({
    mode: z.enum(['public', 'departments', 'disabled', 'labels']),
    departments: z.array(z.string().trim().min(1)).optional(),
  }).refine((value) => value.mode !== 'departments' || !!value.departments?.length, {
    message: '請至少選擇一個部門',
  }).optional()
    .describe('網站內容誰看得到：public 所有人（含訪客）、departments 指定部門的登入員工、disabled 誰都看不到、labels 依 visibilityScopes 標籤判斷'),
});

/** 觸發解析（POST /knowledge/ingest 的 body）：可部分覆寫已存設定 */
export const ingestSchema = sourceSchema.partial();

/** 測試查詢（POST /knowledge/query-test 的 body） */
export const queryTestSchema = z.object({
  question: z.string().min(1).describe('測試用的問題'),
  /** 以此使用者身分試查；未帶時以網站訪客身分查詢 */
  asUserId: z.string().min(1).optional().describe('以這位使用者的權限試查（會記入稽核）；省略時以網站訪客身分查詢'),
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
export const suggestionRefreshSchema = z.object({
  source: promptSourceSchema.describe('要重新產生哪一組推薦問句：website 網站內容、file 上傳檔案'),
});

/**
 * 設定／清除手動值（PUT /knowledge/suggestion 的 body）；manual 為 null 代表恢復自動。
 *
 * zh-Hant 的非空檢查刻意不放在這裡：zod 驗證失敗會由全域 error handler 轉成 422，
 * 但「必填欄位空白」屬於格式錯誤，語意上該回 400——故只在此做 trim（正規化），
 * 非空檢查留給 controller 用 AppError.badRequest 處理。
 */
export const suggestionManualSchema = z.object({
  source: promptSourceSchema.describe('要覆寫哪一組推薦問句：website 網站內容、file 上傳檔案'),
  manual: z
    .object({
      // 直接引用自動生成路徑的常數，而不是再寫一次字面值：手動值一樣要塞進 widget 的
      // chip，兩邊必須同步，而各持一份字面值遲早會在調整上限時漂移。
      'zh-Hant': z.string().trim().max(MAX_ZH_CHARS),
      en: z.string().trim(),
    })
    .nullable()
    .describe(`手動指定的問句（zh-Hant 必填，最多 ${MAX_ZH_CHARS} 字；en 可為空字串）；傳 null 代表恢復 AI 自動產生`),
});

/** 建立標籤（POST /knowledge/labels） */
export const labelCreateSchema = z.object({
  id: z.string().min(1).max(40).describe('標籤 id，只允許小寫英數與連字號，最多 40 字；建立後不可改，對應的權限 scope 為 kb:<id>'),
  label: z.string().min(1).max(60).describe('顯示名稱，最多 60 字'),
});

/** 更新標籤顯示名稱（PATCH /knowledge/labels/:labelId） */
export const labelUpdateSchema = z.object({ label: z.string().min(1).max(60).describe('新的顯示名稱，最多 60 字') });

/** 標籤 path 參數：需保留 :labelId（z.object 預設會剝除未列出的 key） */
export const labelParamSchema = z.object({
  id: z.string().min(1),
  labelId: z.string().min(1),
});

/** 檔案可見性標註（PATCH /knowledge/files/:fileId/visibility） */
export const fileVisibilitySchema = z.object({
  scopes: z.array(z.string()).default([]).describe('可見性標籤（kb:<標籤 id>），有任一標籤權限的人看得到；空陣列＝明確設定誰都不能看'),
});

export const customSuggestionSchema = z.object({
  source: promptSourceSchema.describe('問句歸在哪一組：website 網站內容、file 上傳檔案'),
  text: z.object({
    'zh-Hant': z.string().trim().min(1).max(MAX_ZH_CHARS),
    en: z.string().trim().max(200),
  }).describe(`問句內容：zh-Hant 必填，最多 ${MAX_ZH_CHARS} 字；en 最多 200 字，可留空`),
});
export const customSuggestionParamSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().uuid(),
});

/** 存取紀錄查詢（GET /knowledge/access-logs） */
export const accessLogQuerySchema = z.object({
  fileId: z.string().min(1).max(200).optional(),
  // 空字串是合法值：網站訪客的 userId 可能為空
  userId: z.string().max(200).optional(),
  path: z.enum(['chat', 'table', 'report', 'admin_test']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 存取紀錄保存天數（PATCH /knowledge/access-log-settings）；null＝清除覆寫、回到平台預設 */
export const accessLogSettingsSchema = z.object({
  retentionDays: z.number().int().min(30).max(3650).nullable().describe('存取紀錄保存天數，30–3650；傳 null 代表恢復平台預設'),
});
