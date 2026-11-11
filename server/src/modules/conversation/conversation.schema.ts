import { z } from 'zod';

export const startSchema = z.object({
  message: z.string().trim().min(1).optional().describe('使用者的第一句話；省略時只建立空對話，之後再用 /messages 送出'),
  /** 明確指定要辦理的表單；省略時由 server 依首句意圖路由 */
  formId: z.string().trim().min(1).optional().describe('直接指定要辦理的表單代碼（見 GET /api/forms）；省略時由 AI 依首句判斷'),
  /** 前端 UI 語系（如 'en' / 'zh-Hant'）；決定 agent 回覆語言，省略時預設繁中 */
  lang: z.string().trim().min(1).optional().describe("AI 回覆語言，例如 'zh-Hant'、'en'；省略時預設繁體中文"),
});

export const messageSchema = z.object({
  message: z.string().trim().min(1).describe('使用者送出的訊息內容'),
  /** 前端 UI 語系；每則訊息可帶，支援對話中途切換語言 */
  lang: z.string().trim().min(1).optional().describe("本輪 AI 回覆語言，例如 'zh-Hant'、'en'；可在對話中途切換"),
});

export const idParamSchema = z.object({
  id: z.string().uuid().describe('對話 id（UUID），由 POST /api/conversations 回傳'),
});

export const actionParamSchema = idParamSchema.extend({
  actionId: z.string().uuid().describe('待確認動作 id（UUID），見對話狀態的 pendingAction'),
});

export const confirmBodySchema = z
  .object({
    /** 使用者在確認卡片上修改後的完整參數；省略＝照原參數執行 */
    input: z.record(z.unknown()).optional().describe('使用者在確認卡片上修改後的完整參數；省略時照原參數執行'),
  })
  .strict();

export const proposeBodySchema = z
  .object({
    toolId: z.string().trim().min(1).describe('要提議執行的寫入工具 id'),
    input: z.record(z.unknown()).describe('工具參數，格式依該工具的 input schema'),
  })
  .strict();

// 刪除附件：對話 id + 附件 id（附件 id 亦為 uuid）
export const attachmentParamSchema = z.object({
  id: z.string().uuid().describe('對話 id（UUID）'),
  attachmentId: z.string().uuid().describe('附件 id（UUID），由上傳附件 API 回傳'),
});

// 確認畫面手動編輯：直接設定一批欄位值（不經 LLM）
export const updateFieldsSchema = z.object({
  fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
    message: 'fields 不可為空',
  }).describe('要直接寫入的欄位，key 為表單欄位代碼、value 為欄位值；至少一個，不經 AI'),
});

export type StartInput = z.infer<typeof startSchema>;
export type MessageInput = z.infer<typeof messageSchema>;
export type UpdateFieldsInput = z.infer<typeof updateFieldsSchema>;
export type ConfirmBody = z.infer<typeof confirmBodySchema>;
export type ProposeBody = z.infer<typeof proposeBodySchema>;
