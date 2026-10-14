/**
 * Embedding provider（用於知識庫 RAG）。
 *
 * Claude 無原生 embedding API，故用 OpenAI text-embedding 系列；
 * 租戶設有自己的 openaiApiKey 時用租戶的 key（BYO，帳單歸租戶），否則用平台 key。
 * 回傳含 tokens 供成本歸戶；索引與查詢共用同一模型/維度。
 */
import OpenAI from 'openai';
import { querySignal, throwIfQueryCancelled } from '@/lib/query-cancellation';
import { assertSafeEgress } from '@/lib/egress-policy';
import { env } from '@/config/env';
import { mapProviderError } from '@/lib/llm/provider-error';
import { AppError } from '@/utils/app-error';
import type { LLMKeySource, TenantLLMConfig } from '@/lib/llm/types';

export interface EmbedResult {
  vectors: number[][];
  /** 本次消耗的 embedding token 數（OpenAI usage.total_tokens） */
  tokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly keySource: LLMKeySource;
  /** 批次向量化；回傳順序與輸入對應；model 可覆寫預設模型 */
  embed(texts: string[], model?: string): Promise<EmbedResult>;
}

// SDK client 以 apiKey|baseURL 快取（同 lib/llm 手法）；延遲建立避免無 key 時啟動失敗
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string, baseURL?: string): OpenAI {
  const cacheKey = `${apiKey}|${baseURL ?? ''}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL });
    clients.set(cacheKey, c);
  }
  return c;
}

function createProvider(apiKey: string, keySource: LLMKeySource, baseURL?: string, tenantId?: string): EmbeddingProvider {
  return {
    model: env.EMBEDDING_MODEL,
    keySource,
    async embed(texts: string[], model?: string): Promise<EmbedResult> {
      throwIfQueryCancelled();
      assertSafeEgress(texts, tenantId);
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      let resp: OpenAI.Embeddings.CreateEmbeddingResponse;
      try {
        resp = await getClient(apiKey, baseURL).embeddings.create({
          model: model ?? env.EMBEDDING_MODEL,
          input: texts,
        }, { signal: querySignal() });
        throwIfQueryCancelled();
      } catch (err) {
        // 租戶 key 失效比照 D6 明確歸因 502；平台 key 原樣拋出（現行行為）
        throw mapProviderError(err, { keySource });
      }
      return { vectors: resp.data.map((d) => d.embedding), tokens: resp.usage?.total_tokens ?? 0 };
    },
  };
}

export function getEmbeddingProvider(config?: TenantLLMConfig, tenantId?: string): EmbeddingProvider {
  // 地端：走部署層 embedding 端點，不涉租戶 key。
  // 端點缺失即丟錯（防禦性第二層；boot superRefine 已擋，比照 resolve-settings 不靜默改打雲端）
  if (env.EMBEDDING_PROVIDER === 'local') {
    if (!env.EMBEDDING_BASE_URL) {
      throw AppError.badGateway('平台未設定地端 embedding 端點（EMBEDDING_BASE_URL），無法使用地端 embedding');
    }
    return createProvider(env.LLM_API_KEY, 'platform', env.EMBEDDING_BASE_URL, tenantId);
  }
  const tenantKey = config?.openaiApiKey?.trim();
  return tenantKey
    ? createProvider(tenantKey, 'tenant', undefined, tenantId)
    : createProvider(env.OPENAI_API_KEY, 'platform', undefined, tenantId);
}
