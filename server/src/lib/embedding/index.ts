/**
 * Embedding provider（用於知識庫 RAG）。
 *
 * Claude 無原生 embedding API，故用 OpenAI text-embedding 系列；
 * 租戶設有自己的 openaiApiKey 時用租戶的 key（BYO，帳單歸租戶），否則用平台 key。
 * 回傳含 tokens 供成本歸戶；索引與查詢共用同一模型/維度。
 */
import OpenAI from 'openai';
import { env } from '@/config/env';
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

// SDK client 以 apiKey 快取（同 lib/llm 手法）；延遲建立避免無 key 時啟動失敗
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

function createProvider(apiKey: string, keySource: LLMKeySource): EmbeddingProvider {
  return {
    model: env.EMBEDDING_MODEL,
    keySource,
    async embed(texts: string[], model?: string): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      const resp = await getClient(apiKey).embeddings.create({
        model: model ?? env.EMBEDDING_MODEL,
        input: texts,
      });
      return { vectors: resp.data.map((d) => d.embedding), tokens: resp.usage?.total_tokens ?? 0 };
    },
  };
}

export function getEmbeddingProvider(config?: TenantLLMConfig): EmbeddingProvider {
  const tenantKey = config?.openaiApiKey?.trim();
  return tenantKey ? createProvider(tenantKey, 'tenant') : createProvider(env.OPENAI_API_KEY, 'platform');
}
