/**
 * LLM provider 工廠：依「租戶 llmConfig → resolveLLMSettings」選擇實作與金鑰。
 * 未帶 config（或租戶未設定）＝現行 env 行為，預設租戶零改變。
 */
import { querySignal, throwIfQueryCancelled } from '@/lib/query-cancellation';
import { assertSafeEgress } from '@/lib/egress-policy';
import { createAnthropicProvider } from './anthropic.provider';
import { createOpenAIProvider } from './openai.provider';
import { resolveLLMSettings } from './resolve-settings';
import type { LLMProvider, TenantLLMConfig } from './types';

export function getLLMProvider(config?: TenantLLMConfig, tenantId?: string): LLMProvider {
  const settings = resolveLLMSettings(config);
  // local 為 OpenAI 相容端點，重用 openai provider（差別僅在 settings.baseURL）
  const provider = settings.provider === 'anthropic'
    ? createAnthropicProvider(settings)
    : createOpenAIProvider(settings);
  return {
    name: provider.name,
    async createMessage(params) {
      throwIfQueryCancelled();
      assertSafeEgress(params, tenantId);
      const result = await provider.createMessage({ ...params, signal: params.signal ?? querySignal() });
      throwIfQueryCancelled();
      return result;
    },
  };
}

export * from './types';
export { resolveLLMSettings, pickModel } from './resolve-settings';
export type { ResolvedLLMSettings, LLMProviderName } from './resolve-settings';
