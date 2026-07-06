/**
 * 每租戶用量計數（MVP）：記憶體 Map ＋ 磁碟持久化，與其他 store 同款。
 *
 * 計數面向：對話建立數、訊息輪數、表單送出數、LLM token 數。
 * 之後接 Prisma / 計費系統時換掉這層即可（介面：increment / get）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { LLMUsage } from '@/lib/llm/types';

const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-usage.json');

export interface TenantUsage {
  conversations: number;
  messages: number;
  submissions: number;
  llmTokens: number;
}

export type UsageMetric = keyof TenantUsage;

const usage = new Map<string, TenantUsage>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...usage.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist usage');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, TenantUsage][];
    for (const [k, v] of raw) usage.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore usage; starting empty');
}

function empty(): TenantUsage {
  return { conversations: 0, messages: 0, submissions: 0, llmTokens: 0 };
}

export const usageStore = {
  increment(tenantId: string, metric: UsageMetric, by = 1): void {
    const current = usage.get(tenantId) ?? empty();
    current[metric] += by;
    usage.set(tenantId, current);
    persist();
  },

  recordLLMUsage(tenantId: string, llmUsage?: LLMUsage): void {
    if (!llmUsage) return;
    const total =
      llmUsage.inputTokens + llmUsage.outputTokens + (llmUsage.cacheReadTokens ?? 0);
    if (total <= 0) return;
    this.increment(tenantId, 'llmTokens', total);
  },

  get(tenantId: string): TenantUsage {
    return usage.get(tenantId) ?? empty();
  },
};
