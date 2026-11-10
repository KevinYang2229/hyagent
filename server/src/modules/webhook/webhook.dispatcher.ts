/**
 * Webhook 投遞器：行內非同步（fire-and-forget）把事件 POST 給租戶登記的端點。
 *
 * - 簽章：x-oa-signature: sha256=HMAC(secret, `${timestamp}.${body}`)，接收端用同把 secret 驗章＋比對 timestamp 防重放。
 * - 重試：失敗（連線錯誤或非 2xx）以指數退避重試數次；用盡則記錄放棄。
 * - 不依賴 Redis；介面（dispatch）設計成可抽換——日後 Redis 就緒可改為 BullMQ 佇列投遞，呼叫端不變。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { publicOnlyFetch } from '@/lib/public-network';
import { webhookStore } from './webhook.store';
import type { WebhookEndpoint, WebhookEvent } from './webhook.types';

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1_000, 5_000, 30_000]; // 第 1/2/3 次重試前的等待
const REQUEST_TIMEOUT_MS = 10_000;

function sign(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function deliver(endpoint: WebhookEndpoint, event: WebhookEvent, attempt: number): Promise<void> {
  const body = JSON.stringify(event);
  const timestamp = Date.now().toString();
  try {
    // 租戶管理者登記的端點：只連公開網段、每次投遞重新檢查並釘住位址、不跟隨跳轉
    const send = endpoint.restrictNetwork
      ? (url: string, init: RequestInit) => publicOnlyFetch(url, init, { maxRedirects: 0 })
      : fetch;
    const res = await send(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-oa-event': event.type,
        'x-oa-timestamp': timestamp,
        'x-oa-signature': sign(endpoint.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.info({ endpoint: endpoint.id, event: event.id, attempt }, 'webhook delivered');
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[attempt - 1] ?? 30_000;
      logger.warn(
        { err, endpoint: endpoint.id, event: event.id, attempt, delay },
        'webhook delivery failed; will retry',
      );
      // unref：投遞重試不應阻止行程結束
      setTimeout(() => void deliver(endpoint, event, attempt + 1), delay).unref();
    } else {
      logger.error(
        { err, endpoint: endpoint.id, event: event.id },
        'webhook delivery permanently failed',
      );
    }
  }
}

export const webhookDispatcher = {
  /**
   * 對租戶廣播事件：找出符合訂閱的端點，逐一行內非同步投遞（不阻塞呼叫端）。
   */
  dispatch(event: Omit<WebhookEvent, 'id' | 'createdAt'>): void {
    const full: WebhookEvent = {
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const targets = webhookStore
      .listByTenant(event.tenantId)
      .filter((e) => !e.disabledAt && (!e.events?.length || e.events.includes(event.type)));
    for (const ep of targets) void deliver(ep, full, 1);
  },
};
