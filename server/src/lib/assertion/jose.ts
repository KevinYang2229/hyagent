/**
 * JOSE 基礎工具：演算法對照表、Base64URL 切段與解碼。
 *
 * 對應規格：§2.1 演算法、§4.1 JWT Header、§8.1 結構檢查。
 * 移植自參考實作 `HyAgentSDK(js)/src/internal/jose.mjs`。
 *
 * 一般不需直接使用，由 verifier 與測試用簽發器共用。要新增支援的演算法時改 ALGORITHMS。
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { ERROR_CODES, fail } from './errors';

export type AssertionAlgorithm = 'RS256' | 'ES256';

export interface AlgorithmSpec {
  /** 傳給 node:crypto sign/verify 的摘要演算法名稱 */
  hash: string;
  keyType: 'rsa' | 'ec';
  /** EC 專用：JWS 要求 R||S 原始格式，Node 預設輸出 DER */
  dsaEncoding?: 'ieee-p1363';
  /** 固定長度的簽章位元組數；RSA 隨金鑰長度變動故為 null */
  signatureBytes: number | null;
}

/**
 * 規格 §2.1 允許的演算法。
 *
 * ES256 的 JWS 簽章是 R||S 原始格式（各 32 bytes，共 64 bytes），但 node:crypto 的
 * sign/verify 預設輸出 DER，必須指定 dsaEncoding: 'ieee-p1363'。
 * 這是 ES256 整合最常見的失敗原因（規格 §2.1 特別警告）。
 */
export const ALGORITHMS: Readonly<Record<AssertionAlgorithm, AlgorithmSpec>> = Object.freeze({
  RS256: Object.freeze({ hash: 'RSA-SHA256', keyType: 'rsa', signatureBytes: null }),
  ES256: Object.freeze({
    hash: 'SHA256',
    keyType: 'ec',
    dsaEncoding: 'ieee-p1363',
    signatureBytes: 64,
  }),
} as const);

export function isAssertionAlgorithm(value: unknown): value is AssertionAlgorithm {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALGORITHMS, value);
}

/**
 * 規格 §4.1：header 不得指向外部金鑰。
 * 帶這些參數等於讓攻擊者自備公鑰，驗章就形同虛設。
 */
export const FORBIDDEN_HEADER_PARAMS = Object.freeze(['jku', 'jwk', 'x5u', 'x5c'] as const);

/**
 * 正規化成公鑰 KeyObject。
 * Node 的 createPublicKey 不接受已是 public 的 KeyObject，故先行短路。
 */
export function toPublicKey(key: KeyObject | string | Buffer): KeyObject {
  if (typeof key === 'object' && key !== null && 'type' in key && key.type === 'public') return key;
  return createPublicKey(key as string | Buffer);
}

/** node:crypto 的 sign/verify 對 EC 需要額外的 dsaEncoding 設定。 */
export function keyArg(key: KeyObject, spec: AlgorithmSpec): KeyObject | { key: KeyObject; dsaEncoding: 'ieee-p1363' } {
  return spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key;
}

/** JSON → Base64URL。 */
export function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 規格 §8.1 步驟 1–2：切成三段並檢查 Base64URL 字元集。 */
export function splitToken(token: unknown): [string, string, string] {
  if (typeof token !== 'string') {
    fail(ERROR_CODES.MALFORMED_TOKEN, 'Assertion 必須是字串');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    fail(ERROR_CODES.MALFORMED_TOKEN, 'JWT 必須包含 header、payload 與 signature 三段');
  }
  if (parts.some((part) => !BASE64URL.test(part))) {
    fail(ERROR_CODES.MALFORMED_TOKEN, 'JWT 含有無效的 Base64URL 內容');
  }
  return parts as [string, string, string];
}

/** 規格 §8.1 步驟 3：解碼並確認為 JSON object（不得為陣列或 null）。 */
export function decodeJsonPart(value: string, partName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    fail(ERROR_CODES.MALFORMED_TOKEN, `JWT ${partName} 不是合法的 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(ERROR_CODES.MALFORMED_TOKEN, `JWT ${partName} 必須是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}
