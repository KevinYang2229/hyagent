/**
 * 權限政策（每租戶）：部門 / 帳號授權表，記憶體 ＋ 可切換持久化後端（env.DATA_BACKEND）。
 * BASE 能力見 scope-catalog（全員預設，不在此表）。政策以 tenantId 隔離，跨租戶互不影響。
 * db 後端：每租戶單列 upsert（setPolicy 本來就是整包覆寫）。開機由 initScopePolicy() 載回。
 */
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

export interface TenantPolicy {
  groups: Record<string, string[]>; // 部門 → scopes
  accounts: Record<string, string[]>; // userId → scopes
}

const STORE_FILE = dataFile('oa-agent-scope-policy.json');
const policies = new Map<string, TenantPolicy>();

const writeQueue = new DbWriteQueue('scope-policy');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...policies.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist scope policy');
  }
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, TenantPolicy][];
      for (const [k, v] of raw) policies.set(k, v);
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore scope policy; starting empty');
  }
}

/**
 * db 後端的開機載入。必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initScopePolicy(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.scopePolicyRow.findMany();
  for (const r of rows) policies.set(r.tenantId, r.data as unknown as TenantPolicy);
  logger.info({ tenants: policies.size }, 'scope policies restored from db');
}

function clone(p: TenantPolicy): TenantPolicy {
  // 深複製內層陣列，避免外部改動污染 store
  const copyMap = (m: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
  return { groups: copyMap(p.groups), accounts: copyMap(p.accounts) };
}

const EMPTY: TenantPolicy = { groups: {}, accounts: {} };

export const scopePolicy = {
  groupScopes(tenantId: string, department?: string): string[] {
    if (!department) return [];
    return policies.get(tenantId)?.groups[department] ?? [];
  },
  accountScopes(tenantId: string, userId: string): string[] {
    return policies.get(tenantId)?.accounts[userId] ?? [];
  },
  /** 取某租戶政策複本（admin 讀取用）。 */
  getPolicy(tenantId: string): TenantPolicy {
    return clone(policies.get(tenantId) ?? EMPTY);
  },
  /** 整包覆寫某租戶政策（admin 儲存用）。 */
  setPolicy(tenantId: string, policy: TenantPolicy): void {
    const next = clone(policy);
    policies.set(tenantId, next);
    if (env.DATA_BACKEND === 'db') {
      const data = JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue;
      writeQueue.enqueue(async (db) => {
        await db.scopePolicyRow.upsert({
          where: { tenantId },
          create: { tenantId, data },
          update: { data },
        });
      });
      return;
    }
    persistFile();
  },
  /** 清空（測試用）。 */
  clear(): void {
    policies.clear();
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.scopePolicyRow.deleteMany({});
      });
      return;
    }
    persistFile();
  },
};
