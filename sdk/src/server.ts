/**
 * @hyagent/sdk/server — 伺服器端 SSO 工具（給「整合方後端」用）。
 *
 * 用途：整合方在自己的後端，於使用者登入後，用該租戶的 ssoSecret 簽一張「終端使用者 token」，
 * 交給前端塞進 HyAgent widget（data-user-token）。HyAgent 收到後驗章換發本系統 token，達成免登入。
 *
 * 注意：依賴 jsonwebtoken，僅供 Node 端使用；瀏覽器端請用主入口 createOAAgent。
 * ssoSecret 是後端機密，切勿外洩到前端。
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UserTokenClaims {
  /** 終端使用者在宿主系統的唯一識別（工號 / 帳號） */
  sub: string;
  /** 顯示名稱（選填） */
  name?: string;
  /** 角色（舊版相容欄位；HyAgent 不採用此值授權，一律換發 employee） */
  role?: string;
}

export interface SignUserTokenOptions extends UserTokenClaims {
  /** 該租戶的 ssoSecret（建租戶時設定，須留在後端） */
  secret: string;
  /** 有效期，預設 '5m'（建議短效，因為會出現在前端） */
  expiresIn?: SignOptions['expiresIn'];
}

/**
 * 用租戶 ssoSecret 簽一張 HyAgent SSO user token。
 * 回傳的字串交給前端，作為 widget 的 data-user-token 或 SDK 的 userToken。
 */
export function signUserToken(opts: SignUserTokenOptions): string {
  const { secret, sub, name, role, expiresIn = '5m' } = opts;
  if (!secret) throw new Error('signUserToken: secret（租戶 ssoSecret）為必填');
  if (!sub) throw new Error('signUserToken: sub（使用者識別）為必填');
  const claims: UserTokenClaims = { sub };
  if (name !== undefined) claims.name = name;
  if (role !== undefined) claims.role = role;
  return jwt.sign(claims, secret, { expiresIn, algorithm: 'HS256', issuer: 'hyagent:handoff', audience: 'hyagent:sso' });
}

/**
 * 驗證一張 user token（測試 / 除錯用；正式環境的驗章由 HyAgent 後端負責）。
 * 失敗會丟出 jsonwebtoken 的錯誤。
 */
export function verifyUserToken(token: string, secret: string): UserTokenClaims {
  return jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'hyagent:handoff', audience: 'hyagent:sso', maxAge: '5m' }) as UserTokenClaims;
}

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
