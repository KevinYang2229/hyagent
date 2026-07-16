/**
 * LLM provider 工廠：依「租戶 llmConfig → resolveLLMSettings」選擇實作與金鑰。
 * 未帶 config（或租戶未設定）＝現行 env 行為，預設租戶零改變。
 */
import { createAnthropicProvider } from './anthropic.provider';
import { createOpenAIProvider } from './openai.provider';
import { resolveLLMSettings } from './resolve-settings';
import type { LLMProvider, TenantLLMConfig } from './types';

export function getLLMProvider(config?: TenantLLMConfig): LLMProvider {
  const settings = resolveLLMSettings(config);
  // local 為 OpenAI 相容端點，重用 openai provider（差別僅在 settings.baseURL）
  return settings.provider === 'anthropic'
    ? createAnthropicProvider(settings)
    : createOpenAIProvider(settings);
}

export * from './types';
export { resolveLLMSettings, pickModel } from './resolve-settings';
export type { ResolvedLLMSettings, LLMProviderName } from './resolve-settings';
