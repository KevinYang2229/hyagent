/**
 * Form Designer 管理 API 的 zod schema：路由參數與 Definition body 的「淺層」形狀檢查。
 * 深層自洽性（欄位 key 對齊、Select options 等）由 form.validator.validateDefinition 把關。
 */
import { z } from 'zod';

export const tenantFormParamSchema = z.object({
  id: z.string().min(1),
  formId: z.string().min(1),
});

/** Definition body 淺層檢查：必備四層存在且型別大致正確；其餘交給 validateDefinition */
export const definitionBodySchema = z
  .object({
    formId: z.string().min(1).describe('表單代碼，同租戶內唯一；更新時須與路徑的 formId 相同'),
    data: z
      .object({ type: z.literal('object'), properties: z.record(z.unknown()) })
      .passthrough()
      .describe('資料結構（JSON Schema）：properties 列出每個欄位的型別'),
    field: z.record(z.unknown()).describe('欄位畫面設定，key 為欄位代碼：元件類型、標籤、選項、說明文字等'),
    validation: z.object({ required: z.array(z.string()) }).passthrough().describe('驗證規則：required 列出必填欄位代碼，另可定義跨欄位的商業規則'),
    agent: z.object({ intent: z.string().min(1), description: z.string().min(1) }).passthrough()
      .describe('AI 對話設定：intent 意圖名稱、description 表單用途（AI 依此判斷要辦哪張表單），另可設路由關鍵字、詢問順序等'),
    layout: z.unknown().optional().describe('版面設定（選填）：欄位分組、排序、多步驟；省略時為單頁平鋪'),
    workflow: z.unknown().optional().describe('簽核關卡（選填）：送出後依關卡計算簽核進度'),
    policy: z.unknown().optional().describe('工時政策（選填，請假類表單用）：上下班時間、午休、週休日、國定假日，可依地區覆寫'),
    oa: z.unknown().optional().describe('送出至外部 OA 系統的設定（選填）：端點、欄位對應、回應解析'),
  })
  .passthrough();

export type DefinitionBody = z.infer<typeof definitionBodySchema>;
