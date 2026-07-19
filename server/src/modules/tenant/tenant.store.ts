/**
 * 租戶 / API Key store：記憶體 Map ＋ 可切換的持久化後端（env.DATA_BACKEND）。
 *
 * - file（預設）：JSON 檔（與 conversation.store 同款），跨 dev 重啟留得住。
 * - db：Postgres（Prisma）write-through——讀寫仍走同步的記憶體 Map，介面不變，
 *   每次變更把整份快照序列化寫進 DB（單 instance 前提，與 file 語意相同）。
 *   開機須先 await initTenantStore() 載回資料（index.ts 於 listen 前呼叫）。
 *
 * 啟動時一定會種一個 id='default' 的預設租戶與其 pk_/sk_ 金鑰，作為「未帶 key 的舊 widget」落點，
 * 確保向後相容。允許網域預設 '*'（沿用改造前 CORS 全放行）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { ApiKey, ApiKeyType, Tenant } from './tenant.types';

const STORE_FILE = dataFile('oa-agent-tenants.json');

export const DEFAULT_TENANT_ID = 'default';
// 預設租戶的固定金鑰：方便 dev / 既有部署沿用；正式租戶請用 createApiKey 另發。
const DEFAULT_PUBLISHABLE_KEY = 'pk_default';
const DEFAULT_SECRET_KEY = 'sk_default';

interface StoreShape {
  tenants: Tenant[];
  apiKeys: ApiKey[];
}

const tenants = new Map<string, Tenant>();
// 以金鑰字串為 key，查得快
const apiKeys = new Map<string, ApiKey>();

// ---- row 映射（db 後端用；pure，供測試 round-trip）----
// 穩定欄位開實體 column，其餘選填欄位收進 config jsonb（見 prisma/schema.prisma）。

export interface TenantDbRow {
  id: string;
  name: string;
  config: unknown;
  createdAt: Date;
}

export interface ApiKeyDbRow {
  key: string;
  tenantId: string;
  type: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export function tenantToRow(t: Tenant): TenantDbRow {
  const { id, name, createdAt, ...config } = t;
  // 與 file 後端同語意：undefined 欄位（如 llmConfig 整包清除）序列化時剔除
  return { id, name, createdAt: new Date(createdAt), config: JSON.parse(JSON.stringify(config)) };
}

export function tenantFromRow(row: TenantDbRow): Tenant {
  return {
    ...(row.config as Omit<Tenant, 'id' | 'name' | 'createdAt'>),
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

export function apiKeyToRow(k: ApiKey): ApiKeyDbRow {
  return {
    key: k.key,
    tenantId: k.tenantId,
    type: k.type,
    createdAt: new Date(k.createdAt),
    revokedAt: k.revokedAt ? new Date(k.revokedAt) : null,
  };
}

export function apiKeyFromRow(row: ApiKeyDbRow): ApiKey {
  return {
    key: row.key,
    tenantId: row.tenantId,
    type: row.type as ApiKeyType,
    createdAt: row.createdAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  };
}

// ---- db 後端：write-through（快照整份寫回，與 file 語意一致；寫入依序排隊）----

const writeQueue = new DbWriteQueue('tenants');

function snapshot(): StoreShape {
  return { tenants: [...tenants.values()], apiKeys: [...apiKeys.values()] };
}

async function writeSnapshotToDb(db: PrismaClient, data: StoreShape): Promise<void> {
  // 順序：先 upsert tenants（api_keys 有 FK）→ upsert keys → 刪除快照外的殘留列
  await db.$transaction([
    ...data.tenants.map((t) => {
      const row = tenantToRow(t);
      const config = row.config as Prisma.InputJsonValue;
      return db.tenantRow.upsert({
        where: { id: row.id },
        create: { ...row, config },
        update: { name: row.name, config },
      });
    }),
    ...data.apiKeys.map((k) => {
      const row = apiKeyToRow(k);
      return db.apiKeyRow.upsert({
        where: { key: row.key },
        create: row,
        update: { revokedAt: row.revokedAt },
      });
    }),
    db.apiKeyRow.deleteMany({ where: { key: { notIn: data.apiKeys.map((k) => k.key) } } }),
    db.tenantRow.deleteMany({ where: { id: { notIn: data.tenants.map((t) => t.id) } } }),
  ]);
}

function persist(): void {
  if (env.DATA_BACKEND === 'db') {
    // 快照於呼叫當下取定，寫入失敗不影響當前請求（與 file 後端同語意）
    const data = snapshot();
    writeQueue.enqueue((db) => writeSnapshotToDb(db, data));
    return;
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(snapshot()));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist tenants');
  }
}

// 種預設租戶（若持久層無此資料）：向後相容的關鍵
function seedDefaults(): void {
  if (tenants.has(DEFAULT_TENANT_ID)) return;
  const now = new Date().toISOString();
  // DEFAULT_TENANT_ORIGINS='*' 時放行全部，維持改造前行為；可設逗號分隔網域收緊
  const allowedOrigins =
    env.DEFAULT_TENANT_ORIGINS === '*'
      ? ['*']
      : env.DEFAULT_TENANT_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  tenants.set(DEFAULT_TENANT_ID, {
    id: DEFAULT_TENANT_ID,
    name: '預設租戶（向後相容）',
    allowedOrigins: allowedOrigins.length ? allowedOrigins : ['*'],
    createdAt: now,
  });
  apiKeys.set(DEFAULT_PUBLISHABLE_KEY, {
    key: DEFAULT_PUBLISHABLE_KEY,
    tenantId: DEFAULT_TENANT_ID,
    type: 'publishable',
    createdAt: now,
  });
  apiKeys.set(DEFAULT_SECRET_KEY, {
    key: DEFAULT_SECRET_KEY,
    tenantId: DEFAULT_TENANT_ID,
    type: 'secret',
    createdAt: now,
  });
  persist();
}

// file 後端：模組載入即同步還原 + 種子（沿用既有行為；db 後端改由 initTenantStore 非同步進行）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as StoreShape;
      for (const t of raw.tenants ?? []) tenants.set(t.id, t);
      for (const k of raw.apiKeys ?? []) apiKeys.set(k.key, k);
      logger.info({ tenants: tenants.size, keys: apiKeys.size }, 'tenants restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore tenants; starting empty');
  }
  seedDefaults();
}

/**
 * db 後端的開機載入：連 DB、還原兩張 Map、補種預設租戶。
 * 必須在開始服務請求前 await（index.ts listen 前）；連線失敗直接 throw，boot fail-fast。
 * file 後端為 no-op。
 */
export async function initTenantStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const [tenantRows, keyRows] = await Promise.all([
    db.tenantRow.findMany(),
    db.apiKeyRow.findMany(),
  ]);
  for (const r of tenantRows) {
    const t = tenantFromRow(r);
    tenants.set(t.id, t);
  }
  for (const r of keyRows) {
    const k = apiKeyFromRow(r);
    apiKeys.set(k.key, k);
  }
  logger.info({ tenants: tenants.size, keys: apiKeys.size }, 'tenants restored from db');
  seedDefaults();
}


/** 產生一把金鑰字串：pk_<hex> 或 sk_<hex> */
function generateKey(type: ApiKeyType): string {
  const prefix = type === 'publishable' ? 'pk_' : 'sk_';
  return prefix + randomBytes(24).toString('hex');
}

export const tenantStore = {
  getTenant(id: string): Tenant | undefined {
    return tenants.get(id);
  },

  listTenants(): Tenant[] {
    return [...tenants.values()];
  },

  createTenant(name: string, allowedOrigins: string[] = [], ssoSecret?: string): Tenant {
    const tenant: Tenant = {
      id: randomBytes(8).toString('hex'),
      name,
      allowedOrigins,
      ssoSecret,
      createdAt: new Date().toISOString(),
    };
    tenants.set(tenant.id, tenant);
    persist();
    return tenant;
  },

  /** 依金鑰字串查 API Key（含撤銷狀態，由呼叫端判定有效性） */
  getApiKey(key: string): ApiKey | undefined {
    return apiKeys.get(key);
  },

  createApiKey(tenantId: string, type: ApiKeyType): ApiKey {
    const apiKey: ApiKey = {
      key: generateKey(type),
      tenantId,
      type,
      createdAt: new Date().toISOString(),
    };
    apiKeys.set(apiKey.key, apiKey);
    persist();
    return apiKey;
  },

  /** 部分更新租戶（admin 後台用）；回 undefined 代表查無此租戶 */
  updateTenant(
    id: string,
    patch: Partial<
      Pick<
        Tenant,
        | 'name'
        | 'allowedOrigins'
        | 'ssoSecret'
        | 'appearance'
        | 'disabledServices'
        | 'disabledForms'
        | 'grantedScopes'
        | 'scopesMigrated'
        | 'llmConfig'
      >
    >,
  ): Tenant | undefined {
    const tenant = tenants.get(id);
    if (!tenant) return undefined;
    const next: Tenant = {
      ...tenant,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.allowedOrigins !== undefined ? { allowedOrigins: patch.allowedOrigins } : {}),
      ...(patch.ssoSecret !== undefined ? { ssoSecret: patch.ssoSecret } : {}),
      ...(patch.appearance !== undefined
        ? { appearance: { ...tenant.appearance, ...patch.appearance } }
        : {}),
      ...(patch.disabledServices !== undefined ? { disabledServices: patch.disabledServices } : {}),
      ...(patch.disabledForms !== undefined ? { disabledForms: patch.disabledForms } : {}),
      ...(patch.grantedScopes !== undefined ? { grantedScopes: patch.grantedScopes } : {}),
      ...(patch.scopesMigrated !== undefined ? { scopesMigrated: patch.scopesMigrated } : {}),
      // 用 'in' 而非 '!== undefined'：llmConfig 需支援三態（不動/覆寫/清空），
      // undefined 也是合法值（代表整包清除），要能被 patch 帶入。
      ...('llmConfig' in patch ? { llmConfig: patch.llmConfig } : {}),
    };
    tenants.set(id, next);
    persist();
    return next;
  },

  /**
   * 刪除租戶並連帶移除其所有 API 金鑰。預設租戶（向後相容）不可刪。
   * 回傳是否成功刪除（不存在或為預設租戶時回 false）。
   */
  deleteTenant(id: string): boolean {
    if (id === DEFAULT_TENANT_ID || !tenants.has(id)) return false;
    tenants.delete(id);
    for (const [key, k] of apiKeys) {
      if (k.tenantId === id) apiKeys.delete(key);
    }
    persist();
    return true;
  },
};
