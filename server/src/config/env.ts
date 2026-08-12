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
  // DATA_BACKEND=db 時必填（Supabase 建議用 session pooler；transaction pooler 需加 ?pgbouncer=true）
  DATABASE_URL: z.string().optional(),
  // 敏感欄位靜態加密金鑰（BYO LLM key / ssoSecret）：64 hex（openssl rand -hex 32）。
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
  // 報告：產出物保存時數。附件靠對話結束清理，報告沒有對應的生命週期終點，只能靠 TTL
  REPORT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // ---- OA 連接器（MVP 預設 stub；http 為真 OA 連接器）----
  OA_CONNECTOR: z.enum(['stub', 'http']).default('stub'),
  OA_BASE_URL: z.string().optional(),
  OA_API_KEY: z.string().optional(),
}).superRefine((val, ctx) => {
  // production 不得沿用 dev 預設密鑰/密碼，boot 時 fail-fast（避免帶著佔位密鑰上線）
  if (val.NODE_ENV === 'production') {
    const insecureDefaults: Array<[string, boolean]> = [
      ['JWT_ACCESS_SECRET', val.JWT_ACCESS_SECRET === DEV_JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', val.JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET],
      ['AUTH_DEV_PASSWORD', val.AUTH_DEV_PASSWORD === DEV_AUTH_PASSWORD],
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
