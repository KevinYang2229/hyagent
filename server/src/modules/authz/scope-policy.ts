/**
 * 權限政策（每租戶）：部門 / 帳號授權表，in-memory + 磁碟持久化（比照 usage.store）。
 * BASE 能力見 scope-catalog（全員預設，不在此表）。政策以 tenantId 隔離，跨租戶互不影響。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';

export interface TenantPolicy {
  groups: Record<string, string[]>; // 部門 → scopes
  accounts: Record<string, string[]>; // userId → scopes
}

const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-scope-policy.json');
const policies = new Map<string, TenantPolicy>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...policies.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist scope policy');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, TenantPolicy][];
    for (const [k, v] of raw) policies.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore scope policy; starting empty');
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
    policies.set(tenantId, clone(policy));
    persist();
  },
  /** 清空（測試用）。 */
  clear(): void {
    policies.clear();
    persist();
  },
};
