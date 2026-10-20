/**
 * 多租戶核心型別。
 *
 * 設計原則：對外整合（widget / SDK / webhook）都掛在「租戶」之下，資料以 tenantId 隔離。
 * 為向後相容，系統內建一個 id='default' 的預設租戶：未帶 API Key 的舊 widget 一律落到此租戶，
 * 行為與改造前相同（見 resolve-tenant middleware 與 tenant.store 的種子資料）。
 */
import type { Applicant, TenantAppearance } from '@hyagent/shared';
import type { TenantLLMConfig } from '@/lib/llm/types';
import type { AssertionAlgorithm } from '@/lib/assertion';
import type { AdminActor } from '@/modules/audit/admin-audit';

/** 公開金鑰（pk_）可放瀏覽器；秘密金鑰（sk_）只在伺服器端用。 */
export type ApiKeyType = 'publishable' | 'secret';

export interface ApiKey {
  /**
   * 金鑰的 sha256 雜湊（hex）；原始 pk_/sk_ 字串只在 createApiKey 回傳值出現一次，不落地。
   * 驗證走 tenantStore.getApiKey(raw)（內部雜湊後比對）。
   */
  key: string;
  tenantId: string;
  type: ApiKeyType;
  createdAt: string;
  /** 撤銷後仍保留紀錄，但驗證時視為無效 */
  revokedAt?: string;
}

/** 知識庫可見性標籤（租戶自訂分類） */
export interface KnowledgeLabel {
  /** 小寫英數與連字號；scope id 為 kb:<id> */
  id: string;
  /** 顯示名稱，如「人資文件」 */
  label: string;
}

/**
 * 公鑰狀態機（規格 §7.3）：只有 active → revoked 一條路，撤銷不可逆。
 *
 * 改版前另有可再啟用的 `disabled`，但它與撤銷的效果完全相同（憑證一律被拒、Session 一併
 * 作廢），唯一差別是「能救回來」——而輪替完成後舊私鑰應已銷毀（§2.5 步驟 6），救回來
 * 只是多開一條沒人記得的路。「正常退役」與「外洩」的區別改記在 {@link KeyRevocationReason}。
 */
export type TenantPublicKeyStatus = 'active' | 'revoked';

/**
 * 撤銷原因（規格 §7.3）。不影響驗證行為，只供稽核：事後回頭查時，「這把是例行輪替退掉的，
 * 還是私鑰外洩被撤的」是第一個要回答的問題。
 *
 * - `rotated`：輪替汰換（撤舊的）。必須還有另一把 active 接手，否則等於停止服務（LAST_ACTIVE_KEY）
 * - `aborted`：放棄輪替（撤新的）。同樣必須還有另一把 active——放棄輪替的前提就是舊金鑰繼續用
 * - `compromised`：私鑰外洩或疑似外洩。允許撤銷最後一把——安全優先於可用性
 * - `other`：其他，例如上傳錯誤、停止服務
 */
export type KeyRevocationReason = 'rotated' | 'aborted' | 'compromised' | 'other';

/**
 * 公鑰的操作者（規格 §7.3 稽核欄位）。
 *
 * 後台沒有個人帳號（共用一組 ADMIN_PASSWORD，JWT 的 sub 一律是 admin），因此只記系統
 * **確實驗證得了**的部分：從哪個管道進來、來源 IP。不收自填姓名——驗證不了的欄位放進
 * 稽核紀錄，事後反而會被當成證據引用。
 */
export interface KeyOperator {
  /** `admin`＝後台密碼登入；`admin-api-key`＝機器對機器的 x-admin-key */
  via: AdminActor;
  ip?: string;
}

/**
 * 租戶註冊的 Assertion 簽章公鑰（規格 §2.5、§7.3）。
 *
 * 取代了改造前的 `ssoSecret`（HS256 共享密鑰）。根本差別在於這裡存的是**公鑰**，
 * 本就可公開，因此不進 sealTenant 的加密範圍——對它加密只會製造「以為受保護」的錯覺，
 * 並讓 kid 比對多一層解密成本。HyAgent 自此不再持有任何可偽造客戶身分的秘密。
 */
export interface TenantPublicKey {
  /** RFC 7638 JWK Thumbprint，一律由後端算出，不接受呼叫端指定 */
  kid: string;
  alg: AssertionAlgorithm;
  /** SPKI PEM（規格 §2.3）；上傳 JWK 時由後端正規化成這個形式 */
  publicKey: string;
  status: TenantPublicKeyStatus;
  /** 後台顯示用備註，例如「2026 正式環境」 */
  label?: string;
  createdAt: string;
  /** 改版前的舊紀錄、以及非經管理 API 寫入的（測試、維運腳本）沒有操作者 */
  createdBy?: KeyOperator;
  revokedAt?: string;
  /** 改版前撤銷的舊紀錄沒有這個欄位，後台顯示為「未記錄」 */
  revokedReason?: KeyRevocationReason;
  revokedBy?: KeyOperator;
}

export interface Tenant {
  id: string;
  name: string;
  /** Administrator-maintained directory, scoped to this tenant. */
  userDirectory?: Array<Applicant & { deputyIds?: string[] }>;
  /**
   * widget/SDK 允許嵌入的來源網域清單；['*'] 代表全部放行（預設租戶用，維持改造前的 CORS '*' 行為）。
   * 動態 CORS 與 embed 來源驗證都讀這份清單。
   */
  allowedOrigins: string[];
  /**
   * Identity Assertion 簽章公鑰（規格 §2.5）。最多 2 把 active，且恆保有至少 1 把——
   * 不變條件由後端強制（§7.3 明文「不得僅在 UI 層」），見 tenant-keys.ts。
   */
  publicKeys?: TenantPublicKey[];
  /**
   * 時鐘偏移容忍秒數（規格 §10.4、§4.3）。未設＝預設 15。
   * 範圍 0～30，且**不得**超過 assertionLifetimeSeconds 的 ¼。
   */
  clockSkewSeconds?: number;
  /**
   * 此租戶的 Identity Endpoint 簽發的 Assertion 有效期（`exp - iat`），規格 §4.3。
   * 未設＝規格建議的 60。範圍 30～300。
   *
   * HyAgent 不簽發 Assertion，這個值是**客戶告知**的事實，不是我們強制的參數；
   * 記它的唯一理由是 §4.3 的「skew 不得超過該 Tenant 有效期的 ¼」需要一個可比對的基準——
   * 沒有它，那條規則在後端就無從執行，只會變成寫在文件裡沒人擋的建議。
   */
  assertionLifetimeSeconds?: number;
  /** HyAgent Session 有效秒數（規格 §7.1）。未設＝預設 3600，範圍 300～28800。 */
  sessionExpiresIn?: number;
  /**
   * 是否允許免登入的訪客 Session（POST /api/auth/guest）。未設＝關閉。
   *
   * 給沒有登入機制的公開 App 用（例如產品導覽 App）：帶此租戶的 pk_ 就能換一個訪客 Session，
   * 權限只有「訪客部門」（'—'）那一份，與 widget 訪客同一套。關閉後既有訪客 Session 在下一個
   * 請求即失效（requireAuth 每次重驗這個開關），不必另外作廢。
   */
  guestAccess?: boolean;
  /** widget 外觀設定（admin 後台維護）；未設則 widget 用內建預設 */
  appearance?: TenantAppearance;
  /** 停用的 agent 服務 id（如 ['knowledge']）；空/未設 = 全部啟用（opt-out） */
  disabledServices?: string[];
  /** 停用的表單 id（如 ['business-trip-domestic']）；空/未設 = 全部啟用（opt-out） */
  disabledForms?: string[];
  /**
   * 此租戶已開通（買了）哪些能力 scope，如 ['email:write']。
   * 與群組/帳號政策一起併入 resolveScopes；未設＝不額外授權（仍有 BASE_SCOPES）。
   */
  grantedScopes?: string[];
  /** 知識庫可見性標籤目錄（租戶自訂分類）。id 進 scope 體系時前綴 kb:。 */
  knowledgeLabels?: KnowledgeLabel[];
  /** 是否已完成服務/表單 → scope 的一次性遷移；true 後遷移不再覆寫其授予。 */
  scopesMigrated?: boolean;
  /**
   * 租戶自帶 AI 設定（BYO key，spec 2026-07-14）：provider/model/兩家 key。
   * 未設＝平台 env 設定；讀寫一律走 llmConfigService（合併/驗證/遮罩/稽核）。
   */
  llmConfig?: TenantLLMConfig;
  /** 月度 LLM token 配額（LLM+embedding 合計）；0 或未設＝不限。超過由 tenant-quota middleware 回 429。 */
  quotaMonthlyLlmTokens?: number;
  egressPolicy?: import('@/lib/egress-policy').EgressPolicy;
  createdAt: string;
}
