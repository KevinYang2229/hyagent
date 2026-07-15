/**
 * 每租戶用量計數（MVP）：記憶體 Map ＋ 磁碟持久化，與其他 store 同款。
 *
 * 計數面向：對話建立數、訊息輪數、表單送出數、LLM/embedding token 數（按模型 × key 來源聚合）。
 * 之後接 Prisma / 計費系統時換掉這層即可（介面：increment / get）。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';
import type { LLMKeySource, LLMUsage } from '@/lib/llm/types';

const STORE_FILE = dataFile('oa-agent-usage.json');

export interface ModelTokenUsage {
  model: string;
  keySource: LLMKeySource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TenantUsage {
  conversations: number;
  messages: number;
  submissions: number;
  llmTokens: number;
  embeddingTokens: number;
  /** key = `${keySource}|${model}`；value 自帶 model/keySource，UI 不需解析 key */
  llmByModel: Record<string, ModelTokenUsage>;
}

export type UsageMetric = 'conversations' | 'messages' | 'submissions' | 'llmTokens' | 'embeddingTokens';

const usage = new Map<string, TenantUsage>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...usage.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist usage');
  }
}

function empty(): TenantUsage {
  return { conversations: 0, messages: 0, submissions: 0, llmTokens: 0, embeddingTokens: 0, llmByModel: {} };
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, Partial<TenantUsage>][];
    // 磁碟上的舊紀錄沒有新欄位（embeddingTokens / llmByModel），用 empty() 補齊正規化
    for (const [k, v] of raw) usage.set(k, { ...empty(), ...v });
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore usage; starting empty');
}

function bucket(u: TenantUsage, model: string, keySource: LLMKeySource): ModelTokenUsage {
  const key = `${keySource}|${model}`;
  return (u.llmByModel[key] ??= { model, keySource, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
}

export const usageStore = {
  increment(tenantId: string, metric: UsageMetric, by = 1): void {
    const current = usage.get(tenantId) ?? empty();
    current[metric] += by;
    usage.set(tenantId, current);
    persist();
  },

  /** result 直接餵 LLMResult 即可（provider 已蓋 model/keySource 戳記） */
  recordLLMUsage(
    tenantId: string,
    result?: { usage?: LLMUsage; model?: string; keySource?: LLMKeySource },
  ): void {
    const llmUsage = result?.usage;
    if (!llmUsage) return;
    const total = llmUsage.inputTokens + llmUsage.outputTokens + (llmUsage.cacheReadTokens ?? 0);
    if (total <= 0) return;
    const current = usage.get(tenantId) ?? empty();
    current.llmTokens += total;
    if (result?.model) {
      const b = bucket(current, result.model, result.keySource ?? 'platform');
      b.inputTokens += llmUsage.inputTokens;
      b.outputTokens += llmUsage.outputTokens;
      b.cacheReadTokens += llmUsage.cacheReadTokens ?? 0;
    }
    usage.set(tenantId, current);
    persist();
  },

  recordEmbeddingUsage(tenantId: string, tokens: number, model: string, keySource: LLMKeySource): void {
    if (tokens <= 0) return;
    const current = usage.get(tenantId) ?? empty();
    current.embeddingTokens += tokens;
    bucket(current, model, keySource).inputTokens += tokens;
    usage.set(tenantId, current);
    persist();
  },

  get(tenantId: string): TenantUsage {
    return usage.get(tenantId) ?? empty();
  },
};
