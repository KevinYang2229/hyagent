/**
 * @hyagent/sdk/server — 伺服器端工具（給「整合方後端」用）。
 *
 * 兩塊內容：
 *   1. Identity Assertion 簽發（`issueAssertion` / `generateKeyPair`）——貴方的
 *      Identity Endpoint（規格 §5.2）拿它簽發短效憑證，widget 需要身分時來取。
 *   2. Webhook 事件驗簽。
 *
 * 零執行期相依，只用 `node:crypto`；僅供 Node 端使用，瀏覽器端請用主入口 createOAAgent。
 *
 * **私鑰絕不可離開貴方環境**（規格 §2.2）。HyAgent 只持有公鑰，因此沒有能力偽造
 * 任何一位使用者的身分——改造前的 `ssoSecret`（HS256 共享密鑰）雙方都持有，做不到這點。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// Identity Assertion 簽發（規格 §3、§4）。零相依，見 ./assertion.ts。
export {
  AssertionIssuer,
  DEFAULT_AUDIENCE,
  DEFAULT_LIFETIME_SECONDS,
  MAX_ASSERTION_BYTES,
  MAX_LIFETIME_SECONDS,
  MIN_RSA_MODULUS_BITS,
  computeKid,
  detectAlgorithm,
  generateKeyPair,
  issueAssertion,
  type AssertionAlgorithm,
  type GeneratedKeyPair,
  type IssueAssertionOptions,
} from './assertion.ts';

// ───────────────────────── Webhook 接收端工具 ─────────────────────────

export type WebhookEventType = 'form.submitted';

/** HyAgent 投遞的 webhook 事件（接收端收到的 body 形狀） */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  tenantId: string;
  createdAt: string;
  data: {
    conversationId: string;
    formId: string;
    userId: string;
    values: Record<string, unknown>;
    submission: { oaRequestId: string; status: string; submittedAt: string; [k: string]: unknown };
  };
}

export interface ConstructWebhookEventOptions {
  /** HTTP 請求的「原始」body 字串（勿用 JSON.parse 後再 stringify，簽章會對不上） */
  payload: string;
  /** x-oa-signature header（格式 sha256=<hex>） */
  signature: string | undefined;
  /** x-oa-timestamp header（毫秒）；用於防重放 */
  timestamp: string | undefined;
  /** 該 webhook 端點的密鑰（whsec_…） */
  secret: string;
  /** 允許的時間誤差（秒），預設 300；設 0 關閉時間檢查 */
  toleranceSec?: number;
}

/** 以端點密鑰重算 HMAC：sha256=HMAC(secret, `${timestamp}.${payload}`) */
function computeSignature(secret: string, timestamp: string, payload: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * 驗證 webhook 簽章並解析事件（驗章失敗 / 過期 / 內容竄改都會丟錯）。
 * 接收端應在驗章通過後才信任 body。
 */
export function constructWebhookEvent(opts: ConstructWebhookEventOptions): WebhookEvent {
  const { payload, signature, timestamp, secret, toleranceSec = 300 } = opts;
  if (!signature || !timestamp) throw new Error('缺少 x-oa-signature / x-oa-timestamp');
  if (!safeEqual(signature, computeSignature(secret, timestamp, payload))) {
    throw new Error('webhook 簽章驗證失敗');
  }
  if (toleranceSec > 0) {
    const age = Math.abs(Date.now() - Number(timestamp)) / 1000;
    if (!Number.isFinite(age) || age > toleranceSec) {
      throw new Error('webhook timestamp 超出容許範圍（可能為重放）');
    }
  }
  return JSON.parse(payload) as WebhookEvent;
}

/** 只驗簽章、回傳 boolean（不解析、不丟錯的輕量版本） */
export function verifyWebhookSignature(opts: ConstructWebhookEventOptions): boolean {
  try {
    constructWebhookEvent(opts);
    return true;
  } catch {
    return false;
  }
}
