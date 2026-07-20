/**
 * 每租戶用量計數：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND）。
 *
 * 計數面向：對話建立數、訊息輪數、表單送出數、LLM/embedding token 數（按模型 × key 來源聚合）。
 * 本質是聚合計數器（非事件流水），db 後端做「每租戶單列 upsert」：只重寫變動租戶那一列。
 * 開機由 initUsageStore() 載回（index.ts 於 listen 前呼叫）。
 */
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
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
  /** 月度 LLM+embedding token 分桶：key = 'YYYY-MM'；月配額守門（tenant-quota middleware）讀當月值 */
  monthlyLlmTokens: Record<string, number>;
}

export type UsageMetric = 'conversations' | 'messages' | 'submissions' | 'llmTokens' | 'embeddingTokens';

const usage = new Map<string, TenantUsage>();

const writeQueue = new DbWriteQueue('usage');

/** 變更後呼叫：file 整包重寫；db 只 upsert 該租戶一列（計數器聚合，非事件流水） */
function persist(tenantId: string): void {
  if (env.DATA_BACKEND === 'db') {
    const current = usage.get(tenantId);
    if (!current) return;
    // 快照於呼叫當下取定（與其他 store 同語意）
    const data = JSON.parse(JSON.stringify(current)) as Prisma.InputJsonValue;
    writeQueue.enqueue(async (db) => {
      await db.tenantUsageRow.upsert({
        where: { tenantId },
        create: { tenantId, data },
        update: { data },
      });
    });
    return;
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...usage.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist usage');
  }
}

function empty(): TenantUsage {
  return { conversations: 0, messages: 0, submissions: 0, llmTokens: 0, embeddingTokens: 0, llmByModel: {}, monthlyLlmTokens: {} };
}

/** 當月分桶 key（UTC，'YYYY-MM'） */
export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, Partial<TenantUsage>][];
      // 磁碟上的舊紀錄沒有新欄位（embeddingTokens / llmByModel），用 empty() 補齊正規化
      for (const [k, v] of raw) usage.set(k, { ...empty(), ...v });
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore usage; starting empty');
  }
}

/**
 * db 後端的開機載入：連 DB、還原各租戶計數（舊列缺新欄位同樣以 empty() 補齊）。
 * 必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initUsageStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.tenantUsageRow.findMany();
  for (const r of rows) usage.set(r.tenantId, { ...empty(), ...(r.data as Partial<TenantUsage>) });
  logger.info({ tenants: usage.size }, 'usage restored from db');
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
    persist(tenantId);
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
    current.monthlyLlmTokens[monthKey()] = (current.monthlyLlmTokens[monthKey()] ?? 0) + total;
    if (result?.model) {
      const b = bucket(current, result.model, result.keySource ?? 'platform');
      b.inputTokens += llmUsage.inputTokens;
      b.outputTokens += llmUsage.outputTokens;
      b.cacheReadTokens += llmUsage.cacheReadTokens ?? 0;
    }
    usage.set(tenantId, current);
    persist(tenantId);
  },

  recordEmbeddingUsage(tenantId: string, tokens: number, model: string, keySource: LLMKeySource): void {
    if (tokens <= 0) return;
    const current = usage.get(tenantId) ?? empty();
    current.embeddingTokens += tokens;
    current.monthlyLlmTokens[monthKey()] = (current.monthlyLlmTokens[monthKey()] ?? 0) + tokens;
    bucket(current, model, keySource).inputTokens += tokens;
    usage.set(tenantId, current);
    persist(tenantId);
  },

  get(tenantId: string): TenantUsage {
    return usage.get(tenantId) ?? empty();
  },

  /** 當月已用 LLM+embedding token（月配額守門用） */
  currentMonthLlmTokens(tenantId: string): number {
    return usage.get(tenantId)?.monthlyLlmTokens[monthKey()] ?? 0;
  },

  /** 移除某租戶用量計數（刪租戶級聯清理用） */
  purgeTenant(tenantId: string): void {
    usage.delete(tenantId);
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.tenantUsageRow.deleteMany({ where: { tenantId } });
      });
      return;
    }
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify([...usage.entries()]));
    } catch (err) {
      logger.warn({ err, file: STORE_FILE }, 'failed to persist usage');
    }
  },
};
