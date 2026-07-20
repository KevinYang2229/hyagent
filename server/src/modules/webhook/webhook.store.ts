/**
 * Webhook 端點 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND）。
 * db 後端：每端點一列（data jsonb 整包），register / setDisabled 定向 upsert、remove 定向刪除。
 * 開機由 initWebhookStore() 載回（index.ts 於 listen 前呼叫）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { WebhookEndpoint, WebhookEventType } from './webhook.types';

const STORE_FILE = dataFile('oa-agent-webhooks.json');

const endpoints = new Map<string, WebhookEndpoint>();

const writeQueue = new DbWriteQueue('webhooks');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...endpoints.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist webhooks');
  }
}

/** db 後端：upsert 單一端點（與 file 後端同語意：undefined 欄位序列化剔除） */
function upsertEndpointToDb(e: WebhookEndpoint): void {
  const data = JSON.parse(JSON.stringify(e)) as Prisma.InputJsonValue;
  const row = { id: e.id, tenantId: e.tenantId, data, createdAt: new Date(e.createdAt) };
  writeQueue.enqueue(async (db) => {
    await db.webhookRow.upsert({ where: { id: row.id }, create: row, update: { data } });
  });
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as WebhookEndpoint[];
      for (const e of raw) endpoints.set(e.id, e);
      logger.info({ count: endpoints.size }, 'webhooks restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore webhooks; starting empty');
  }
}

/**
 * db 後端的開機載入。必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initWebhookStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.webhookRow.findMany();
  for (const r of rows) {
    const e = r.data as unknown as WebhookEndpoint;
    endpoints.set(e.id, e);
  }
  logger.info({ count: endpoints.size }, 'webhooks restored from db');
}

export const webhookStore = {
  /** 登記一個端點；未給 secret 則自動產生一把（回傳供呼叫端交付給接收方） */
  register(input: {
    tenantId: string;
    url: string;
    secret?: string;
    events?: WebhookEventType[];
  }): WebhookEndpoint {
    const endpoint: WebhookEndpoint = {
      id: randomBytes(8).toString('hex'),
      tenantId: input.tenantId,
      url: input.url,
      secret: input.secret ?? `whsec_${randomBytes(24).toString('hex')}`,
      events: input.events,
      createdAt: new Date().toISOString(),
    };
    endpoints.set(endpoint.id, endpoint);
    if (env.DATA_BACKEND === 'db') upsertEndpointToDb(endpoint);
    else persistFile();
    return endpoint;
  },

  listByTenant(tenantId: string): WebhookEndpoint[] {
    return [...endpoints.values()].filter((e) => e.tenantId === tenantId);
  },

  remove(tenantId: string, id: string): boolean {
    const e = endpoints.get(id);
    if (!e || e.tenantId !== tenantId) return false;
    endpoints.delete(id);
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.webhookRow.deleteMany({ where: { id } });
      });
    } else {
      persistFile();
    }
    return true;
  },

  /** 啟用/停用端點：disabled=true 設 disabledAt，false 清除。回 undefined＝查無或不屬此租戶 */
  setDisabled(tenantId: string, id: string, disabled: boolean): WebhookEndpoint | undefined {
    const e = endpoints.get(id);
    if (!e || e.tenantId !== tenantId) return undefined;
    const next: WebhookEndpoint = { ...e };
    if (disabled) next.disabledAt = new Date().toISOString();
    else delete next.disabledAt;
    endpoints.set(id, next);
    if (env.DATA_BACKEND === 'db') upsertEndpointToDb(next);
    else persistFile();
    return next;
  },

  /** 移除某租戶所有 webhook 端點（刪租戶級聯清理用） */
  purgeTenant(tenantId: string): void {
    for (const [id, e] of endpoints) {
      if (e.tenantId === tenantId) endpoints.delete(id);
    }
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.webhookRow.deleteMany({ where: { tenantId } });
      });
      return;
    }
    persistFile();
  },
};
