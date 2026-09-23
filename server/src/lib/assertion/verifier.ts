/**
 * Identity Assertion 驗證器。
 *
 * 對應規格：§8 Assertion 驗證規則（步驟 0–21 共 22 項）、§9 錯誤碼、§10.4 clock skew。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-verifier.mjs`（其 53 項測試為本檔驗收基準）。
 *
 * 三個進入點與規格章節的對應：
 *   decode()            → 僅解析，不做任何驗證。**結果不可用於任何安全判斷**（§8.3）
 *   verify()            → §8.0–§8.4（步驟 0–18）。同步、無副作用，方便單元測試
 *   verifyAndConsume()  → 再加上 §8.5 防重放（步驟 19–20）。**正式流程用這個**
 *   isOriginAllowed()   → §8.6 來源檢查（步驟 21），由 HTTP 層在驗章前呼叫
 */
import { verify as verifySignature } from 'node:crypto';
import { ERROR_CODES, fail } from './errors';
import {
  ALGORITHMS,
  FORBIDDEN_HEADER_PARAMS,
  decodeJsonPart,
  isAssertionAlgorithm,
  keyArg,
  splitToken,
} from './jose';
import type { AssertionKeyRegistry } from './key-registry';
import { MemoryReplayStore, type ReplayStore } from './replay-store';

/** 規格 §4.2.4：序列化後的位元組上限。 */
export const MAX_ASSERTION_BYTES = 4096;

/** 規格 §4.3：有效期上限。 */
export const MAX_LIFETIME_SECONDS = 300;

/**
 * 規格 §10.4：時鐘偏移容忍。預設 15 秒，HyAgent 後台逐 Tenant 可設 0～30 秒。
 *
 * 後台另須確保設定值不超過該 Tenant 有效期的 ¼——該比例規則依賴 Tenant 設定，
 * 不在驗證器內強制，否則會在執行期誤拒合法 token。
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 15;
export const MAX_CLOCK_SKEW_SECONDS = 30;

/** 規格 §4.2.1 固定的 audience。 */
export const DEFAULT_AUDIENCE = 'hyagent';

const HTTPS_URL = /^https:\/\/\S+$/;

/** 驗章通過後的 claims。自訂 claims 原樣帶出，HyAgent 不做語意解讀（規格 §4.2.3）。 */
export type AssertionClaims = Readonly<Record<string, unknown>> & {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
};

export interface VerifyOptions {
  /**
   * 租戶。**必須由呼叫端從請求本身取得**（SDK init 的 tenant / URL 參數），
   * 不可取自尚未驗章的 payload.iss——規格 §8.3 明訂驗章前 payload 一律不可信任。
   * 驗章後步驟 10 會再確認 iss 與此 tenant 相符。
   */
  tenant: string;
  /** 僅供可重現測試使用，正式環境**不得**由請求端傳入。 */
  clockTimestamp?: number;
}

export interface VerifierOptions {
  registry: AssertionKeyRegistry;
  replayStore?: ReplayStore;
  audience?: string;
  maxLifetimeSeconds?: number;
  /** 規格 §10.4，預設 15，範圍 0～30 */
  clockSkewSeconds?: number;
  maxAssertionBytes?: number;
}

/** 規格 §8.6 步驟 21：來源網域白名單檢查。 */
export function isOriginAllowed(origin: unknown, allowedOrigins: readonly string[]): boolean {
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}

/**
 * 步驟 0（大小上限）+ 取出 `iss`，供 HTTP 層決定該用哪個 Tenant 的公鑰驗章。
 *
 * 回傳值來自**未驗章**的 payload，除了「挑哪一組公鑰」之外**不可**用於任何判斷。
 * 這樣做是安全的，因為驗章後的步驟 10 會再確認 `iss` 與該 Tenant 相符——
 * 偽造 `iss` 只會讓攻擊者被拿去跟他無法偽造簽章的那組公鑰比對。
 *
 * 大小檢查必須在此處而非解碼後：規格 §8.0 把它編為步驟 0，**先於任何解碼與驗章**，
 * 順序本身即規範性要求（否則超大輸入會先付出解碼成本）。
 */
export function peekIssuer(token: unknown, maxAssertionBytes: number = MAX_ASSERTION_BYTES): string {
  if (typeof token === 'string' && Buffer.byteLength(token, 'utf8') > maxAssertionBytes) {
    fail(ERROR_CODES.ASSERTION_TOO_LARGE, `Assertion 超過 ${maxAssertionBytes} bytes 上限`);
  }
  const [, encodedPayload] = splitToken(token);
  const payload = decodeJsonPart(encodedPayload, 'payload');
  const iss = payload.iss;
  if (typeof iss !== 'string' || !iss) {
    fail(ERROR_CODES.INVALID_CLAIMS, 'iss 必須是非空字串');
  }
  return iss;
}

function requireString(
  payload: Record<string, unknown>,
  claim: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): string {
  const value = payload[claim];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(ERROR_CODES.INVALID_CLAIMS, `${claim} 必須是長度 ${min}–${max} 的字串`);
  }
  return value;
}

function requireInteger(payload: Record<string, unknown>, claim: string): number {
  const value = payload[claim];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(ERROR_CODES.INVALID_CLAIMS, `${claim} 必須是非負的安全整數`);
  }
  return value as number;
}

export class HyAgentAssertionVerifier {
  private readonly registry: AssertionKeyRegistry;
  private readonly replayStore: ReplayStore;
  private readonly audience: string;
  private readonly maxLifetimeSeconds: number;
  readonly clockSkewSeconds: number;
  private readonly maxAssertionBytes: number;

  constructor({
    registry,
    replayStore = new MemoryReplayStore(),
    audience = DEFAULT_AUDIENCE,
    maxLifetimeSeconds = MAX_LIFETIME_SECONDS,
    clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
    maxAssertionBytes = MAX_ASSERTION_BYTES,
  }: VerifierOptions) {
    if (!registry || typeof registry.lookup !== 'function') {
      throw new TypeError('registry 必須提供 lookup(tenant, kid)');
    }
    if (
      !Number.isSafeInteger(clockSkewSeconds) ||
      clockSkewSeconds < 0 ||
      clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
    ) {
      throw new RangeError(
        `clockSkewSeconds 必須是 0～${MAX_CLOCK_SKEW_SECONDS} 的整數（規格 §10.4）`,
      );
    }

    this.registry = registry;
    this.replayStore = replayStore;
    this.audience = audience;
    this.maxLifetimeSeconds = maxLifetimeSeconds;
    this.clockSkewSeconds = clockSkewSeconds;
    this.maxAssertionBytes = maxAssertionBytes;
  }

  /**
   * 只解析，不驗證簽章或 claims。
   * 回傳內容**不可**用於登入、授權或任何安全判斷（規格 §8.3）。
   */
  decode(token: unknown): { header: Record<string, unknown>; payload: Record<string, unknown> } {
    const [encodedHeader, encodedPayload] = splitToken(token);
    return {
      header: decodeJsonPart(encodedHeader, 'header'),
      payload: decodeJsonPart(encodedPayload, 'payload'),
    };
  }

  /** 執行規格 §8.0–§8.4（步驟 0–18）。通過後回傳可信任的 claims。 */
  verify(token: unknown, { tenant, clockTimestamp }: VerifyOptions): AssertionClaims {
    return this.verifyInternal(token, tenant, clockTimestamp).claims;
  }

  /**
   * 正式流程的進入點：verify() 加上 §8.5 防重放（步驟 19–20）。
   * Assertion 是一次性兌換券，成功兌換 Session 後即作廢（規格 §4.3）。
   */
  async verifyAndConsume(
    token: unknown,
    options: VerifyOptions,
  ): Promise<AssertionClaims> {
    return (await this.verifyAndConsumeWithKey(token, options)).claims;
  }

  /**
   * 與 verifyAndConsume() 相同，但連同**驗章所用的 `kid`** 一起回傳。
   *
   * Session 紀錄必須帶建立時驗證通過的 `kid`（規格 §2.6），而它在 header 而非 claims 裡，
   * 呼叫端沒辦法從回傳的 claims 反推。換發端點用這一支。
   */
  async verifyAndConsumeWithKey(
    token: unknown,
    { tenant, clockTimestamp }: VerifyOptions,
  ): Promise<{ kid: string; claims: AssertionClaims }> {
    const now = this.resolveClock(clockTimestamp);
    // 一次解析取得 kid 與 claims，避免像參考實作那樣再 decode 一次（行為相同）。
    const { kid, claims } = this.verifyInternal(token, tenant, now);

    const replayKey = `${tenant}:${kid}:${claims.jti}`;
    const firstUse = await this.replayStore.consume(replayKey, claims.exp, now);
    if (!firstUse) {
      fail(ERROR_CODES.TOKEN_REPLAYED, '此 Assertion 已被使用過');
    }
    return { kid, claims };
  }

  private resolveClock(clockTimestamp?: number): number {
    const now = clockTimestamp ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('clockTimestamp 必須是非負的 UTC Unix timestamp');
    }
    return now;
  }

  private verifyInternal(
    token: unknown,
    tenant: string,
    clockTimestamp?: number,
  ): { kid: string; claims: AssertionClaims } {
    if (typeof tenant !== 'string' || tenant.length === 0) {
      throw new TypeError('verify() 必須指定 tenant');
    }
    const now = this.resolveClock(clockTimestamp);

    // --- §8.0 大小上限（步驟 0）---
    // 必須先於解碼與驗章：長度是唯一不需信任輸入內容就能判斷的屬性，
    // 擋下未持金鑰者以超大輸入逼出解碼與非對稱驗章成本的攻擊。順序本身即規範性要求。
    if (typeof token === 'string' && Buffer.byteLength(token) > this.maxAssertionBytes) {
      fail(ERROR_CODES.ASSERTION_TOO_LARGE, 'Assertion 超過規格 §4.2.4 大小上限');
    }

    // --- §8.1 結構檢查（步驟 1–3）---
    const [encodedHeader, encodedPayload, encodedSignature] = splitToken(token);
    const header = decodeJsonPart(encodedHeader, 'header');

    // --- §8.2 演算法與金鑰（步驟 4–7）---
    if (header.typ !== 'JWT') {
      fail(ERROR_CODES.INVALID_ALGORITHM, 'typ 必須為 JWT');
    }
    if (!isAssertionAlgorithm(header.alg)) {
      fail(ERROR_CODES.INVALID_ALGORITHM, 'alg 必須為 RS256 或 ES256');
    }
    for (const param of FORBIDDEN_HEADER_PARAMS) {
      if (param in header) {
        fail(ERROR_CODES.INVALID_ALGORITHM, `header 不得包含 ${param}`);
      }
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
      fail(ERROR_CODES.UNKNOWN_KID, 'header 必須包含 kid');
    }

    const registered = this.registry.lookup(tenant, header.kid);

    // algorithm confusion 防護：以「註冊時宣告的演算法」驗章，不依 header.alg 動態選擇。
    // 否則攻擊者可把 alg 改成 HS256，拿公開的 RSA 公鑰當 HMAC 金鑰偽造簽章。
    if (header.alg !== registered.alg) {
      fail(ERROR_CODES.INVALID_ALGORITHM, 'alg 與該 kid 註冊的演算法不符');
    }
    const spec = ALGORITHMS[registered.alg];

    // --- §8.3 簽章（步驟 8–9）---
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (spec.signatureBytes !== null && signature.length !== spec.signatureBytes) {
      fail(
        ERROR_CODES.INVALID_SIGNATURE,
        `${registered.alg} 簽章必須是 ${spec.signatureBytes} bytes 的 R||S 格式，不可使用 DER 編碼`,
      );
    }
    const signatureValid = verifySignature(
      spec.hash,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      keyArg(registered.publicKey, spec),
      signature,
    );
    if (!signatureValid) {
      fail(ERROR_CODES.INVALID_SIGNATURE, 'Assertion 簽章無效');
    }

    // 驗章通過後，payload 才可以信任。
    return {
      kid: registered.kid,
      claims: this.validateClaims(decodeJsonPart(encodedPayload, 'payload'), tenant, now),
    };
  }

  /** 規格 §8.4 claims 檢查（步驟 10–18）。 */
  private validateClaims(
    payload: Record<string, unknown>,
    tenant: string,
    nowUTC: number,
  ): AssertionClaims {
    // 步驟 10–11
    if (requireString(payload, 'iss') !== tenant) {
      fail(ERROR_CODES.INVALID_ISSUER, 'iss 與請求的 Tenant 不符');
    }
    if (requireString(payload, 'aud') !== this.audience) {
      fail(ERROR_CODES.INVALID_AUDIENCE, 'aud 不符');
    }

    // 步驟 12–13
    requireString(payload, 'sub', { min: 1, max: 255 });
    const iat = requireInteger(payload, 'iat');
    const exp = requireInteger(payload, 'exp');

    // 步驟 14–15：套用 §10.4 的 clock skew（預設 15 秒，雙向對稱）。
    if (iat > nowUTC + this.clockSkewSeconds) {
      fail(ERROR_CODES.TOKEN_NOT_ACTIVE, 'Assertion 尚未生效，請確認雙方已 NTP 校時');
    }
    if (exp <= nowUTC - this.clockSkewSeconds) {
      fail(ERROR_CODES.TOKEN_EXPIRED, 'Assertion 已過期');
    }
    // 步驟 16：token 自身的一致性檢查，**不套用** skew。
    if (exp <= iat || exp - iat > this.maxLifetimeSeconds) {
      fail(ERROR_CODES.INVALID_CLAIMS, `有效期不符規格 §4.3（上限 ${this.maxLifetimeSeconds} 秒）`);
    }

    // 步驟 17
    requireString(payload, 'jti', { min: 8, max: 128 });

    // 步驟 18：選填 claims 若存在，型別必須正確（規格 §4.2.2）。
    for (const claim of ['name', 'email', 'locale']) {
      if (claim in payload) requireString(payload, claim);
    }
    if ('picture' in payload && !HTTPS_URL.test(String(payload.picture))) {
      fail(ERROR_CODES.INVALID_CLAIMS, 'picture 必須是 https:// URL');
    }
    if ('roles' in payload) {
      const { roles } = payload;
      if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
        fail(ERROR_CODES.INVALID_CLAIMS, 'roles 必須是字串陣列');
      }
    }

    // 規格 §11.1：不得因 Assertion 含有未知 claims 而拒絕驗證——自訂 claims 原樣帶出。
    return Object.freeze({ ...payload }) as AssertionClaims;
  }
}
