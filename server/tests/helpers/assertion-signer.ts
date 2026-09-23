/**
 * Identity Assertion 簽發器——**測試用**。
 *
 * 對應規格：§4 Identity Assertion Protocol、§4.5 簽發範例。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-assertion.mjs`。
 *
 * 為什麼放在 tests/：簽發跑在**客戶後端**，HyAgent 永遠不簽發 Assertion、也不持有私鑰
 * （規格 §2.2）。這份程式存在的唯一理由是讓驗證器的測試能造出合規與不合規的 token。
 * 正式要交付給客戶的簽發器屬 `sdk/`（評估文件 Phase 2 的 `issueAssertion()`），
 * 屆時可直接把這支移過去。
 */
import { randomUUID, createPrivateKey, sign as signOne, type KeyObject } from 'node:crypto';
import {
  ALGORITHMS,
  encodeJson,
  keyArg,
  type AssertionAlgorithm,
} from '@/lib/assertion/jose';
import { computeKid, detectAlgorithm } from '@/lib/assertion/keygen';

/** 規格 §4.3 生命週期。 */
export const DEFAULT_LIFETIME_SECONDS = 60;
export const MAX_LIFETIME_SECONDS = 300;

/**
 * 規格 §4.2.1：aud 是「這張 token 要給誰用」，對所有 Tenant 都是同一個固定值。
 * 客戶識別放在 iss（Tenant ID），不要放進 aud。
 */
export const DEFAULT_AUDIENCE = 'hyagent';

/** 規格 §4.2.4。 */
export const MAX_ASSERTION_BYTES = 4096;

/** 規格 §4.2.1 的核心 claims，不允許由 profile 覆寫。 */
const RESERVED_CLAIMS = Object.freeze(['iss', 'sub', 'aud', 'iat', 'exp', 'jti'] as const);

function toPrivateKey(key: KeyObject | string | Buffer): KeyObject {
  if (typeof key === 'object' && key !== null && 'type' in key && key.type === 'private') return key;
  return createPrivateKey(key as string | Buffer);
}

export interface IssueAssertionOptions {
  privateKey: KeyObject | string | Buffer;
  tenant: string;
  subject: string | number;
  alg?: AssertionAlgorithm;
  kid?: string;
  profile?: Record<string, unknown>;
  lifetimeSeconds?: number;
  audience?: string;
  /** 簽發時間，僅供可重現測試使用 */
  now?: number;
}

/** 簽發一張 HyAgent Identity Assertion。 */
export function issueAssertion({
  privateKey,
  alg,
  kid,
  tenant,
  subject,
  profile = {},
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
  audience = DEFAULT_AUDIENCE,
  now = Math.floor(Date.now() / 1000),
}: IssueAssertionOptions): string {
  const key = toPrivateKey(privateKey);
  const algorithm = alg ?? detectAlgorithm(key);
  const spec = ALGORITHMS[algorithm];

  if (!spec) throw new TypeError(`不支援的 alg：${String(algorithm)}`);
  if (key.asymmetricKeyType !== spec.keyType) {
    throw new TypeError(`private key 型別（${key.asymmetricKeyType}）與 ${algorithm} 不符`);
  }
  if (typeof tenant !== 'string' || tenant.length === 0) {
    throw new TypeError('tenant 為必要欄位');
  }
  if (subject === undefined || subject === null || String(subject).length === 0) {
    throw new TypeError('subject 為必要欄位');
  }
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > MAX_LIFETIME_SECONDS
  ) {
    throw new RangeError(`lifetimeSeconds 必須介於 1 到 ${MAX_LIFETIME_SECONDS} 秒（規格 §4.3）`);
  }

  // 核心 claims 一律由本函式決定，避免呼叫端誤把 iss/sub/exp 從外部參數帶進來。
  const collisions = RESERVED_CLAIMS.filter((claim) => claim in profile);
  if (collisions.length > 0) {
    throw new TypeError(`profile 不得包含核心 claims：${collisions.join(', ')}`);
  }

  const header = encodeJson({ alg: algorithm, typ: 'JWT', kid: kid ?? computeKid(key) });
  const payload = encodeJson({
    ...profile,
    iss: tenant,
    sub: String(subject),
    aud: audience,
    iat: now,
    exp: now + lifetimeSeconds,
    // 規格 §8.5：jti 必須每次不同，HyAgent 以此擋重放。
    jti: randomUUID(),
  });

  const signature = signOne(
    spec.hash,
    Buffer.from(`${header}.${payload}`, 'ascii'),
    keyArg(key, spec),
  );
  const token = `${header}.${payload}.${signature.toString('base64url')}`;

  // 規格 §4.2.4：在簽發端就擋下比較容易定位問題（通常是自訂 claims 放太多）。
  if (Buffer.byteLength(token) > MAX_ASSERTION_BYTES) {
    throw new RangeError(
      `Assertion 長度 ${Buffer.byteLength(token)} bytes 超過規格 §4.2.4 上限 ${MAX_ASSERTION_BYTES} bytes，請減少自訂 claims`,
    );
  }
  return token;
}

export interface AssertionIssuerOptions {
  privateKey: KeyObject | string | Buffer;
  tenant: string;
  alg?: AssertionAlgorithm;
  kid?: string;
  audience?: string;
  lifetimeSeconds?: number;
}

/** 綁定 Tenant 與金鑰的簽發器：私鑰只解析一次、kid 只計算一次。 */
export class AssertionIssuer {
  readonly privateKey: KeyObject;
  readonly tenant: string;
  readonly alg: AssertionAlgorithm;
  readonly kid: string;
  readonly audience: string;
  readonly lifetimeSeconds: number;

  constructor({
    privateKey,
    tenant,
    alg,
    kid,
    audience = DEFAULT_AUDIENCE,
    lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
  }: AssertionIssuerOptions) {
    this.privateKey = toPrivateKey(privateKey);
    this.tenant = tenant;
    this.alg = alg ?? detectAlgorithm(this.privateKey);
    this.kid = kid ?? computeKid(this.privateKey);
    this.audience = audience;
    this.lifetimeSeconds = lifetimeSeconds;
    Object.freeze(this);
  }

  issue(subject: string | number, profile: Record<string, unknown> = {}): string {
    return issueAssertion({
      privateKey: this.privateKey,
      alg: this.alg,
      kid: this.kid,
      tenant: this.tenant,
      subject,
      profile,
      audience: this.audience,
      lifetimeSeconds: this.lifetimeSeconds,
    });
  }
}
