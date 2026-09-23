import { z } from 'zod';

export const adminLoginSchema = z.object({
  password: z.string().min(1),
});

export const createTenantSchema = z.object({
  name: z.string().trim().min(1),
  allowedOrigins: z.array(z.string().trim().min(1)).optional(),
});

/**
 * 上傳 Assertion 公鑰（規格 §7.3）。
 *
 * **沒有 `kid` 也沒有 `alg`**：兩者都由後端自公鑰算出（§2.4 的 RFC 7638 Thumbprint、
 * §2.1 的金鑰型別）。接受呼叫端指定 kid 等於讓上傳者自選索引鍵，同一把公鑰可被登記成
 * 多個 kid，撤銷時就漏得掉。
 */
export const addPublicKeySchema = z.object({
  publicKey: z.string().trim().min(1),
  label: z.string().trim().max(60).optional(),
});

/** 公鑰狀態變更（規格 §7.3）。不變條件由 store 強制，這裡只驗形狀。 */
export const setPublicKeyStatusSchema = z.object({
  status: z.enum(['active', 'disabled', 'revoked']),
});

/**
 * 公鑰狀態變更的路由參數。
 *
 * **必須把 `kid` 一起列出來**：validate 中介層會用解析結果整個取代 `req.params`，
 * 而 zod 預設會剝掉未宣告的鍵——只放 `id` 的話 `req.params.kid` 會變成 undefined，
 * 撤銷就打在一個不存在的 kid 上，回 400 而不是真的撤銷（這個坑實際踩過）。
 */
export const tenantKeyParamSchema = z.object({
  id: z.string().trim().min(1),
  kid: z.string().trim().min(1),
});

/**
 * 逐租戶設定（規格 §4.3、§7.1、§10.4）。
 *
 * 範圍與交叉條件（skew ≤ 有效期 ¼）由 tenant-keys.ts 驗證而非寫在這裡：
 * 那是兩個欄位的組合條件，部分更新時必須拿「合併後」的整組去比，zod 看不到現行值。
 */
export const patchAssertionSettingsSchema = z
  .object({
    clockSkewSeconds: z.number().int().optional(),
    assertionLifetimeSeconds: z.number().int().optional(),
    sessionExpiresIn: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

/** 依 sub 批次作廢 Session（規格 §7.4）。 */
export const revokeSessionsSchema = z.object({
  sub: z.string().trim().min(1),
});

/**
 * 後台 Session 列表的查詢條件。
 *
 * `query` 一個欄位同時當「完整 sub」與「name 關鍵字」用（見 authSessionStore.listByTenant）：
 * 後台顯示使用者本來就是 `name ?? sub`，若拆成兩個欄位，管理員照著畫面上的工號去搜
 * 卻搜不到，只因為那格其實是 fallback 出來的。
 */
export const listSessionsQuerySchema = z.object({
  query: z.string().trim().min(1).optional(),
  kid: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** 作廢單筆 Session：sessionId 是列表回的 id（sha256(sessionToken)），不是 token。 */
export const sessionParamSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
});

export const appearanceSchema = z.object({
  assistantName: z.string().max(30).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  position: z.enum(['br', 'bl', 'tr', 'tl']).optional(),
  // 啟動按鈕尺寸：只開放五段固定值，避免宿主頁出現破版的任意大小
  launcherSize: z.coerce
    .number()
    .int()
    .pipe(
      z.union([
        z.literal(40),
        z.literal(44),
        z.literal(48),
        z.literal(52),
        z.literal(56),
      ]),
    )
    .optional(),
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
    appearance: appearanceSchema.optional(),
    // 月度 LLM token 配額；0 = 不限
    quotaMonthlyLlmTokens: z.number().int().min(0).optional(),
  })
  /*
   * 也是舊旗標的擋板：ACL 已無每租戶開關（見 knowledge.visibility.ts），
   * knowledgeAcl 這個欄位不再列在上面，legacy 客戶端送 { knowledgeAcl: 'off' }
   * 會被 zod 剝成空物件、由這條 refine 判為 422，不會靜默回 200 讓人以為關掉了。
   */
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
export type AddPublicKeyInput = z.infer<typeof addPublicKeySchema>;
export type SetPublicKeyStatusInput = z.infer<typeof setPublicKeyStatusSchema>;
export type TenantKeyParam = z.infer<typeof tenantKeyParamSchema>;
export type PatchAssertionSettingsInput = z.infer<typeof patchAssertionSettingsSchema>;
export type RevokeSessionsInput = z.infer<typeof revokeSessionsSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type SessionParam = z.infer<typeof sessionParamSchema>;
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
