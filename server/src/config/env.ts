import 'dotenv/config';
import { z } from 'zod';

// dev 預設密鑰：僅供本機開發。production 啟動時若仍沿用這些值會 fail-fast（見 superRefine）。
const DEV_JWT_ACCESS_SECRET = 'dev-access-secret-please-change-32chars';
const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-please-change-32char';
const DEV_AUTH_PASSWORD = 'oa1234';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // store 持久化後端：file＝記憶體 Map + JSON 檔（沿用既有行為）；db＝記憶體 Map + Postgres write-through
  // （第一階段僅 tenant store 支援 db，其餘 store 仍走檔案；見 tenant.store.ts）
  DATA_BACKEND: z.enum(['file', 'db']).default('file'),
  // production 仍要用 file 模式時的明示開關（見 superRefine 的 fail-fast）。
  // 不用 z.coerce.boolean()：它把任何非空字串都當 true，連 'false' 也是——安全開關不能有這種陷阱。
  ALLOW_FILE_BACKEND_IN_PRODUCTION: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.enum(['true', 'false', '1', '0']).default('false'),
    )
    .transform((v) => v === 'true' || v === '1'),
  // DATA_BACKEND=db 時必填（Supabase 建議用 session pooler；transaction pooler 需加 ?pgbouncer=true）
  DATABASE_URL: z.string().optional(),
  // Prisma 連線池上限；未設時 lib/db 會套用保守預設（見該檔的 DEFAULT_CONNECTION_LIMIT）。
  // Supabase session pooler 全帳號共用 15 條，Prisma 的原生預設會超過。
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().optional(),
  // 敏感欄位靜態加密金鑰（BYO LLM key / Session 上的使用者識別碼）：64 hex（openssl rand -hex 32）。
  // 未設＝明文落地（dev 便利）；設定後新寫入即加密，舊明文資料開機自動補加密。
  // 空字串視為未設定（測試環境以 '' 固定關閉加密，見 tests/setup-env.ts）
  DATA_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'DATA_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)')
      .optional(),
  ),

  JWT_ACCESS_SECRET: z.string().min(32).default(DEV_JWT_ACCESS_SECRET),
  JWT_REFRESH_SECRET: z.string().min(32).default(DEV_JWT_REFRESH_SECRET),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // MVP 登入：固定 dev 密碼（所有 mock 帳號共用）。之後接真實認證時換掉驗證邏輯即可。
  AUTH_DEV_PASSWORD: z.string().default(DEV_AUTH_PASSWORD),
  // 帳密登入開關。auto＝非 production 開、production 關（安全預設，正式使用者走 SSO）；
  // on＝明確開啟（production 也開，但必須自訂 AUTH_DEV_PASSWORD，見下方 fail-fast）；off＝一律關。
  // 需要這個開關是因為 SSO 得由宿主後端簽票，宿主端還沒接好時整套面板會完全無法登入。
  AUTH_PASSWORD_LOGIN: z.enum(['auto', 'on', 'off']).default('auto'),

  // 結尾斜線容錯：瀏覽器送的 Origin 不帶結尾斜線，env 多打一個 `/` 會比對不到而擋掉
  CORS_ORIGIN: z
    .string()
    .default('*')
    .transform((s) => s.replace(/\/+$/, '')),

  // 預設租戶（向後相容）的允許嵌入網域：'*' 放行全部（維持改造前行為），或逗號分隔網域收緊
  DEFAULT_TENANT_ORIGINS: z
    .string()
    .default('*')
    .transform((s) => s.replace(/\/+$/, '')),

  // 管理 API（建立租戶 / 金鑰 / webhook）的主控密鑰；留空＝停用管理 API（預設關閉以策安全）
  ADMIN_API_KEY: z.string().default(''),

  // 後台登入密碼（換發 admin JWT 用）；留空＝停用後台登入（回 403）。與 ADMIN_API_KEY 分開避免主控金鑰外洩瀏覽器。
  ADMIN_PASSWORD: z.string().default(''),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Empty = do not trust proxy headers; configure only actual reverse proxy IPs/CIDRs.
  TRUST_PROXY: z.string().default(''),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_SSO_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  AUTH_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('App <noreply@example.com>'),

  // ---- Email 連接器（MVP 預設 stub；smtp 為真 SMTP 連接器）----
  EMAIL_CONNECTOR: z.enum(['stub', 'smtp']).default('stub'),

  // ---- LLM provider（可抽換層；支援 anthropic / openai）----
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'local']).default('anthropic'),
  LLM_MODEL: z.string().default('claude-sonnet-4-5'),
  // 意圖分類器（intent-router）專用的便宜/快模型；用 openai 時請改為對應的便宜模型
  LLM_ROUTER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  // ---- 地端 LLM（provider=local；OpenAI 相容端點，如 vLLM / Ollama）----
  // 地端 chat 端點根路徑（含 /v1）；LLM_PROVIDER=local 時必填（見 superRefine）
  LLM_BASE_URL: z.string().optional(),
  // 地端端點通常不驗 key；OpenAI SDK 不接受空 apiKey，故給非空 dummy
  LLM_API_KEY: z.string().default('not-needed'),

  // ---- 知識庫 RAG（靜態網站預先索引）----
  // embedding 供應商：openai=雲端；local=地端 OpenAI 相容 /v1/embeddings
  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
  // 地端 embedding 端點根路徑（含 /v1）；EMBEDDING_PROVIDER=local 時必填
  EMBEDDING_BASE_URL: z.string().optional(),
  // embedding 用 OpenAI（Claude 無原生 embedding），需 OPENAI_API_KEY；索引與查詢共用此模型
  // 精準度優先 → 預設 text-embedding-3-large（3072 維）；要省成本可改 text-embedding-3-small
  EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
  // 每租戶索引檔存放目錄（相對 server 目錄）；檔名為 knowledge-index.<tenantId>.json
  KNOWLEDGE_INDEX_DIR: z.string().default('data'),
  // 兩階段檢索：先向量取候選池，再用 LLM（LLM_ROUTER_MODEL/Haiku）重排出最相關前幾筆
  KNOWLEDGE_RERANK: z.coerce.boolean().default(true),

  // ---- 報告（依知識庫檢索彙整成可下載的報告）----
  // 報告：大綱節數上限。每節各一次檢索 + 一次彙整 LLM，節數直接決定一份報告的成本
  REPORT_MAX_SECTIONS: z.coerce.number().int().min(1).max(12).default(6),
  // 報告：每節交給彙整 LLM 的片段數（與知識庫問答的 FINAL_K 同量級）
  REPORT_SECTION_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  // 報告：產出物保存時數。附件靠對話結束清理，報告沒有對應的生命週期終點，只能靠 TTL。
  // 預設 30 天而非 24 小時：後台的報告查詢頁若只看得到一天內的資料就沒什麼好查的。
  // 代價是 report_docs 的 bytea 會累積（一份約 25KB，md + html 兩列）
  REPORT_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  // 報告表頭產生時間的顯示時區（IANA 時區名）。不能用伺服器本地時間——正式環境跑在 UTC，
  // 會把台北的 09:41 印成 01:41，而裸的日期字串看起來就像本地時間，比 ISO 更容易誤導讀者
  REPORT_TIMEZONE: z.string().default('Asia/Taipei'),
  // 報告：輸出 PDF 用的 Chromium 執行檔路徑。未設時依序探測常見位置（容器裡的
  // /usr/bin/chromium、本機的 Google Chrome）。找不到就只是少一種格式，md 與 html 照常產出。
  REPORT_PDF_BROWSER: z.string().optional(),

  // ---- OA 連接器（MVP 預設 stub；http 為真 OA 連接器）----
  OA_CONNECTOR: z.enum(['stub', 'http']).default('stub'),
  OA_BASE_URL: z.string().optional(),
  OA_API_KEY: z.string().optional(),
  // MCP 呼叫簽章私鑰（ES256 / PKCS#8 PEM，可用 \n 跳脫換行）；未設＝MCP 功能整體停用
  MCP_SIGNING_KEY: z.string().default(''),
  // 換鑰過渡：上一把公鑰（SPKI PEM），仍列在 JWKS 讓 MCP server 驗得過換鑰前簽的 token
  MCP_PREVIOUS_PUBLIC_KEY: z.string().default(''),
  // 影像辨識查詢門市資料用的 MCP serverId（product_lookup／inventory_query／coupon_check 所在服務）
  VISION_STORE_SERVER_ID: z.string().regex(/^[a-z0-9-]{1,32}$/).default('store-demo'),
}).superRefine((val, ctx) => {
  // production 不得沿用 dev 預設密鑰/密碼，boot 時 fail-fast（避免帶著佔位密鑰上線）
  if (val.NODE_ENV === 'production') {
    const insecureDefaults: Array<[string, boolean]> = [
      ['JWT_ACCESS_SECRET', val.JWT_ACCESS_SECRET === DEV_JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', val.JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET],
    ];
    for (const [key, isDefault] of insecureDefaults) {
      if (isDefault) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be overridden in production (still using insecure dev default)`,
        });
      }
    }
    // production 明確開啟帳密登入時，密碼不得沿用公開在 repo 裡的 dev 預設值——
    // 那等於對全世界公開一組可登入的帳密。只在 on 時擋，auto/off 本來就沒開這條路。
    if (val.AUTH_PASSWORD_LOGIN === 'on' && val.AUTH_DEV_PASSWORD === DEV_AUTH_PASSWORD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_DEV_PASSWORD'],
        message:
          'AUTH_DEV_PASSWORD must be overridden when AUTH_PASSWORD_LOGIN=on in production (still using insecure dev default)',
      });
    }
    // file 模式的每一項機制都建立在「只有一個副本」上：記憶體 Map 即 primary、
    // 落檔用 `wx` 當鎖、auth session 與 jti 的索引開機才重建。多副本跑 file 不會報錯，
    // 只會安靜地各自為政——A 副本撤銷的公鑰，B 副本在重啟前仍繼續接受（規格 §2.6 的
    // 「快取 TTL ≤ 30 秒」在這個情況下等同無限），使用者的 Session 也會隨負載平衡時有時無。
    // 單副本 + 持久磁碟是合法部署，所以不是硬擋，而是要求明示：把單副本這個前提寫進環境變數。
    if (val.DATA_BACKEND === 'file' && !val.ALLOW_FILE_BACKEND_IN_PRODUCTION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATA_BACKEND'],
        message:
          'DATA_BACKEND=file assumes a single replica and is refused in production. ' +
          'Set DATA_BACKEND=db (with DATABASE_URL), or set ALLOW_FILE_BACKEND_IN_PRODUCTION=true ' +
          'if this deployment really runs exactly one replica backed by persistent storage.',
      });
    }
  }

  // DATA_BACKEND=db 時必須提供 DATABASE_URL，boot 時 fail-fast
  if (val.DATA_BACKEND === 'db' && !val.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required when DATA_BACKEND=db',
    });
  }
  // OA_CONNECTOR=http 時必須提供 OA_BASE_URL，boot 時 fail-fast
  if (val.OA_CONNECTOR === 'http' && !val.OA_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OA_BASE_URL'],
      message: 'OA_BASE_URL is required when OA_CONNECTOR=http',
    });
  }
  // LLM_PROVIDER=local 時必須提供 LLM_BASE_URL，boot 時 fail-fast
  if (val.LLM_PROVIDER === 'local' && !val.LLM_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_BASE_URL'],
      message: 'LLM_BASE_URL is required when LLM_PROVIDER=local',
    });
  }
  // EMBEDDING_PROVIDER=local 時必須提供 EMBEDDING_BASE_URL，boot 時 fail-fast
  if (val.EMBEDDING_PROVIDER === 'local' && !val.EMBEDDING_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMBEDDING_BASE_URL'],
      message: 'EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=local',
    });
  }
  // EMAIL_CONNECTOR=smtp 時必須提供 SMTP_HOST，boot 時 fail-fast
  if (val.EMAIL_CONNECTOR === 'smtp' && !val.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'SMTP_HOST is required when EMAIL_CONNECTOR=smtp',
    });
  }
  // 依 provider 要求對應的 API key，boot 時 fail-fast
  if (val.LLM_PROVIDER === 'anthropic' && !val.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ANTHROPIC_API_KEY'],
      message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
    });
  }
  if (val.LLM_PROVIDER === 'openai' && !val.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

/**
 * 這個環境是否開放帳密登入。
 *
 * 寫成函式而非常數：測試會在執行期改 `env.NODE_ENV` 驗證 production 行為，
 * 模組載入當下算好的布林值反映不出來。
 */
export function isPasswordLoginEnabled(): boolean {
  if (env.AUTH_PASSWORD_LOGIN === 'on') return true;
  if (env.AUTH_PASSWORD_LOGIN === 'off') return false;
  return env.NODE_ENV !== 'production';
}
