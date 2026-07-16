/**
 * 租戶 AI 設定（BYO key）的唯一讀寫入口：合併三態 patch、存前驗證金鑰、
 * 回應一律遮罩、異動寫 audit。自助（sk_）與 admin 兩條路由共用。
 */
import { env } from '@/config/env';
import { verifyLLMKey } from '@/lib/llm/verify-key';
import type { TenantLLMConfig } from '@/lib/llm/types';
import { auditStore } from '@/modules/audit/audit.store';
import { AppError } from '@/utils/app-error';
import type { PutLLMConfigInput } from './llm-config.schema';
import { tenantStore } from './tenant.store';

export interface LLMConfigView {
  // 'local'：租戶可選地端模型，免雲端 key；實際端點只由部署層 env.LLM_BASE_URL 決定
  // （見 resolve-settings.ts），租戶端不攜帶任何 URL。
  provider: 'anthropic' | 'openai' | 'local' | null;
  model: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
}

/** 頭 7 尾 4，中間以 … 取代；完整 key 絕不外流 */
export function maskKey(key: string): string {
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function toView(config?: TenantLLMConfig): LLMConfigView {
  return {
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    anthropicApiKey: config?.anthropicApiKey ? maskKey(config.anthropicApiKey) : null,
    openaiApiKey: config?.openaiApiKey ? maskKey(config.openaiApiKey) : null,
  };
}

function ensureTenant(tenantId: string) {
  const tenant = tenantStore.getTenant(tenantId);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

/** 三態合併：undefined=不變、null=清除、值=覆寫 */
function mergeField<K extends keyof TenantLLMConfig>(
  merged: TenantLLMConfig,
  patch: PutLLMConfigInput,
  field: K,
): void {
  const v = patch[field as keyof PutLLMConfigInput];
  if (v === undefined) return;
  if (v === null) delete merged[field];
  else merged[field] = v as TenantLLMConfig[K];
}

export const llmConfigService = {
  get(tenantId: string): LLMConfigView {
    return toView(ensureTenant(tenantId).llmConfig);
  },

  async update(tenantId: string, patch: PutLLMConfigInput, actor: string): Promise<LLMConfigView> {
    const tenant = ensureTenant(tenantId);
    const merged: TenantLLMConfig = { ...tenant.llmConfig };
    mergeField(merged, patch, 'provider');
    mergeField(merged, patch, 'model');
    mergeField(merged, patch, 'anthropicApiKey');
    mergeField(merged, patch, 'openaiApiKey');

    // 規則檢查（合併後整體看）：model 沒有 provider 就無意義（spec 路由規則只認 provider）
    if (merged.model && !merged.provider) {
      throw AppError.badRequest('model 需搭配 provider 一併設定');
    }
    // 雲端 provider 指定後，該廠商必須有可用金鑰（租戶自帶或平台 env），否則 runtime 必炸
    if (merged.provider && merged.provider !== 'local') {
      const tenantKey = merged.provider === 'anthropic' ? merged.anthropicApiKey : merged.openaiApiKey;
      const envKey = merged.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (!tenantKey && !envKey) {
        throw AppError.badRequest(`供應商 ${merged.provider} 沒有可用金鑰，請一併提供 key`);
      }
    }
    // 地端 provider：需部署層已設 endpoint，否則 runtime 會誤打雲端（違反不外流原則）
    if (merged.provider === 'local' && !env.LLM_BASE_URL) {
      throw AppError.badRequest('平台未設定地端模型端點，無法選用地端模型');
    }
    // 只驗證「本次新提供」的 key（既存 key 已驗過；清除不需驗）
    if (patch.anthropicApiKey) {
      if (!(await verifyLLMKey('anthropic', patch.anthropicApiKey))) {
        throw AppError.badRequest('Anthropic 金鑰驗證失敗，請確認金鑰有效');
      }
    }
    if (patch.openaiApiKey) {
      if (!(await verifyLLMKey('openai', patch.openaiApiKey))) {
        throw AppError.badRequest('OpenAI 金鑰驗證失敗，請確認金鑰有效');
      }
    }

    const next = Object.keys(merged).length > 0 ? merged : undefined;
    tenantStore.updateTenant(tenantId, { llmConfig: next });

    // 稽核只記「動了哪些欄位」，絕不記 key 內容
    const changed = (Object.keys(patch) as Array<keyof PutLLMConfigInput>).map((k) =>
      patch[k] === null ? `${k}(清除)` : k,
    );
    auditStore.record(tenantId, {
      toolId: 'tenant.llm-config.update',
      userId: actor,
      at: new Date().toISOString(),
      ok: true,
      summary: `更新 AI 模型設定：${changed.join('、')}`,
    });

    return toView(next);
  },
};
