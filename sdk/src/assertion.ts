/**
 * HyAgent Identity Assertion 簽發（規格 §3、§4）。給**整合方後端**用。
 *
 * 零相依，只用 `node:crypto`——刻意不引入 `jsonwebtoken`：
 * 規格 §2.1 的 ES256 要求簽章為 R‖S 串接（`dsaEncoding: "ieee-p1363"`），
 * 直接用 `node:crypto` 才控制得到；同時讓整個 SDK 不帶任何執行期相依。
 *
 * **私鑰永遠不離開貴方環境**（規格 §2.2）。HyAgent 只持有公鑰，
 * 因此我們沒有能力偽造任何一位使用者的身分——這是換用非對稱金鑰的主要收穫。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signOne,
  type KeyObject,
} from 'node:crypto';

/** 規格 §2.1 支援的演算法。 */
export type AssertionAlgorithm = 'RS256' | 'ES256';

interface AlgorithmSpec {
  hash: 'sha256';
  keyType: 'rsa' | 'ec';
  dsaEncoding?: 'ieee-p1363';
}

const ALGORITHMS: Readonly<Record<AssertionAlgorithm, AlgorithmSpec>> = Object.freeze({
  RS256: { hash: 'sha256', keyType: 'rsa' },
  // ieee-p1363 = R‖S 串接。預設的 DER 編碼會被 HyAgent 以 INVALID_SIGNATURE 拒絕（規格 §2.1）。
  ES256: { hash: 'sha256', keyType: 'ec', dsaEncoding: 'ieee-p1363' },
});

/** 規格 §2.1：RSA modulus 下限。 */
export const MIN_RSA_MODULUS_BITS = 2048;
/** 規格 §4.3：建議有效期 60 秒、上限 300 秒。 */
export const DEFAULT_LIFETIME_SECONDS = 60;
export const MAX_LIFETIME_SECONDS = 300;
/** 規格 §4.2.1：aud 對所有 Tenant 都是同一個固定值；客戶識別放在 iss。 */
export const DEFAULT_AUDIENCE = 'hyagent';
/** 規格 §4.2.4。 */
export const MAX_ASSERTION_BYTES = 4096;

/** 規格 §4.2.1 的核心 claims，不允許由 profile 覆寫。 */
const RESERVED_CLAIMS = Object.freeze(['iss', 'sub', 'aud', 'iat', 'exp', 'jti'] as const);

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function toPrivateKey(key: KeyObject | string | Buffer): KeyObject {
  if (typeof key === 'object' && key !== null && 'type' in key && key.type === 'private') return key;
  return createPrivateKey(key as string | Buffer);
}

interface PublicJwk {
  kty?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
}

function publicJwk(key: KeyObject | string | Buffer): PublicJwk {
  const pub =
    typeof key === 'object' && key !== null && 'type' in key && key.type === 'public'
      ? key
      : createPublicKey(key as string | Buffer);
  return pub.export({ format: 'jwk' }) as PublicJwk;
}

/**
 * 依 RFC 7638 計算 JWK Thumbprint，即 HyAgent 的 `kid`（規格 §2.4）。
 * 傳公鑰或私鑰結果相同。
 */
export function computeKid(key: KeyObject | string | Buffer): string {
  const jwk = publicJwk(key);
  // Canonical JWK 的欄位與順序由 RFC 7638 固定，不得增減或重排，否則算出的 kid 會對不上。
  const canonical =
    jwk.kty === 'RSA'
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

/** 由金鑰型別推得規格 §2.1 允許的演算法。 */
export function detectAlgorithm(key: KeyObject | string | Buffer): AssertionAlgorithm {
  const jwk = publicJwk(key);
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  throw new TypeError('金鑰型別不符規格 §2.1，僅支援 RSA 或 EC P-256');
}

export interface GeneratedKeyPair {
  alg: AssertionAlgorithm;
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * 產生一組符合規格 §2 的金鑰對。**只把 `publicKeyPem` 交給 HyAgent。**
 *
 * 產生動作放在客戶端是設計的一部分，不是便利措施：HyAgent 若曾持有私鑰，
 * 「HyAgent 無法偽造客戶身分」這句話就不再成立（規格 §2.2）。
 */
export function generateKeyPair(
  alg: AssertionAlgorithm = 'RS256',
  { modulusLength = MIN_RSA_MODULUS_BITS }: { modulusLength?: number } = {},
): GeneratedKeyPair {
  if (!ALGORITHMS[alg]) throw new TypeError(`不支援的 alg：${alg}，僅接受 RS256 或 ES256`);
  if (alg === 'RS256' && modulusLength < MIN_RSA_MODULUS_BITS) {
    throw new RangeError(`規格 §2.1 要求 RSA modulus 至少 ${MIN_RSA_MODULUS_BITS} bits`);
  }
  const { publicKey, privateKey } =
    alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength });

  return {
    alg,
    kid: computeKid(publicKey),
    // 規格 §2.3：公鑰 SPKI、私鑰 PKCS#8，皆為 PEM。
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export interface IssueAssertionOptions {
  /** PKCS#8 PEM、Buffer 或 KeyObject。**只在貴方後端載入。** */
  privateKey: KeyObject | string | Buffer;
  /** Tenant ID，會成為 `iss`（規格 §8.4 步驟 10 要求它等於 Tenant ID） */
  tenant: string;
  /** 終端使用者在貴方系統的唯一識別，會成為 `sub` */
  subject: string | number;
  /** 省略時由私鑰型別推得 */
  alg?: AssertionAlgorithm;
  /** 省略時由私鑰計算 RFC 7638 Thumbprint */
  kid?: string;
  /** 自訂 claims（name、email、roles…）。HyAgent 不解讀語意，原樣帶過（規格 §4.2.3） */
  profile?: Record<string, unknown>;
  /** 預設 60 秒，上限 300（規格 §4.3） */
  lifetimeSeconds?: number;
  audience?: string;
  /** 簽發時間，僅供可重現測試使用 */
  now?: number;
}

/**
 * 簽發一張 HyAgent Identity Assertion。
 *
 * **每次呼叫都會產生新的 `jti`**，所以每一張都是一次性的兌換券——
 * 這正是 Token Provider 契約（§6.5）要求「每次被呼叫都回傳當下新簽發的字串」的原因：
 * 快取重用會被 HyAgent 以 `TOKEN_REPLAYED` 拒絕。
 */
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
  if (typeof tenant !== 'string' || tenant.length === 0) throw new TypeError('tenant 為必要欄位');
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
    spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key,
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

/** 綁定一組金鑰與 Tenant 的簽發器，省去每次重複帶參數。 */
export class AssertionIssuer {
  private readonly options: Omit<IssueAssertionOptions, 'subject' | 'profile' | 'now'>;

  constructor(options: Omit<IssueAssertionOptions, 'subject' | 'profile' | 'now'>) {
    this.options = options;
  }

  issue(
    subject: string | number,
    profile: Record<string, unknown> = {},
  ): string {
    return issueAssertion({ ...this.options, subject, profile });
  }
}
