import { z } from 'zod';

export const adminLoginSchema = z.object({
  password: z.string().min(1),
});

export const createTenantSchema = z.object({
  name: z.string().trim().min(1),
  allowedOrigins: z.array(z.string().trim().min(1)).optional(),
  ssoSecret: z.string().min(16).optional(),
});

export const appearanceSchema = z.object({
  assistantName: z.string().max(30).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  position: z.enum(['br', 'bl', 'tr', 'tl']).optional(),
  offsetX: z.coerce.number().int().min(0).max(200).optional(),
  offsetY: z.coerce.number().int().min(0).max(200).optional(),
  logoUrl: z.string().url().optional().or(z.literal('')),
  welcomeMessage: z.string().max(200).optional(),
  defaultLocale: z.string().max(20).optional(),
});

export const patchTenantSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    allowedOrigins: z.array(z.string().trim().min(1)).optional(),
    ssoSecret: z.string().min(16).optional(),
    appearance: appearanceSchema.optional(),
    // 月度 LLM token 配額；0 = 不限
    quotaMonthlyLlmTokens: z.number().int().min(0).optional(),
    /**
     * 知識庫可見性過濾的三態遷移旗標；未設＝off（行為與導入前相同）。
     * 此前寫入端只有 tenantStore.updateTenant 這個內部呼叫（測試/種子資料用），
     * PATCH tenant 沒有這個欄位，上線程序「切 shadow、切 on」與「回滾＝改一個字」
     * 都做不到，實際要人工改持久化 JSON／DB 列再重啟。白名單（tenant.store.ts 的
     * updateTenant）已經支援這個欄位，缺的只是 schema 這一道門。
     */
    knowledgeAcl: z.enum(['off', 'shadow', 'on']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

export const createKeySchema = z.object({
  type: z.enum(['publishable', 'secret']),
});

export const createWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(8).optional(),
  events: z.array(z.literal('form.submitted')).optional(),
});

export const toggleWebhookSchema = z.object({
  disabled: z.boolean(),
});

export const tenantParamSchema = z.object({
  id: z.string().min(1),
});

export const webhookParamSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
});

export const putPolicySchema = z.object({
  grantedScopes: z.array(z.string()),
  groups: z.record(z.string(), z.array(z.string())),
  accounts: z.record(z.string(), z.array(z.string())),
  // 能力套餐：定義 + 部門/帳號指派；default 讓舊版 admin 的 PUT body 向後相容
  bundles: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        description: z.string().optional(),
        scopes: z.array(z.string()),
      }),
    )
    .default([]),
  groupBundles: z.record(z.string(), z.array(z.string())).default({}),
  accountBundles: z.record(z.string(), z.array(z.string())).default({}),
});
export type PutPolicyInput = z.infer<typeof putPolicySchema>;

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type PatchTenantInput = z.infer<typeof patchTenantSchema>;
export type CreateKeyInput = z.infer<typeof createKeySchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type ToggleWebhookInput = z.infer<typeof toggleWebhookSchema>;

/** 後台報告查詢：時間區間（ISO）與關鍵字皆為選填 */
export const adminReportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().trim().max(200).optional(),
});

export type AdminReportQuery = z.infer<typeof adminReportQuerySchema>;
