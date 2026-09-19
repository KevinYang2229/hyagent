/**
 * 租戶 Assertion 公鑰的解析與不變條件（規格 §2.5、§7.3、§10.4）。
 *
 * 全部是純函式，不碰 store。規格 §7.3 明文要求這些不變條件由**後端**強制、
 * 不得僅在 UI 層——抽成純函式才測得到「拒絕」那幾條路徑，而不是只測存進去了什麼。
 *
 * 錯誤一律是 HyAgentTokenError，帶 §9 的三個管理端錯誤碼：
 *   KEY_LIMIT_EXCEEDED (409) / LAST_ACTIVE_KEY (409) / INVALID_REQUEST (400)
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  ERROR_CODES,
  HyAgentTokenError,
  MIN_RSA_MODULUS_BITS,
  computeKid,
  detectAlgorithm,
  type AssertionAlgorithm,
} from '@/lib/assertion';
import type { TenantPublicKey, TenantPublicKeyStatus } from './tenant.types';

/** 規格 §2.5：每租戶最多 2 把 active。 */
export const MAX_ACTIVE_KEYS = 2;

/** 規格 §10.4。 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 15;
export const MAX_CLOCK_SKEW_SECONDS = 30;

/** 規格 §4.3：Assertion 有效期建議 60、上限 300。下限取 30，低於此值容忍值只剩個位數秒。 */
export const DEFAULT_ASSERTION_LIFETIME_SECONDS = 60;
export const MIN_ASSERTION_LIFETIME_SECONDS = 30;
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;

/** 規格 §7.1：Session 有效期預設 3600，租戶可設 300～28800。 */
export const DEFAULT_SESSION_EXPIRES_IN = 3600;
export const MIN_SESSION_EXPIRES_IN = 300;
export const MAX_SESSION_EXPIRES_IN = 28_800;

function invalid(message: string): never {
  throw new HyAgentTokenError(ERROR_CODES.INVALID_REQUEST, message);
}

/** PKCS#8、PKCS#1（RSA）、SEC1（EC）與加密私鑰的 PEM 標頭。 */
const PRIVATE_KEY_PEM = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/**
 * 誤貼私鑰是整個上傳流程最可能發生、後果也最嚴重的操作失誤。
 *
 * Node 的 createPublicKey() 接受私鑰並回傳其對應公鑰，因此若不主動辨識，這個貼錯會
 * **完全靜默地成功**：kid 正確、驗章正常、租戶用得好好的，沒有任何跡象顯示他們剛把
 * 私鑰交了出來。訊息必須明講後續處置——那把金鑰已經離開客戶環境，換掉才算了事。
 */
function rejectPrivateKey(): never {
  invalid('這是私鑰，不是公鑰。私鑰絕不可離開貴方環境；此金鑰對請視為已洩漏，重新產生一對後只上傳公鑰');
}

export interface ParsedPublicKey {
  kid: string;
  alg: AssertionAlgorithm;
  /** 正規化後的 SPKI PEM（規格 §2.3） */
  publicKey: string;
}

/**
 * 把上傳的公鑰（SPKI PEM 或 JWK JSON）解析成可入庫的形式。
 *
 * `kid` 一律由此算出：規格 §2.4 定義它是公鑰的 RFC 7638 Thumbprint，接受呼叫端指定
 * 等於讓上傳者自選索引鍵，同一把公鑰可被登記成多個 kid，撤銷時就漏得掉。
 */
export function parsePublicKey(input: unknown): ParsedPublicKey {
  if (typeof input !== 'string' || !input.trim()) invalid('publicKey 必須是非空字串');
  const raw = (input as string).trim();

  let key: KeyObject;
  try {
    // 以 `{` 開頭視為 JWK，其餘走 PEM。兩種都是規格 §7.3 允許的上傳格式。
    if (raw.startsWith('{')) {
      const jwk = JSON.parse(raw) as import('node:crypto').JsonWebKey;
      // JWK 的 d 是私鑰參數。必須在 createPublicKey 之前擋——它會從私鑰 JWK 推導出公鑰，
      // 貼錯的人不會收到任何錯誤，而我們就此持有了一把不該持有的私鑰（規格 §2.2）。
      if (jwk.d !== undefined) rejectPrivateKey();
      key = createPublicKey({ key: jwk, format: 'jwk' });
    } else {
      if (PRIVATE_KEY_PEM.test(raw)) rejectPrivateKey();
      key = createPublicKey(raw);
    }
  } catch (err) {
    if (err instanceof HyAgentTokenError) throw err;
    invalid('publicKey 不是有效的 SPKI PEM 或 JWK');
  }

  let alg: AssertionAlgorithm;
  try {
    alg = detectAlgorithm(key);
  } catch {
    invalid(`金鑰型別不符規格 §2.1，僅支援 RSA（≥${MIN_RSA_MODULUS_BITS} bits）或 EC P-256`);
  }

  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (alg === 'RS256' && (modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) {
    invalid(`規格 §2.1 要求 RSA modulus 至少 ${MIN_RSA_MODULUS_BITS} bits`);
  }

  return {
    kid: computeKid(key),
    alg,
    publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function activeKeys(keys: readonly TenantPublicKey[] = []): TenantPublicKey[] {
  return keys.filter((k) => k.status === 'active');
}

/**
 * 上傳前檢查（規格 §7.3）。
 *
 * 回傳既有那一筆＝冪等：同一把公鑰重複上傳不新增第二筆，也不改它現在的狀態。
 * 若不冪等，客戶重按一次上傳就會吃掉 2 把 active 的額度；若順手把狀態改回 active，
 * 重新上傳一把已撤銷的公鑰就成了繞過撤銷的後門。
 */
export function checkCanAddKey(
  keys: readonly TenantPublicKey[] = [],
  kid: string,
): { existing?: TenantPublicKey } {
  const existing = keys.find((k) => k.kid === kid);
  if (existing) return { existing };
  if (activeKeys(keys).length >= MAX_ACTIVE_KEYS) {
    throw new HyAgentTokenError(
      ERROR_CODES.KEY_LIMIT_EXCEEDED,
      `每個 Tenant 最多 ${MAX_ACTIVE_KEYS} 把 active 公鑰，請先停用或撤銷其中一把`,
    );
  }
  return {};
}

/**
 * 狀態變更前檢查（規格 §7.3）。
 *
 * 停用最後一把 active → 拒絕：租戶會立刻無法登入，而這不是任何人想要的結果。
 * 撤銷最後一把 active → 允許：私鑰已外洩時，安全優先於可用性。二次確認由 UI 負責（§2.6）。
 */
export function checkCanSetStatus(
  keys: readonly TenantPublicKey[] = [],
  kid: string,
  next: TenantPublicKeyStatus,
): TenantPublicKey {
  const target = keys.find((k) => k.kid === kid);
  if (!target) invalid('查無此 kid');
  if (target.status === 'revoked' && next !== 'revoked') {
    invalid('已撤銷的公鑰不可復原，請重新上傳一把新的');
  }
  if (next === 'disabled' && target.status === 'active' && activeKeys(keys).length <= 1) {
    throw new HyAgentTokenError(
      ERROR_CODES.LAST_ACTIVE_KEY,
      '不可停用最後一把 active 公鑰；若確定要停止服務，請改用撤銷',
    );
  }
  if (next === 'active' && target.status !== 'active' && activeKeys(keys).length >= MAX_ACTIVE_KEYS) {
    throw new HyAgentTokenError(
      ERROR_CODES.KEY_LIMIT_EXCEEDED,
      `每個 Tenant 最多 ${MAX_ACTIVE_KEYS} 把 active 公鑰`,
    );
  }
  return target;
}

function requireIntegerInRange(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${field} 必須是 ${min}～${max} 的整數`);
  }
  return value as number;
}

export interface TenantAssertionSettings {
  clockSkewSeconds: number;
  assertionLifetimeSeconds: number;
  sessionExpiresIn: number;
}

/** 讀出逐租戶設定，未設者填規格預設值。後台的「現行值 / 偏離預設」面板也吃這個（§11.1）。 */
export function resolveAssertionSettings(tenant: {
  clockSkewSeconds?: number;
  assertionLifetimeSeconds?: number;
  sessionExpiresIn?: number;
}): TenantAssertionSettings {
  return {
    clockSkewSeconds: tenant.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
    assertionLifetimeSeconds: tenant.assertionLifetimeSeconds ?? DEFAULT_ASSERTION_LIFETIME_SECONDS,
    sessionExpiresIn: tenant.sessionExpiresIn ?? DEFAULT_SESSION_EXPIRES_IN,
  };
}

/**
 * 驗證逐租戶設定（規格 §4.3、§7.1、§10.4）。
 *
 * 部分更新時未帶的欄位沿用租戶現值，因為 §4.3 的「skew 不得超過有效期 ¼」是兩個欄位的
 * **交叉**條件：單獨改任一邊都可能踩線，必須拿改完的整組去驗。
 */
export function validateAssertionSettings(
  current: TenantAssertionSettings,
  patch: {
    clockSkewSeconds?: number;
    assertionLifetimeSeconds?: number;
    sessionExpiresIn?: number;
  },
): TenantAssertionSettings {
  const next: TenantAssertionSettings = {
    clockSkewSeconds:
      patch.clockSkewSeconds === undefined
        ? current.clockSkewSeconds
        : requireIntegerInRange(patch.clockSkewSeconds, 0, MAX_CLOCK_SKEW_SECONDS, 'clockSkewSeconds'),
    assertionLifetimeSeconds:
      patch.assertionLifetimeSeconds === undefined
        ? current.assertionLifetimeSeconds
        : requireIntegerInRange(
            patch.assertionLifetimeSeconds,
            MIN_ASSERTION_LIFETIME_SECONDS,
            MAX_ASSERTION_LIFETIME_SECONDS,
            'assertionLifetimeSeconds',
          ),
    sessionExpiresIn:
      patch.sessionExpiresIn === undefined
        ? current.sessionExpiresIn
        : requireIntegerInRange(
            patch.sessionExpiresIn,
            MIN_SESSION_EXPIRES_IN,
            MAX_SESSION_EXPIRES_IN,
            'sessionExpiresIn',
          ),
  };

  if (next.clockSkewSeconds * 4 > next.assertionLifetimeSeconds) {
    invalid(
      `clockSkewSeconds 不得超過 Assertion 有效期的 ¼（目前有效期 ${next.assertionLifetimeSeconds} 秒，上限 ${Math.floor(next.assertionLifetimeSeconds / 4)} 秒）`,
    );
  }
  return next;
}
