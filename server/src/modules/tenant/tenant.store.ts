/**
 * 租戶 / API Key store：記憶體 Map ＋ 可切換的持久化後端（env.DATA_BACKEND）。
 *
 * - file（預設）：JSON 檔（與 conversation.store 同款），跨 dev 重啟留得住。
 * - db：Postgres（Prisma）write-through——讀寫仍走同步的記憶體 Map，介面不變，
 *   每次變更把整份快照序列化寫進 DB（單 instance 前提，與 file 語意相同）。
 *   開機須先 await initTenantStore() 載回資料（index.ts 於 listen 前呼叫）。
 *
 * 啟動時一定會種一個 id='default' 的預設租戶與其公開金鑰，作為「未帶 key 的舊 widget」落點，
 * 確保向後相容。允許網域預設 '*'（沿用改造前 CORS 全放行）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptSecret, encryptSecret, hashApiKey, isEncrypted } from '@/lib/crypto';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { ApiKey, ApiKeyType, Tenant, TenantPublicKey, TenantPublicKeyStatus } from './tenant.types';
import {
  checkCanAddKey,
  checkCanSetStatus,
  parsePublicKey,
  resolveAssertionSettings,
  validateAssertionSettings,
  type TenantAssertionSettings,
} from './tenant-keys';

const STORE_FILE = dataFile('oa-agent-tenants.json');

export const DEFAULT_TENANT_ID = 'default';
// 公開 key 維持舊 widget 相容；固定秘密 key 僅用於撤銷舊資料，絕不再簽發。
const DEFAULT_PUBLISHABLE_KEY = 'pk_default';
const DEFAULT_SECRET_KEY = 'sk_default';

interface StoreShape {
  tenants: Tenant[];
  apiKeys: ApiKey[];
}

const tenants = new Map<string, Tenant>();
// 以金鑰「雜湊」為 key，查得快；原始金鑰不落地（簽發當下回傳一次後即丟）
const apiKeys = new Map<string, ApiKey>();

// ---- 敏感欄位加密（持久層邊界；記憶體一律持有明文）----
// 範圍：llmConfig 的兩把雲端 API key。未設 DATA_ENCRYPTION_KEY 時原樣進出。
//
// Assertion 公鑰**不在**此範圍內：公鑰本就可公開，加密它只會製造「以為受保護」的錯覺。
// 改造前這裡還有 ssoSecret（HS256 共享密鑰），隨該路徑一併移除。

/** 進持久層（file / db）前加密敏感欄位 */
export function sealTenant(t: Tenant): Tenant {
  if (!env.DATA_ENCRYPTION_KEY) return t;
  const sealed: Tenant = { ...t };
  if (sealed.llmConfig?.anthropicApiKey || sealed.llmConfig?.openaiApiKey) {
    sealed.llmConfig = { ...sealed.llmConfig };
    if (sealed.llmConfig.anthropicApiKey) {
      sealed.llmConfig.anthropicApiKey = encryptSecret(sealed.llmConfig.anthropicApiKey);
    }
    if (sealed.llmConfig.openaiApiKey) {
      sealed.llmConfig.openaiApiKey = encryptSecret(sealed.llmConfig.openaiApiKey);
    }
  }
  return sealed;
}

/** 自持久層載入後解密（明文舊資料原樣放行） */
export function unsealTenant(t: Tenant): Tenant {
  const open: Tenant = { ...t };
  if (open.llmConfig?.anthropicApiKey || open.llmConfig?.openaiApiKey) {
    open.llmConfig = { ...open.llmConfig };
    if (open.llmConfig.anthropicApiKey) {
      open.llmConfig.anthropicApiKey = decryptSecret(open.llmConfig.anthropicApiKey);
    }
    if (open.llmConfig.openaiApiKey) {
      open.llmConfig.openaiApiKey = decryptSecret(open.llmConfig.openaiApiKey);
    }
  }
  return open;
}

/** 已設加密金鑰但持久層仍有明文敏感欄位（或明文金鑰）→ 開機補寫一次 */
function needsResealing(): boolean {
  if (!env.DATA_ENCRYPTION_KEY) return false;
  for (const t of tenants.values()) {
    if (t.llmConfig?.anthropicApiKey && !isEncrypted(t.llmConfig.anthropicApiKey)) return true;
    if (t.llmConfig?.openaiApiKey && !isEncrypted(t.llmConfig.openaiApiKey)) return true;
  }
  return false;
}

/**
 * 舊資料的明文金鑰 → 雜湊（一次性轉換）。
 * 明文金鑰帶 pk_/sk_ 前綴、雜湊為 64 hex，可安全區分。回傳是否有轉換。
 */
function rehashLegacyKeys(): boolean {
  let changed = false;
  for (const [k, rec] of [...apiKeys]) {
    if (/^(pk_|sk_)/.test(k)) {
      apiKeys.delete(k);
      const hashed: ApiKey = { ...rec, key: hashApiKey(k) };
      apiKeys.set(hashed.key, hashed);
      changed = true;
    }
  }
  if (changed) logger.info('legacy plaintext api keys rehashed');
  return changed;
}

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
      const row = tenantToRow(sealTenant(t));
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
    const data = snapshot();
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({ tenants: data.tenants.map(sealTenant), apiKeys: data.apiKeys }),
    );
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist tenants');
  }
}

// 種預設租戶（若持久層無此資料）：向後相容的關鍵
function seedDefaults(): void {
  const legacy = apiKeys.get(hashApiKey(DEFAULT_SECRET_KEY));
  if (legacy && !legacy.revokedAt) {
    legacy.revokedAt = new Date().toISOString();
    persist();
  }
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
  const pkHash = hashApiKey(DEFAULT_PUBLISHABLE_KEY);
  apiKeys.set(pkHash, {
    key: pkHash,
    tenantId: DEFAULT_TENANT_ID,
    type: 'publishable',
    createdAt: now,
  });
  persist();
}

// file 後端：模組載入即同步還原 + 種子（沿用既有行為；db 後端改由 initTenantStore 非同步進行）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as StoreShape;
      for (const t of raw.tenants ?? []) tenants.set(t.id, unsealTenant(t));
      for (const k of raw.apiKeys ?? []) apiKeys.set(k.key, k);
      logger.info({ tenants: tenants.size, keys: apiKeys.size }, 'tenants restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore tenants; starting empty');
  }
  // 舊資料一次性轉換：明文金鑰→雜湊、明文敏感欄位→補加密（有變動才重寫）
  const rehashed = rehashLegacyKeys();
  if (rehashed || needsResealing()) persist();
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
    const t = unsealTenant(tenantFromRow(r));
    tenants.set(t.id, t);
  }
  for (const r of keyRows) {
    const k = apiKeyFromRow(r);
    apiKeys.set(k.key, k);
  }
  logger.info({ tenants: tenants.size, keys: apiKeys.size }, 'tenants restored from db');
  // 舊資料一次性轉換：明文金鑰→雜湊、明文敏感欄位→補加密（快照重寫會順帶清掉明文舊列）
  const rehashed = rehashLegacyKeys();
  if (rehashed || needsResealing()) persist();
  seedDefaults();
}


/** 產生一把金鑰字串：pk_<hex> 或 sk_<hex> */
function generateKey(type: ApiKeyType): string {
  const prefix = type === 'publishable' ? 'pk_' : 'sk_';
  return prefix + randomBytes(24).toString('hex');
}

export const tenantStore = {
  /** Admin credential changes must be durable before reporting success. */
  async persistCritical(): Promise<void> {
    if (env.DATA_BACKEND === 'db') {
      await writeQueue.flush();
      await writeSnapshotToDb(await connectDb(), snapshot());
    } else {
      const data = snapshot();
      fs.writeFileSync(STORE_FILE, JSON.stringify({ tenants: data.tenants.map(sealTenant), apiKeys: data.apiKeys }));
    }
  },
  getTenant(id: string): Tenant | undefined {
    return tenants.get(id);
  },

  listTenants(): Tenant[] {
    return [...tenants.values()];
  },

  createTenant(name: string, allowedOrigins: string[] = []): Tenant {
    const tenant: Tenant = {
      id: randomBytes(8).toString('hex'),
      name,
      allowedOrigins,
      createdAt: new Date().toISOString(),
    };
    tenants.set(tenant.id, tenant);
    persist();
    return tenant;
  },

  /** 依「原始」金鑰字串查 API Key（內部以雜湊比對；含撤銷狀態，由呼叫端判定有效性） */
  getApiKey(rawKey: string): ApiKey | undefined {
    if (rawKey === DEFAULT_SECRET_KEY) return undefined;
    return apiKeys.get(hashApiKey(rawKey));
  },

  /** 簽發金鑰：store 只存雜湊；回傳值的 key 為原始金鑰，僅此一次，之後無法再取得 */
  createApiKey(tenantId: string, type: ApiKeyType): ApiKey {
    const raw = generateKey(type);
    const apiKey: ApiKey = {
      key: hashApiKey(raw),
      tenantId,
      type,
      createdAt: new Date().toISOString(),
    };
    apiKeys.set(apiKey.key, apiKey);
    persist();
    return { ...apiKey, key: raw };
  },

  /** 部分更新租戶（admin 後台用）；回 undefined 代表查無此租戶 */
  updateTenant(
    id: string,
    patch: Partial<
      Pick<
        Tenant,
        | 'userDirectory'
        | 'name'
        | 'allowedOrigins'
        | 'appearance'
        | 'disabledServices'
        | 'disabledForms'
        | 'grantedScopes'
        | 'knowledgeLabels'
        | 'scopesMigrated'
        | 'llmConfig'
        | 'quotaMonthlyLlmTokens'
      >
    >,
  ): Tenant | undefined {
    const tenant = tenants.get(id);
    if (!tenant) return undefined;
    const next: Tenant = {
      ...tenant,
      ...(patch.userDirectory !== undefined ? { userDirectory: structuredClone(patch.userDirectory) } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.allowedOrigins !== undefined ? { allowedOrigins: patch.allowedOrigins } : {}),
      ...(patch.appearance !== undefined
        ? { appearance: { ...tenant.appearance, ...patch.appearance } }
        : {}),
      ...(patch.disabledServices !== undefined ? { disabledServices: patch.disabledServices } : {}),
      ...(patch.disabledForms !== undefined ? { disabledForms: patch.disabledForms } : {}),
      ...(patch.grantedScopes !== undefined ? { grantedScopes: patch.grantedScopes } : {}),
      ...(patch.knowledgeLabels !== undefined ? { knowledgeLabels: patch.knowledgeLabels } : {}),
      ...(patch.scopesMigrated !== undefined ? { scopesMigrated: patch.scopesMigrated } : {}),
      // 用 'in' 而非 '!== undefined'：llmConfig 需支援三態（不動/覆寫/清空），
      // undefined 也是合法值（代表整包清除），要能被 patch 帶入。
      ...('llmConfig' in patch ? { llmConfig: patch.llmConfig } : {}),
      ...(patch.quotaMonthlyLlmTokens !== undefined
        ? { quotaMonthlyLlmTokens: patch.quotaMonthlyLlmTokens }
        : {}),
    };
    tenants.set(id, next);
    persist();
    return next;
  },

  // ───────────── Assertion 公鑰（規格 §2.5、§7.3）─────────────

  /** 列出租戶的公鑰與狀態。公鑰可公開，不需遮罩。 */
  listPublicKeys(tenantId: string): TenantPublicKey[] {
    return [...(tenants.get(tenantId)?.publicKeys ?? [])];
  },

  /**
   * 上傳一把公鑰。kid 由後端依 RFC 7638 算出（規格 §2.4）。
   *
   * 同一 kid 重複上傳為**冪等**：回既有那筆、`created: false`，不新增也不改狀態（§7.3）。
   */
  addPublicKey(
    tenantId: string,
    input: { publicKey: string; label?: string },
  ): { key: TenantPublicKey; created: boolean } | undefined {
    const tenant = tenants.get(tenantId);
    if (!tenant) return undefined;
    const parsed = parsePublicKey(input.publicKey);
    const { existing } = checkCanAddKey(tenant.publicKeys, parsed.kid);
    if (existing) return { key: existing, created: false };

    const now = new Date().toISOString();
    const key: TenantPublicKey = {
      kid: parsed.kid,
      alg: parsed.alg,
      publicKey: parsed.publicKey,
      status: 'active',
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      createdAt: now,
    };
    tenants.set(tenantId, { ...tenant, publicKeys: [...(tenant.publicKeys ?? []), key] });
    persist();
    return { key, created: true };
  },

  /**
   * 變更公鑰狀態（停用 / 撤銷 / 重新啟用）。不變條件見 tenant-keys.ts。
   *
   * 注意：撤銷**只**改這裡的狀態。以該 kid 建立的既有 Session 由 auth session store
   * 依 kid 批次作廢（規格 §2.6），呼叫端必須把兩件事一起做完才算撤銷完成。
   */
  setPublicKeyStatus(
    tenantId: string,
    kid: string,
    status: TenantPublicKeyStatus,
  ): TenantPublicKey | undefined {
    const tenant = tenants.get(tenantId);
    if (!tenant) return undefined;
    checkCanSetStatus(tenant.publicKeys, kid, status);
    const now = new Date().toISOString();
    let updated: TenantPublicKey | undefined;
    const publicKeys = (tenant.publicKeys ?? []).map((k) => {
      if (k.kid !== kid) return k;
      updated = { ...k, status, statusChangedAt: now };
      return updated;
    });
    tenants.set(tenantId, { ...tenant, publicKeys });
    persist();
    return updated;
  },

  /** 逐租戶設定的現行值（未設者填規格預設）。後台總覽面板用（§11.1）。 */
  getAssertionSettings(tenantId: string): TenantAssertionSettings | undefined {
    const tenant = tenants.get(tenantId);
    return tenant ? resolveAssertionSettings(tenant) : undefined;
  },

  /** 部分更新逐租戶設定；交叉條件（skew ≤ 有效期 ¼）以合併後的整組驗證。 */
  updateAssertionSettings(
    tenantId: string,
    patch: { clockSkewSeconds?: number; assertionLifetimeSeconds?: number; sessionExpiresIn?: number },
  ): TenantAssertionSettings | undefined {
    const tenant = tenants.get(tenantId);
    if (!tenant) return undefined;
    const next = validateAssertionSettings(resolveAssertionSettings(tenant), patch);
    tenants.set(tenantId, { ...tenant, ...next });
    persist();
    return next;
  },

  /**
   * 撤銷判定專用的租戶讀取：db 模式**直接查 DB**，不走記憶體 Map。
   *
   * 規格 §2.6 第 1、2 條：公鑰與撤銷狀態的查詢不得使用 TTL > 30 秒的快取，且必須讀
   * primary。本 store 的記憶體 Map 是 write-through 快取，多副本部署下在 A 副本撤銷的
   * 公鑰，B 副本到重啟前都還會繼續接受——那是無限 TTL，遠超 30 秒上限（評估文件 §6.4）。
   *
   * file 模式沿用 Map：單一行程，Map 本身即 primary，沒有副本可落後。
   */
  async getTenantFromPrimary(id: string): Promise<Tenant | undefined> {
    if (env.DATA_BACKEND !== 'db') return tenants.get(id);
    const db = await connectDb();
    const row = await db.tenantRow.findUnique({ where: { id } });
    return row ? unsealTenant(tenantFromRow(row)) : undefined;
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
