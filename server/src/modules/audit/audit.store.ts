/**
 * 工具稽核紀錄（每租戶）：in-memory + 磁碟持久化，每租戶保留最近 N 筆。
 * 只由 toolRegistry.invoke 對 audit 工具寫入；旁路性質——記錄失敗不得影響主流程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';

export interface AuditEntry {
  toolId: string;
  userId: string;
  at: string;
  ok: boolean;
  summary: string;
  error?: string;
}

const MAX_PER_TENANT = 500;
const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-audit.json');
const logs = new Map<string, AuditEntry[]>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...logs.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist audit log');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, AuditEntry[]][];
    for (const [k, v] of raw) logs.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore audit log; starting empty');
}

export const auditStore = {
  record(tenantId: string, entry: AuditEntry): void {
    const arr = logs.get(tenantId) ?? [];
    arr.push(entry);
    if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT); // 捨最舊
    logs.set(tenantId, arr);
    persist();
  },
  /** 回最近 limit 筆（新→舊）。 */
  list(tenantId: string, limit = 100): AuditEntry[] {
    const arr = logs.get(tenantId) ?? [];
    return [...arr].reverse().slice(0, limit);
  },
  clear(): void {
    logs.clear();
    persist();
  },
};
