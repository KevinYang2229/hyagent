import { z } from 'zod';

export const adminLoginSchema = z.object({
  /** 省略或 admin（不分大小寫）＝超級管理者；其他為租戶管理者帳號 */
  username: z.string().trim().min(1).max(64).optional().describe('省略或填 admin＝超級管理者（以 ADMIN_PASSWORD 登入）；其他為租戶管理者帳號'),
  password: z.string().min(1).describe('密碼'),
});

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).describe('租戶顯示名稱'),
  allowedOrigins: z.array(z.string().trim().min(1)).optional().describe('允許嵌入的網站來源，例如 https://www.example.com；省略時為 ["*"]（全部放行）'),
});

/**
 * 上傳 Assertion 公鑰（規格 §7.3）。
 *
 * **沒有 `kid` 也沒有 `alg`**：兩者都由後端自公鑰算出（§2.4 的 RFC 7638 Thumbprint、
 * §2.1 的金鑰型別）。接受呼叫端指定 kid 等於讓上傳者自選索引鍵，同一把公鑰可被登記成
 * 多個 kid，撤銷時就漏得掉。
 */
export const addPublicKeySchema = z.object({
  publicKey: z.string().trim().min(1).describe('PEM 或 JWK 格式的公鑰（勿貼私鑰，會被拒絕）；kid 與演算法由伺服器自公鑰算出'),
  label: z.string().trim().max(60).optional().describe('方便辨識的備註名稱，最多 60 字'),
});

/** 撤銷公鑰（規格 §7.3）。原因必填——稽核要分得出例行輪替與外洩；不變條件由 store 強制，這裡只驗形狀。 */
export const revokePublicKeySchema = z.object({
  reason: z.enum(['rotated', 'aborted', 'compromised', 'other']).describe('撤銷原因（稽核用）：rotated 例行輪替、aborted 放棄輪替（撤掉新登記的）、compromised 私鑰外洩、other 其他'),
});

/**
 * 撤銷公鑰的路由參數。
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
    clockSkewSeconds: z.number().int().optional().describe('允許雙方主機的時鐘誤差（秒），不可超過 Assertion 有效時間的 1/4'),
    assertionLifetimeSeconds: z.number().int().optional().describe('Assertion 簽發後可用來換發 Session 的時間（秒）'),
    sessionExpiresIn: z.number().int().optional().describe('換發出的 Session 有效時間（秒）'),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

/** 依 sub 批次作廢 Session（規格 §7.4）。 */
export const revokeSessionsSchema = z.object({
  sub: z.string().trim().min(1).describe('要強制登出的使用者 sub（帳號），會撤銷此人全部 Session'),
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
    name: z.string().trim().min(1).optional().describe('租戶顯示名稱'),
    allowedOrigins: z.array(z.string().trim().min(1)).optional().describe('允許嵌入的網站來源；["*"] 代表全部放行。整份取代'),
    appearance: appearanceSchema.optional().describe('Widget 外觀設定'),
    // 月度 LLM token 配額；0 = 不限
    quotaMonthlyLlmTokens: z.number().int().min(0).optional().describe('每月 LLM token 用量上限；0＝不限，用盡後呼叫 LLM 的 API 回 429'),
    egressPolicy: z.object({
      allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/)).max(100).optional(),
      sensitiveTerms: z.array(z.string().min(4).max(500)).max(100).optional(),
    }).strict().optional().describe('對外輸出內容的防護：限制 AI 可寄信的網域、攔截機密字詞'),
    // 允許免登入訪客 Session（POST /api/auth/guest）
    guestAccess: z.boolean().optional().describe('是否允許免登入訪客使用（POST /api/auth/guest）；關閉後既有訪客 Session 立即失效'),
  })
  /*
   * 也是舊旗標的擋板：ACL 已無每租戶開關（見 knowledge.visibility.ts），
   * knowledgeAcl 這個欄位不再列在上面，legacy 客戶端送 { knowledgeAcl: 'off' }
   * 會被 zod 剝成空物件、由這條 refine 判為 422，不會靜默回 200 讓人以為關掉了。
   */
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

export const createKeySchema = z.object({
  type: z.enum(['publishable', 'secret']).describe('publishable＝pk_ 公開金鑰，可放在瀏覽器；secret＝sk_ 秘密金鑰，只能放在伺服器端'),
});

export const createWebhookSchema = z.object({
  url: z.string().url().describe('接收事件的網址；租戶管理者只能填公開網段'),
  secret: z.string().min(8).optional().describe('簽章用的共享密鑰，至少 8 字；省略時由伺服器產生'),
  events: z.array(z.literal('form.submitted')).optional().describe('要訂閱的事件；目前只有 form.submitted（表單送出）'),
});

export const toggleWebhookSchema = z.object({
  disabled: z.boolean().describe('true＝暫停推送、false＝恢復推送'),
});

export const tenantParamSchema = z.object({
  id: z.string().min(1),
});

export const webhookParamSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
});

export const putPolicySchema = z.object({
  grantedScopes: z.array(z.string()).describe('租戶層開放給所有人（含網站訪客）的 scope，可選值見 GET /api/admin/scopes'),
  groups: z.record(z.string(), z.array(z.string())).describe('部門名稱 → 該部門額外授予的 scope'),
  accounts: z.record(z.string(), z.array(z.string())).describe('帳號 → 該帳號個人額外授予的 scope'),
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
    .default([])
    .describe('角色（能力套餐）定義：具名的 scope 組合，可指派給部門、帳號或全員'),
  groupBundles: z.record(z.string(), z.array(z.string())).default({}).describe('部門名稱 → 指派的角色 id'),
  accountBundles: z.record(z.string(), z.array(z.string())).default({}).describe('帳號 → 指派的角色 id'),
  // 不設 default：沒帶時由 setPolicy 沿用現有值（舊版後台不認識這兩個欄位，不能被當成清空）
  tenantBundles: z.array(z.string()).optional().describe('套用給所有人（含網站訪客）的角色 id；省略＝沿用現值'),
  memberBundles: z.array(z.string()).optional().describe('套用給所有登入員工（不含網站訪客）的角色 id；省略＝沿用現值'),
  // 讀取時拿到的版本：與目前資料不符代表期間有人改過（其他管理者、新表單、人員同步），回 409。
  // 選填以相容舊呼叫端；後台權限頁一律帶上。
  baseVersion: z.string().optional().describe('讀取政策時拿到的版本；與目前不符代表期間有人改過，回 409，避免覆蓋別人的修改'),
});
export type PutPolicyInput = z.infer<typeof putPolicySchema>;

export const changeMyPasswordSchema = z.object({
  currentPassword: z.string().min(1).describe('目前的密碼'),
  newPassword: z.string().min(10, '新密碼長度需為 10 到 128 字元').max(128, '新密碼長度需為 10 到 128 字元').describe('新密碼，10–128 字元'),
});
export type ChangeMyPasswordInput = z.infer<typeof changeMyPasswordSchema>;

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type AddPublicKeyInput = z.infer<typeof addPublicKeySchema>;
export type RevokePublicKeyInput = z.infer<typeof revokePublicKeySchema>;
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
/** 稽核分頁：before 為上一頁的 nextCursor（不透明字串，實為絕對序號） */
export const auditPageQuerySchema = z.object({
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type AuditPageQuery = z.infer<typeof auditPageQuerySchema>;

export const adminReportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().trim().max(200).optional(),
});

export type AdminReportQuery = z.infer<typeof adminReportQuerySchema>;
