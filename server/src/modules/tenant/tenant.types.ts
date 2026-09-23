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

/** 公鑰狀態機（規格 §7.3）。撤銷不可逆；停用可再啟用。 */
export type TenantPublicKeyStatus = 'active' | 'disabled' | 'revoked';

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
  /** 最後一次狀態變更時間（停用 / 撤銷 / 重新啟用） */
  statusChangedAt?: string;
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
  createdAt: string;
}
