/**
 * 公鑰指紋（kid）與金鑰對產生的測試（規格 §2 金鑰對規格、§2.4 kid 計算）。
 *
 * 移植自參考實作 `HyAgentSDK(js)/test/keygen.test.mjs`（8 項）。
 * 改動 computeKid() 或新增支援演算法時，這裡是回歸基準——
 * kid 算錯會讓客戶手上的公鑰與 HyAgent 後台顯示的對不起來，且錯得很難察覺。
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { computeKid, detectAlgorithm, generateHyAgentKeyPair } from '@/lib/assertion';

it('RS256 產生 2048 bits RSA 金鑰對，格式符合規格 §2.3', () => {
  const key = generateHyAgentKeyPair('RS256');
  expect(key.alg).toBe('RS256');
  expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);

  const publicKey = createPublicKey(key.publicKeyPem);
  expect(publicKey.asymmetricKeyType).toBe('rsa');
  expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  // 規格 §2.1：public exponent 必須是 65537。
  expect(publicKey.asymmetricKeyDetails?.publicExponent).toBe(65537n);
});

it('ES256 產生 P-256 金鑰對', () => {
  const key = generateHyAgentKeyPair('ES256');
  const publicKey = createPublicKey(key.publicKeyPem);
  expect(publicKey.asymmetricKeyType).toBe('ec');
  expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
});

it('拒絕規格未允許的演算法與過短的 RSA 金鑰', () => {
  expect(() => generateHyAgentKeyPair('HS256' as never)).toThrow(TypeError);
  expect(() => generateHyAgentKeyPair('none' as never)).toThrow(TypeError);
  expect(() => generateHyAgentKeyPair('RS256', { modulusLength: 1024 })).toThrow(RangeError);
});

it('kid 由公鑰決定：PEM、公鑰與私鑰算出的結果相同', () => {
  const key = generateHyAgentKeyPair('ES256');
  expect(computeKid(key.publicKeyPem)).toBe(key.kid);
  expect(computeKid(createPublicKey(key.publicKeyPem))).toBe(key.kid);
  // 私鑰能算出同一個 kid，客戶端才能在只有私鑰時自行核對（規格 §2.4）。
  expect(computeKid(createPrivateKey(key.privateKeyPem))).toBe(key.kid);
});

it('kid 為 Base64URL 編碼的 SHA-256，長度 43 字元', () => {
  expect(generateHyAgentKeyPair('RS256').kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

it('不同金鑰對得到不同 kid，輪替時新舊可區分', () => {
  expect(generateHyAgentKeyPair('RS256').kid).not.toBe(generateHyAgentKeyPair('RS256').kid);
});

it('computeKid 符合 RFC 7638 的官方測試向量', () => {
  // RFC 7638 §3.1 的範例金鑰，其 thumbprint 為 NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs
  const jwk = {
    kty: 'RSA',
    n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
    e: 'AQAB',
  };
  const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  expect(computeKid(pem as string)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
});

it('detectAlgorithm 由金鑰型別推得演算法', () => {
  expect(detectAlgorithm(generateHyAgentKeyPair('RS256').publicKeyPem)).toBe('RS256');
  expect(detectAlgorithm(generateHyAgentKeyPair('ES256').privateKeyPem)).toBe('ES256');
});
