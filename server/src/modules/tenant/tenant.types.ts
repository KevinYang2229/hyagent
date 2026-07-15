/**
 * 多租戶核心型別。
 *
 * 設計原則：對外整合（widget / SDK / webhook）都掛在「租戶」之下，資料以 tenantId 隔離。
 * 為向後相容，系統內建一個 id='default' 的預設租戶：未帶 API Key 的舊 widget 一律落到此租戶，
 * 行為與改造前相同（見 resolve-tenant middleware 與 tenant.store 的種子資料）。
 */
import type { TenantAppearance } from '@oa-agent/shared';
import type { TenantLLMConfig } from '@/lib/llm/types';

/** 公開金鑰（pk_）可放瀏覽器；秘密金鑰（sk_）只在伺服器端用。 */
export type ApiKeyType = 'publishable' | 'secret';

export interface ApiKey {
  /** 完整金鑰字串：pk_... 或 sk_...（MVP 以明文比對；接 DB 後改存雜湊） */
  key: string;
  tenantId: string;
  type: ApiKeyType;
  createdAt: string;
  /** 撤銷後仍保留紀錄，但驗證時視為無效 */
  revokedAt?: string;
}

export interface Tenant {
  id: string;
  name: string;
  /**
   * widget/SDK 允許嵌入的來源網域清單；['*'] 代表全部放行（預設租戶用，維持改造前的 CORS '*' 行為）。
   * 動態 CORS 與 embed 來源驗證都讀這份清單。
   */
  allowedOrigins: string[];
  /**
   * SSO 共享密鑰（選填）：宿主後端用此密鑰簽發「終端使用者 token」，
   * 我方 /auth/sso/exchange 以此驗章後換發本系統的 access/refresh token。
   * 未設定代表此租戶不啟用 SSO handoff。
   */
  ssoSecret?: string;
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
  /** 是否已完成服務/表單 → scope 的一次性遷移；true 後遷移不再覆寫其授予。 */
  scopesMigrated?: boolean;
  /**
   * 租戶自帶 AI 設定（BYO key，spec 2026-07-14）：provider/model/兩家 key。
   * 未設＝平台 env 設定；讀寫一律走 llmConfigService（合併/驗證/遮罩/稽核）。
   */
  llmConfig?: TenantLLMConfig;
  createdAt: string;
}
