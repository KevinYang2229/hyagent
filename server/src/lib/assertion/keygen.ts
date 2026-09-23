/**
 * 公鑰指紋（kid）計算與金鑰對產生。
 *
 * 對應規格：§2 金鑰對規格、§2.4 kid 計算、§3 金鑰對產生。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-keygen.mjs`。
 *
 * 後端會用到的是 computeKid()（客戶上傳公鑰時算出 kid）與 detectAlgorithm()。
 * generateHyAgentKeyPair() 留給測試與日後的 keygen CLI——
 * **HyAgent 永遠不產生也不持有客戶私鑰**（規格 §2.2），正式流程不會呼叫它。
 */
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AssertionAlgorithm } from './jose';

/** 規格 §2.1 支援的演算法。 */
export const SUPPORTED_ALGORITHMS = Object.freeze(['RS256', 'ES256'] as const);

/** RSA modulus 下限（規格 §2.1）。 */
export const MIN_RSA_MODULUS_BITS = 2048;

interface PublicJwk {
  kty?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
}

/** 取得公鑰 JWK；傳入私鑰時自動取其對應公鑰。 */
export function exportPublicJwk(key: KeyObject | string | Buffer): PublicJwk {
  const publicKey =
    typeof key === 'object' && key !== null && 'type' in key && key.type === 'public'
      ? key
      : createPublicKey(key as string | Buffer);
  return publicKey.export({ format: 'jwk' }) as PublicJwk;
}

/**
 * 依 RFC 7638 計算 JWK Thumbprint，作為 HyAgent 的 kid（規格 §2.4）。
 * 接受 PEM 字串、公鑰 KeyObject 或私鑰 KeyObject，結果都相同。
 */
export function computeKid(key: KeyObject | string | Buffer): string {
  const jwk = exportPublicJwk(key);

  // Canonical JWK 的欄位與順序由 RFC 7638 固定，不得增減或重排，
  // 否則算出的 kid 會與客戶端（及規格參考實作）不一致。
  const canonical =
    jwk.kty === 'RSA'
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

/** 由金鑰型別推得規格 §2.1 允許的演算法。 */
export function detectAlgorithm(key: KeyObject | string | Buffer): AssertionAlgorithm {
  const jwk = exportPublicJwk(key);
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

/** 產生符合規格 §2 的金鑰對（測試與 CLI 用，見檔頭說明）。 */
export function generateHyAgentKeyPair(
  alg: AssertionAlgorithm = 'RS256',
  { modulusLength = MIN_RSA_MODULUS_BITS }: { modulusLength?: number } = {},
): GeneratedKeyPair {
  if (!SUPPORTED_ALGORITHMS.includes(alg)) {
    throw new TypeError(`不支援的 alg：${alg}，僅接受 ${SUPPORTED_ALGORITHMS.join(' 或 ')}`);
  }
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
    // 規格 §2.3：公鑰用 SPKI、私鑰用 PKCS#8，皆為 PEM 編碼。
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
