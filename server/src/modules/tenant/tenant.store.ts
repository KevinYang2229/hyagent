/**
 * 租戶 / API Key store（MVP）：記憶體 Map ＋ 磁碟持久化。
 *
 * 與 conversation.store 同款：放 os.tmpdir() 的 JSON，跨 dev 重啟留得住；之後接 Prisma / Redis
 * 只要換掉這層，service / middleware 介面不變。
 *
 * 啟動時一定會種一個 id='default' 的預設租戶與其 pk_/sk_ 金鑰，作為「未帶 key 的舊 widget」落點，
 * 確保向後相容。允許網域預設 '*'（沿用改造前 CORS 全放行）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { ApiKey, ApiKeyType, Tenant } from './tenant.types';

const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-tenants.json');

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

function persist(): void {
  try {
    const data: StoreShape = { tenants: [...tenants.values()], apiKeys: [...apiKeys.values()] };
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist tenants');
  }
}

// 啟動時載入既有資料（壞檔則略過）
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

// 種預設租戶（若磁碟無此資料）：向後相容的關鍵
if (!tenants.has(DEFAULT_TENANT_ID)) {
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
