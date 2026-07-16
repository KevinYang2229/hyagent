/**
 * 租戶 llmConfig → 實際 LLM 連線設定的解析（spec D5 方案 A 的核心規則）。
 *
 * - provider=local：走部署層地端 endpoint（LLM_BASE_URL），不涉租戶 key，
 *   絕不 fallback 雲端；端點缺失即丟錯。
 * - 未設 provider：平台 provider/model 照舊；若租戶放了「同廠商」的 key，只換帳單歸屬。
 * - 有設雲端 provider：全套用租戶設定，並鎖定模型（router/rerank 覆寫一律忽略）。
 */
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';
import type { LLMKeySource, TenantLLMConfig } from './types';

export type LLMProviderName = 'anthropic' | 'openai' | 'local';

/** 雲端 provider 未指定 model 時的內建預設（local 無通用預設名，改走 env.LLM_MODEL） */
const DEFAULT_MODELS: Record<'anthropic' | 'openai', string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
};

export interface ResolvedLLMSettings {
  provider: LLMProviderName;
  apiKey: string;
  keySource: LLMKeySource;
  model: string;
  /** 地端 OpenAI 相容端點；雲端為 undefined（用 SDK 內建位址） */
  baseURL?: string;
  /** true = 每呼叫的 model 覆寫一律忽略（租戶自訂 provider 時） */
  lockModel: boolean;
}

function envKeyFor(provider: 'anthropic' | 'openai'): string {
  return provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
}

function tenantKeyFor(
  provider: 'anthropic' | 'openai',
  config?: TenantLLMConfig,
): string | undefined {
  const key = provider === 'anthropic' ? config?.anthropicApiKey : config?.openaiApiKey;
  return key && key.trim() ? key : undefined;
}

export function resolveLLMSettings(config?: TenantLLMConfig): ResolvedLLMSettings {
  const provider = config?.provider ?? env.LLM_PROVIDER;

  // 地端：部署層 endpoint，不涉租戶 key；缺 endpoint 即丟錯（絕不靜默走雲端）
  if (provider === 'local') {
    if (!env.LLM_BASE_URL) {
      throw AppError.badRequest('平台未設定地端模型端點（LLM_BASE_URL），無法使用地端模型');
    }
    return {
      provider: 'local',
      apiKey: env.LLM_API_KEY,
      keySource: 'platform',
      baseURL: env.LLM_BASE_URL,
      model: config?.model ?? env.LLM_MODEL,
      lockModel: Boolean(config?.provider),
    };
  }

  // 以下 provider 收斂為 anthropic | openai
  const tenantKey = tenantKeyFor(provider, config);
  const apiKey = tenantKey ?? envKeyFor(provider);
  const keySource: LLMKeySource = tenantKey ? 'tenant' : 'platform';

  if (config?.provider) {
    return {
      provider,
      apiKey,
      keySource,
      model:
        config.model ?? (provider === env.LLM_PROVIDER ? env.LLM_MODEL : DEFAULT_MODELS[provider]),
      lockModel: true,
    };
  }
  return { provider, apiKey, keySource, model: env.LLM_MODEL, lockModel: false };
}

/** 每次呼叫實際使用的模型：鎖定時一律租戶模型；否則呼叫端覆寫優先 */
export function pickModel(settings: ResolvedLLMSettings, requested?: string): string {
  return settings.lockModel ? settings.model : (requested ?? settings.model);
}
