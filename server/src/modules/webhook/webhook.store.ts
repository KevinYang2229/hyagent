/**
 * Webhook 端點 store（MVP）：記憶體 Map ＋ 磁碟持久化，與 conversation/tenant store 同款。
 * 之後接 Prisma 只要換掉這層。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';
import type { WebhookEndpoint, WebhookEventType } from './webhook.types';

const STORE_FILE = dataFile('oa-agent-webhooks.json');

const endpoints = new Map<string, WebhookEndpoint>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...endpoints.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist webhooks');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as WebhookEndpoint[];
    for (const e of raw) endpoints.set(e.id, e);
    logger.info({ count: endpoints.size }, 'webhooks restored from disk');
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore webhooks; starting empty');
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
    persist();
    return endpoint;
  },

  listByTenant(tenantId: string): WebhookEndpoint[] {
    return [...endpoints.values()].filter((e) => e.tenantId === tenantId);
  },

  remove(tenantId: string, id: string): boolean {
    const e = endpoints.get(id);
    if (!e || e.tenantId !== tenantId) return false;
    endpoints.delete(id);
    persist();
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
    persist();
    return next;
  },
};
