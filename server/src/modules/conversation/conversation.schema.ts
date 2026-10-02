import { z } from 'zod';

export const startSchema = z.object({
  message: z.string().trim().min(1).optional(),
  /** 明確指定要辦理的表單；省略時由 server 依首句意圖路由 */
  formId: z.string().trim().min(1).optional(),
  /** 前端 UI 語系（如 'en' / 'zh-Hant'）；決定 agent 回覆語言，省略時預設繁中 */
  lang: z.string().trim().min(1).optional(),
});

export const messageSchema = z.object({
  message: z.string().trim().min(1),
  /** 前端 UI 語系；每則訊息可帶，支援對話中途切換語言 */
  lang: z.string().trim().min(1).optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const actionParamSchema = idParamSchema.extend({
  actionId: z.string().uuid(),
});

// 刪除附件：對話 id + 附件 id（附件 id 亦為 uuid）
export const attachmentParamSchema = z.object({
  id: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

// 確認畫面手動編輯：直接設定一批欄位值（不經 LLM）
export const updateFieldsSchema = z.object({
  fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
    message: 'fields 不可為空',
  }),
});

export type StartInput = z.infer<typeof startSchema>;
export type MessageInput = z.infer<typeof messageSchema>;
export type UpdateFieldsInput = z.infer<typeof updateFieldsSchema>;
