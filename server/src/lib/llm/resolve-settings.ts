/**
 * 租戶 llmConfig → 實際 LLM 連線設定的解析（spec D5 方案 A 的核心規則）。
 *
 * - 未設 provider：平台 provider/model 照舊；若租戶放了「同廠商」的 key，只換帳單歸屬。
 * - 有設 provider：全套用租戶設定，並鎖定模型（router/rerank 的便宜模型覆寫一律忽略，
 *   避免「租戶用 OpenAI 但 router model 是 claude-haiku」的廠商錯配）。
 */
import { env } from '@/config/env';
import type { LLMKeySource, TenantLLMConfig } from './types';

export type LLMProviderName = 'anthropic' | 'openai' | 'local';

/** 租戶自訂 provider 但未指定 model 時的各廠商預設（env.LLM_MODEL 可能是別家的模型名） */
const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  local: 'local-llm',
};

export interface ResolvedLLMSettings {
  provider: LLMProviderName;
  apiKey: string;
  keySource: LLMKeySource;
  model: string;
  /** true = 每呼叫的 model 覆寫一律忽略（租戶自訂 provider 時） */
  lockModel: boolean;
}

function envKeyFor(provider: LLMProviderName): string {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return env.OPENAI_API_KEY;
  return env.LLM_API_KEY; // local
}

function tenantKeyFor(provider: LLMProviderName, config?: TenantLLMConfig): string | undefined {
  if (provider === 'local') return undefined; // local 不支援租戶自訂 key
  const key = provider === 'anthropic' ? config?.anthropicApiKey : config?.openaiApiKey;
  return key && key.trim() ? key : undefined;
}

export function resolveLLMSettings(config?: TenantLLMConfig): ResolvedLLMSettings {
  const provider = config?.provider ?? env.LLM_PROVIDER;
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
