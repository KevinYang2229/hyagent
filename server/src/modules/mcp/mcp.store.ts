/**
 * MCP server 登記 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND），寫法同 webhook.store。
 * db 後端：每 server 一列（data jsonb 整包）；開機由 initMcpStore() 載回。
 * 不存任何憑證：呼叫身分由後端每請求簽發 JWT（見 mcp.identity）。
 */
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_SERVER_ID_RE,
  type McpServerConfig,
  type McpServerCreateInput,
  type McpServerPatch,
} from './mcp.types';

const STORE_FILE = dataFile('oa-agent-mcp-servers.json');
const servers = new Map<string, McpServerConfig>();
const writeQueue = new DbWriteQueue('mcp-servers');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...servers.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist mcp servers');
  }
}

function upsertToDb(s: McpServerConfig): void {
  const data = JSON.parse(JSON.stringify(s)) as Prisma.InputJsonValue;
  const row = { id: s.id, ownerTenantId: s.ownerTenantId, data, createdAt: new Date(s.createdAt) };
  writeQueue.enqueue(async (db) => {
    await db.mcpServerRow.upsert({ where: { id: row.id }, create: row, update: { ownerTenantId: row.ownerTenantId, data } });
  });
}

function deleteFromDb(where: { id: string } | { ownerTenantId: string }): void {
  writeQueue.enqueue(async (db) => {
    await db.mcpServerRow.deleteMany({ where });
  });
}

function save(s: McpServerConfig): void {
  servers.set(s.id, s);
  if (env.DATA_BACKEND === 'db') upsertToDb(s);
  else persistFile();
}

// file 後端：模組載入即同步還原
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as McpServerConfig[];
      for (const s of raw) servers.set(s.id, s);
      logger.info({ count: servers.size }, 'mcp servers restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore mcp servers; starting empty');
  }
}

/** db 後端的開機載入；file 後端為 no-op。必須在開始服務請求前 await。 */
export async function initMcpStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.mcpServerRow.findMany();
  for (const r of rows) {
    const s = r.data as unknown as McpServerConfig;
    servers.set(s.id, s);
  }
  logger.info({ count: servers.size }, 'mcp servers restored from db');
}

export const mcpStore = {
  list(): McpServerConfig[] {
    return [...servers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  get(id: string): McpServerConfig | undefined {
    return servers.get(id);
  },

  /** 此 server 是否屬於此租戶可見範圍（共用或其專屬），不看啟用狀態——授權驗證用。 */
  belongsTo(s: McpServerConfig, tenantId: string): boolean {
    return s.ownerTenantId === null || s.ownerTenantId === tenantId;
  },

  /** 此租戶可用的 server：已啟用，且共用或屬於該租戶。 */
  listVisibleTo(tenantId: string): McpServerConfig[] {
    return this.list().filter((s) => s.enabled && this.belongsTo(s, tenantId));
  },

  create(input: McpServerCreateInput): McpServerConfig {
    if (!MCP_SERVER_ID_RE.test(input.id)) {
      throw AppError.badRequest(`serverId 只允許小寫英數與連字號、1–32 字：${input.id}`);
    }
    if (servers.has(input.id)) throw AppError.conflict(`serverId 已存在：${input.id}`);
    const s: McpServerConfig = {
      id: input.id,
      name: input.name,
      url: input.url,
      ownerTenantId: input.ownerTenantId ?? null,
      description: input.description ?? '',
      keywords: input.keywords ?? [],
      timeoutMs: input.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
      enabled: input.enabled ?? true,
      toolOverrides: input.toolOverrides ?? {},
      auth: { mode: 'hyagent-jwt' },
      createdAt: new Date().toISOString(),
    };
    save(s);
    return s;
  },

  update(id: string, patch: McpServerPatch): McpServerConfig {
    const cur = servers.get(id);
    if (!cur) throw AppError.notFound(`MCP server 不存在：${id}`);
    const next: McpServerConfig = { ...cur, ...patch, id: cur.id, auth: cur.auth, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
    save(next);
    return next;
  },

  remove(id: string): boolean {
    if (!servers.delete(id)) return false;
    if (env.DATA_BACKEND === 'db') deleteFromDb({ id });
    else persistFile();
    return true;
  },

  /** 刪租戶級聯：移除該租戶專屬的 server */
  purgeTenant(tenantId: string): void {
    for (const [id, s] of servers) {
      if (s.ownerTenantId === tenantId) servers.delete(id);
    }
    if (env.DATA_BACKEND === 'db') deleteFromDb({ ownerTenantId: tenantId });
    else persistFile();
  },

  /** 測試用：清空 */
  clear(): void {
    servers.clear();
    if (env.DATA_BACKEND !== 'db') persistFile();
  },
};
