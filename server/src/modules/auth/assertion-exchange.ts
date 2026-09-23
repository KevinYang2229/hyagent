/**
 * Identity Assertion → HyAgent Session 的換發（規格 §5.3、§7.1、§8）。
 *
 * 這是驗證器唯一的正式呼叫端。流程刻意與規格 §8 的步驟編號對齊：
 *
 *   步驟 0        大小上限（**先於任何解碼**——順序本身即規範性要求）
 *   （挑金鑰）    以未驗章的 iss 決定租戶，只用來選公鑰
 *   步驟 1–20    HyAgentAssertionVerifier（含防重放）
 *   §10.4        記錄時鐘偏移
 *   步驟 21      Origin 白名單
 *   §7.1         建立 Session
 *
 * ## 租戶由 `iss` 決定，不是 API Key（決策 A）
 *
 * `pk_` API Key 在此**不參與身分判定**，降級為外觀設定與 CORS 用途。規格 §8.4 步驟 10
 * 要求 `iss` 等於 Tenant ID 且 `kid` 綁定該租戶，並未賦予 API Key 任何身分角色；
 * 兩者若並存而未交叉檢查，就開出跨租戶混淆的漏洞。無既有客戶，直接做對比補救便宜。
 */
import {
  ERROR_CODES,
  HyAgentAssertionVerifier,
  claimReplayStore,
  fail,
  isOriginAllowed,
  peekIssuer,
  toPublicKey,
  type AssertionClaims,
  type AssertionKeyRegistry,
  type RegisteredKey,
} from '@/lib/assertion';
import { env } from '@/config/env';
import { authSessionStore } from '@/lib/auth-session.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { resolveAssertionSettings } from '@/modules/tenant/tenant-keys';
import type { Tenant } from '@/modules/tenant/tenant.types';
import { recordClockOffset } from './clock-skew-monitor';

/**
 * 以租戶的 `publicKeys[]` 回答驗證器的查表（規格 §8.2 步驟 6–7）。
 *
 * 租戶物件由呼叫端自 primary 取得（§2.6 第 1、2 條），這裡不再自行查詢，
 * 因此整個換發流程只讀一次租戶——也就只有一個地方需要保證它沒有走快取。
 */
class TenantKeyRegistry implements AssertionKeyRegistry {
  constructor(private readonly tenant: Tenant) {}

  lookup(tenantId: string, kid: string): RegisteredKey {
    // 驗證器傳進來的 tenantId 恆等於建構時那個租戶；不等就是呼叫端接錯線，不是使用者輸入問題。
    if (tenantId !== this.tenant.id) {
      fail(ERROR_CODES.UNKNOWN_KID, '查無此 Tenant 對應的 kid');
    }
    const entry = (this.tenant.publicKeys ?? []).find((k) => k.kid === kid);
    if (!entry) {
      fail(ERROR_CODES.UNKNOWN_KID, '查無此 Tenant 對應的 kid');
    }
    if (entry.status !== 'active') {
      fail(ERROR_CODES.KEY_REVOKED, `公鑰狀態為 ${entry.status}，已不可使用`);
    }
    return {
      tenant: tenantId,
      kid: entry.kid,
      alg: entry.alg,
      publicKey: toPublicKey(entry.publicKey),
      status: 'active',
    };
  }
}

export interface AssertionExchangeInput {
  assertion: string;
  /** 請求的 `Origin` header */
  origin?: string;
  /** 面板自 `document.referrer` 取得並回報的嵌入者 origin（見 resolveEmbedOrigin） */
  embedOrigin?: string | null;
  /** 僅供可重現測試；正式環境**不得**由請求端傳入 */
  clockTimestamp?: number;
}

export interface AssertionExchangeResult {
  sessionToken: string;
  expiresIn: number;
  user: {
    sub: string;
    name?: string;
  };
  /** 呼叫端記錄稽核用；不回給客戶端 */
  tenantId: string;
  kid: string;
}

export const assertionExchange = {
  /**
   * 驗一張 Assertion 並換發 Session。
   *
   * 失敗一律丟 HyAgentTokenError，由 HTTP 層以 toErrorResponse() 轉成 §7.5 的回應格式。
   */
  async exchange({
    assertion,
    origin,
    embedOrigin,
    clockTimestamp,
  }: AssertionExchangeInput): Promise<AssertionExchangeResult> {
    // 步驟 0 + 取 iss。peekIssuer 內含大小檢查，確保它發生在任何解碼之前（§8.0）。
    const issuer = peekIssuer(assertion);

    // §2.6 第 1、2 條：撤銷判定必須讀 primary、不得走 TTL > 30 秒的快取。
    const tenant = await tenantStore.getTenantFromPrimary(issuer);
    if (!tenant) {
      // 與 UNKNOWN_KID 分開是刻意的：本協定不驗證 sub 是否存在，沒有帳號枚舉風險，
      // 而「租戶打錯」與「公鑰沒上傳」是整合期兩種完全不同的除錯方向（規格 §9 定稿保留細分代碼）。
      fail(ERROR_CODES.TENANT_NOT_FOUND, '查無此 Tenant');
    }

    const settings = resolveAssertionSettings(tenant);
    const verifier = new HyAgentAssertionVerifier({
      registry: new TenantKeyRegistry(tenant),
      replayStore: claimReplayStore,
      clockSkewSeconds: settings.clockSkewSeconds,
    });

    // 步驟 1–20（含 §8.5 防重放）。用 WithKey 版本是因為 Session 紀錄必須帶 kid（§2.6），
    // 而 kid 在 header 裡，從回傳的 claims 反推不出來。
    const { kid, claims }: { kid: string; claims: AssertionClaims } =
      await verifier.verifyAndConsumeWithKey(assertion, {
        tenant: tenant.id,
        ...(clockTimestamp === undefined ? {} : { clockTimestamp }),
      });

    // §10.4：記錄偏移量（純量，不含任何 claims 內容）
    const now = clockTimestamp ?? Math.floor(Date.now() / 1000);
    recordClockOffset(tenant.id, now - claims.iat, settings.clockSkewSeconds);

    // 步驟 21。排在驗章之後是照規格的步驟編號；副作用是來源不合法的請求也會消耗掉該 jti——
    // 那反而是好的：一張被側錄的 Assertion 拿去他站兌換，會在當場報廢而不是留著再用一次。
    if (!isOriginAllowedForTenant(tenant, resolveEmbedOrigin(origin, embedOrigin))) {
      fail(ERROR_CODES.ORIGIN_NOT_ALLOWED, '此來源不在該 Tenant 的允許清單內');
    }

    const name = typeof claims.name === 'string' ? claims.name : undefined;
    // 規格 §4.2.3 的自訂 claims。驗章時已做過型別與大小檢查，這裡只確認它是純物件後
    // 原樣收進 Session——語意解讀留到 getApplicant()，那裡才知道要對應成哪些欄位。
    const rawProfile = claims['hyagent:profile'];
    const profile =
      rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
        ? (rawProfile as Record<string, unknown>)
        : undefined;
    const created = await authSessionStore.create({
      tenantId: tenant.id,
      sub: claims.sub,
      kid,
      ...(name ? { name } : {}),
      ...(profile ? { profile } : {}),
      expiresInSeconds: settings.sessionExpiresIn,
    });

    return {
      sessionToken: created.sessionToken,
      expiresIn: created.expiresIn,
      user: { sub: claims.sub, ...(name ? { name } : {}) },
      tenantId: tenant.id,
      kid,
    };
  },
};

/** 本服務自己的前端網域（SPA / 面板）。 */
function isFirstPartyOrigin(origin: string): boolean {
  // '*' 是 dev 的全放行設定，此時無從分辨誰是自己人；正式環境應列舉具體網域。
  if (env.CORS_ORIGIN === '*') return true;
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin);
}

/**
 * 決定要拿哪個值去比對租戶白名單（規格 §8.6 步驟 21）。
 *
 * 換發有兩種呼叫端，能信任的訊號不同：
 *
 * | 呼叫端 | `Origin` header | 可信的嵌入者來源 |
 * | --- | --- | --- |
 * | Widget 面板（iframe，跑在 HyAgent 網域） | 恆為 HyAgent 自己 | 面板回報的 `document.referrer` |
 * | headless SDK（跑在客戶自己的頁面） | 客戶站台，瀏覽器設定 | `Origin` header 本身 |
 *
 * 所以規則是：**Origin 不是自己人 → 它就是答案**（瀏覽器設的，呼叫端偽造不了，
 * 且此時 body 帶的 embedOrigin 一律忽略——否則 evil.com 只要在 body 裡寫上受害者網域
 * 就能繞過這道檢查）。**Origin 是自己人 → 請求來自我們自己的面板**，那個 header 沒有
 * 鑑別力，改採面板回報的 referrer；面板的 JS 是我們的，而 referrer 由瀏覽器依載入來源
 * 設定，嵌入方只能抑制、不能偽造。
 *
 * 兩邊都拿不到時回 undefined，由白名單檢查 fail closed。
 */
function resolveEmbedOrigin(headerOrigin?: string, reportedOrigin?: string | null): string | undefined {
  if (headerOrigin && !isFirstPartyOrigin(headerOrigin)) return headerOrigin;
  return reportedOrigin?.trim() || headerOrigin || undefined;
}

/**
 * 規格 §8.6 步驟 21 套上本 repo 既有的白名單語意。
 *
 * 沿用 `allowedOrigins` 這份清單（動態 CORS 也讀它），差別在於這裡是**伺服器端**檢查：
 * CORS 只是瀏覽器層的閘門，非瀏覽器的請求繞得過去，而換發端點擋不住就等於沒擋。
 * `['*']` 維持預設租戶的全放行語意，不然既有的免 key widget 會整批失效。
 */
function isOriginAllowedForTenant(tenant: Tenant, origin?: string): boolean {
  if (tenant.allowedOrigins.includes('*')) return true;
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, '');
  return (
    isOriginAllowed(origin, tenant.allowedOrigins) ||
    tenant.allowedOrigins.some((o) => o.replace(/\/+$/, '') === normalized)
  );
}
