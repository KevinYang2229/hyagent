/**
 * Identity Assertion 驗證器的測試（規格 §8 步驟 0–21、§9 錯誤碼、§10.4 clock skew）。
 *
 * 移植自參考實作 `HyAgentSDK(js)/test/verifier.test.mjs`（33 項），
 * 與 assertion-issuer（12 項）、assertion-keygen（8 項）合計 53 項，
 * 涵蓋規格附錄 A.3 列出的全部必要案例。
 *
 * **這是安全性的回歸基準**：改動 `src/lib/assertion/` 前後都要跑過。
 */
import { createHmac, sign as signOne } from 'node:crypto';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  ERROR_CODES,
  HyAgentAssertionVerifier,
  HyAgentTokenError,
  InMemoryKeyRegistry,
  MAX_CLOCK_SKEW_SECONDS,
  generateHyAgentKeyPair,
  isOriginAllowed,
  type AssertionErrorCode,
  type RegisterKeyInput,
  type VerifierOptions,
} from '@/lib/assertion';
import { issueAssertion } from './helpers/assertion-signer';

const TENANT = 'hyoa';
const NOW = 1_700_000_000;

const rsa = generateHyAgentKeyPair('RS256');
const ec = generateHyAgentKeyPair('ES256');

function makeVerifier(
  register: RegisterKeyInput[] = [{ tenant: TENANT, publicKey: rsa.publicKeyPem }],
  options: Partial<Omit<VerifierOptions, 'registry'>> = {},
) {
  const registry = new InMemoryKeyRegistry();
  for (const entry of register) registry.register(entry);
  return { registry, verifier: new HyAgentAssertionVerifier({ registry, ...options }) };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 以任意 header/payload 簽出 token，用來製造規格允許範圍外的測試案例。 */
function signRaw(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  { privateKey = rsa.privateKeyPem, hash = 'RSA-SHA256' }: { privateKey?: string; hash?: string } = {},
): string {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = signOne(hash, Buffer.from(signingInput, 'ascii'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  iss: TENANT,
  sub: '507',
  aud: 'hyagent',
  iat: NOW,
  exp: NOW + 60,
  jti: '7e83e67e-9e2d-49fb-980f-bb4b9ef0c0ac',
  ...overrides,
});

const validHeader = (overrides: Record<string, unknown> = {}) => ({
  alg: 'RS256',
  typ: 'JWT',
  kid: rsa.kid,
  ...overrides,
});

/** 斷言驗證失敗且錯誤碼相符。 */
function expectRejected(fn: () => unknown, code: AssertionErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HyAgentTokenError);
    expect((error as HyAgentTokenError).code).toBe(code);
    return;
  }
  throw new Error(`預期拋出 ${code}，但呼叫成功了`);
}

// --- 正常情境 ---

it('RS256 與 ES256 的有效 Assertion 皆通過', () => {
  for (const key of [rsa, ec]) {
    const { verifier } = makeVerifier([{ tenant: TENANT, publicKey: key.publicKeyPem }]);
    const token = issueAssertion({ privateKey: key.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
    const claims = verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW + 1 });
    expect(claims.sub).toBe('507');
    expect(claims.iss).toBe(TENANT);
  }
});

it('自訂 claims 原樣帶出，HyAgent 不做語意解讀（規格 §4.2.3）', () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({
    privateKey: rsa.privateKeyPem,
    tenant: TENANT,
    subject: 507,
    now: NOW,
    profile: { name: '羅玉瑩', 'hyagent:profile': { deptName: '財務部' } },
  });
  const claims = verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW });
  expect(claims.name).toBe('羅玉瑩');
  expect(claims['hyagent:profile']).toEqual({ deptName: '財務部' });
});

// --- 時間相關（規格 §8.4 步驟 14–16）---

it('skew 設為 0 時，exp 等於當下秒數即視為過期（規格 §8.4 步驟 15）', () => {
  const { verifier } = makeVerifier(undefined, { clockSkewSeconds: 0 });
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
  expect(() => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW + 59 })).not.toThrow();
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW + 60 }),
    ERROR_CODES.TOKEN_EXPIRED,
  );
});

it('skew 設為 0 時，iat 在未來回 TOKEN_NOT_ACTIVE', () => {
  const { verifier } = makeVerifier(undefined, { clockSkewSeconds: 0 });
  const token = signRaw(validHeader(), validPayload({ iat: NOW + 10, exp: NOW + 70 }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.TOKEN_NOT_ACTIVE,
  );
});

// --- 時鐘偏移容忍（規格 §10.4）---

it('預設容忍 15 秒（規格 §10.4）', () => {
  expect(DEFAULT_CLOCK_SKEW_SECONDS).toBe(15);
  expect(new HyAgentAssertionVerifier({ registry: new InMemoryKeyRegistry() }).clockSkewSeconds).toBe(15);
});

it('客戶時鐘慢：exp 已過但在容忍內仍通過，超過即 TOKEN_EXPIRED', () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
  // 有效期 60 秒，故 exp = NOW + 60；容忍 15 秒 → 接受至 NOW + 74。
  expect(() => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW + 74 })).not.toThrow();
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW + 75 }),
    ERROR_CODES.TOKEN_EXPIRED,
  );
});

it('客戶時鐘快：iat 在未來但在容忍內仍通過，超過即 TOKEN_NOT_ACTIVE', () => {
  const { verifier } = makeVerifier();
  const within = signRaw(validHeader(), validPayload({ iat: NOW + 15, exp: NOW + 75 }));
  expect(() => verifier.verify(within, { tenant: TENANT, clockTimestamp: NOW })).not.toThrow();
  const beyond = signRaw(validHeader(), validPayload({ iat: NOW + 16, exp: NOW + 76 }));
  expectRejected(
    () => verifier.verify(beyond, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.TOKEN_NOT_ACTIVE,
  );
});

it('clockSkewSeconds 超出 0～30 或非整數即拒絕（規格 §10.4）', () => {
  const registry = new InMemoryKeyRegistry();
  for (const bad of [-1, MAX_CLOCK_SKEW_SECONDS + 1, 1.5, '15' as unknown as number, NaN]) {
    expect(() => new HyAgentAssertionVerifier({ registry, clockSkewSeconds: bad })).toThrow(RangeError);
  }
  for (const ok of [0, 15, MAX_CLOCK_SKEW_SECONDS]) {
    expect(() => new HyAgentAssertionVerifier({ registry, clockSkewSeconds: ok })).not.toThrow();
  }
});

it('skew 不套用於 exp - iat 的自身一致性檢查（規格 §8.4 步驟 16）', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ iat: NOW, exp: NOW + 301 }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_CLAIMS,
  );
});

it('有效期超過 300 秒回 INVALID_CLAIMS', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ exp: NOW + 301 }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_CLAIMS,
  );
});

// --- 簽章與演算法（規格 §8.2–§8.3）---

it('payload 遭竄改回 INVALID_SIGNATURE', () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
  const [header, payload, signature] = token.split('.');
  const tampered = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  tampered.sub = '999';
  expectRejected(
    () => verifier.verify(`${header}.${b64(tampered)}.${signature}`, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_SIGNATURE,
  );
});

it('algorithm confusion：把 alg 改成 HS256 並用公鑰當 HMAC 金鑰，必須被擋下', () => {
  const { verifier } = makeVerifier();
  const signingInput = `${b64(validHeader({ alg: 'HS256' }))}.${b64(validPayload())}`;
  // 攻擊手法：公鑰是公開的，若驗證器依 header.alg 動態選擇演算法就會被偽造成功。
  const forged = createHmac('sha256', rsa.publicKeyPem).update(signingInput).digest('base64url');
  expectRejected(
    () => verifier.verify(`${signingInput}.${forged}`, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_ALGORITHM,
  );
});

it('alg=none 且簽章留空回 MALFORMED_TOKEN', () => {
  const { verifier } = makeVerifier();
  const token = `${b64(validHeader({ alg: 'none' }))}.${b64(validPayload())}.`;
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.MALFORMED_TOKEN,
  );
});

it('header 含 jku 等外部金鑰欄位一律拒絕（規格 §4.1）', () => {
  const { verifier } = makeVerifier();
  for (const param of ['jku', 'jwk', 'x5u', 'x5c']) {
    const token = signRaw(validHeader({ [param]: 'https://attacker.example/keys' }), validPayload());
    expectRejected(
      () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
      ERROR_CODES.INVALID_ALGORITHM,
    );
  }
});

it('ES256 簽章若為 DER 編碼則拒絕（規格 §2.1）', () => {
  const { verifier } = makeVerifier([{ tenant: TENANT, publicKey: ec.publicKeyPem }]);
  // 不指定 dsaEncoding，Node 預設輸出 DER，長度不等於 64。
  const token = signRaw(validHeader({ alg: 'ES256', kid: ec.kid }), validPayload(), {
    hash: 'SHA256',
    privateKey: ec.privateKeyPem,
  });
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_SIGNATURE,
  );
});

it('header.alg 與該 kid 註冊的演算法不符即拒絕', () => {
  const { verifier } = makeVerifier([{ tenant: TENANT, publicKey: ec.publicKeyPem }]);
  const token = signRaw(validHeader({ alg: 'RS256', kid: ec.kid }), validPayload());
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_ALGORITHM,
  );
});

// --- 金鑰查表（規格 §8.2 步驟 6）---

it('kid 不存在回 UNKNOWN_KID', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader({ kid: 'not-a-registered-kid' }), validPayload());
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.UNKNOWN_KID,
  );
});

it('header 缺少 kid 回 UNKNOWN_KID', () => {
  const { verifier } = makeVerifier();
  const token = signRaw({ alg: 'RS256', typ: 'JWT' }, validPayload());
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.UNKNOWN_KID,
  );
});

it('拿 Tenant A 的 kid 去冒充 Tenant B 回 UNKNOWN_KID（規格 §10.6 跨 Tenant 冒用）', () => {
  const { verifier } = makeVerifier([{ tenant: 'tenant-a', publicKey: rsa.publicKeyPem }]);
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'tenant-b', subject: 507, now: NOW });
  expectRejected(
    () => verifier.verify(token, { tenant: 'tenant-b', clockTimestamp: NOW }),
    ERROR_CODES.UNKNOWN_KID,
  );
});

it('撤銷的公鑰不可再使用（規格 §2.6）', () => {
  const { registry, verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
  registry.revoke(TENANT, rsa.kid);
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.KEY_REVOKED,
  );
});

it('輪替期間新舊公鑰可同時有效（規格 §2.5）', () => {
  const { verifier } = makeVerifier([
    { tenant: TENANT, publicKey: rsa.publicKeyPem },
    { tenant: TENANT, publicKey: ec.publicKeyPem },
  ]);
  for (const key of [rsa, ec]) {
    const token = issueAssertion({ privateKey: key.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
    expect(() => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW })).not.toThrow();
  }
});

// --- claims（規格 §8.4）---

it('iss 與請求 Tenant 不符回 INVALID_ISSUER', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ iss: 'someone-else' }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_ISSUER,
  );
});

it('aud 不符回 INVALID_AUDIENCE', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ aud: 'hyoa-ai' }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.INVALID_AUDIENCE,
  );
});

it('缺少或型別錯誤的核心 claims 回 INVALID_CLAIMS', () => {
  const { verifier } = makeVerifier();
  const cases = [{ sub: undefined }, { sub: 507 }, { jti: 'short' }, { iat: '1700000000' }, { exp: -1 }];
  for (const override of cases) {
    const token = signRaw(validHeader(), validPayload(override));
    expectRejected(
      () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
      ERROR_CODES.INVALID_CLAIMS,
    );
  }
});

it('選填 claims 型別錯誤回 INVALID_CLAIMS（規格 §8.4 步驟 18）', () => {
  const { verifier } = makeVerifier();
  const cases = [
    { roles: 'staff' },
    { roles: [1, 2] },
    { picture: 'http://insecure.example/a.png' },
    { name: 123 },
  ];
  for (const override of cases) {
    const token = signRaw(validHeader(), validPayload(override));
    expectRejected(
      () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
      ERROR_CODES.INVALID_CLAIMS,
    );
  }
});

// --- 結構與大小 ---

it('結構錯誤的 token 回 MALFORMED_TOKEN', () => {
  const { verifier } = makeVerifier();
  for (const token of ['', 'a.b', 'a.b.c.d', 'a..c', '!!!.b.c', 12345]) {
    expectRejected(
      () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
      ERROR_CODES.MALFORMED_TOKEN,
    );
  }
});

it('超過大小上限回 ASSERTION_TOO_LARGE（規格 §4.2.4）', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ blob: 'x'.repeat(4096) }));
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.ASSERTION_TOO_LARGE,
  );
});

it('大小上限先於解碼執行：超大且 JSON 不合法仍回 ASSERTION_TOO_LARGE（規格 §8.0 步驟 0）', () => {
  const { verifier } = makeVerifier();
  // 三段都不是合法 Base64URL JSON；若順序寫錯（先解碼）會得到 MALFORMED_TOKEN。
  const token = `${'x'.repeat(2000)}.${'y'.repeat(2000)}.${'z'.repeat(2000)}`;
  expectRejected(
    () => verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW }),
    ERROR_CODES.ASSERTION_TOO_LARGE,
  );
});

// --- 防重放與來源（規格 §8.5–§8.6）---

it('同一張 Assertion 送第二次回 TOKEN_REPLAYED', async () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });

  const claims = await verifier.verifyAndConsume(token, { tenant: TENANT, clockTimestamp: NOW });
  expect(claims.sub).toBe('507');

  await expect(
    verifier.verifyAndConsume(token, { tenant: TENANT, clockTimestamp: NOW }),
  ).rejects.toMatchObject({ code: ERROR_CODES.TOKEN_REPLAYED });
});

it('不同 Assertion 各自可用一次', async () => {
  const { verifier } = makeVerifier();
  for (let i = 0; i < 3; i += 1) {
    const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
    await expect(
      verifier.verifyAndConsume(token, { tenant: TENANT, clockTimestamp: NOW }),
    ).resolves.toMatchObject({ sub: '507' });
  }
});

it('verify() 不消耗 jti，verifyAndConsume() 才會', async () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });

  verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW });
  verifier.verify(token, { tenant: TENANT, clockTimestamp: NOW });
  await expect(
    verifier.verifyAndConsume(token, { tenant: TENANT, clockTimestamp: NOW }),
  ).resolves.toBeDefined();
});

it('Origin 白名單檢查（規格 §8.6）', () => {
  const allowed = ['https://oa.hyweb.com.tw'];
  expect(isOriginAllowed('https://oa.hyweb.com.tw', allowed)).toBe(true);
  expect(isOriginAllowed('https://evil.example', allowed)).toBe(false);
  expect(isOriginAllowed(undefined, allowed)).toBe(false);
  // 子網域與大小寫變形都不算相符。
  expect(isOriginAllowed('https://a.oa.hyweb.com.tw', allowed)).toBe(false);
});

// --- decode() ---

it('decode 可解析但不代表通過驗證（規格 §8.3）', () => {
  const { verifier } = makeVerifier();
  const token = signRaw(validHeader(), validPayload({ sub: '999' }));
  expect(verifier.decode(token).payload.sub).toBe('999');
});

it('verify() 必須指定 tenant，不可從未驗章的 payload 推得', () => {
  const { verifier } = makeVerifier();
  const token = issueAssertion({ privateKey: rsa.privateKeyPem, tenant: TENANT, subject: 507, now: NOW });
  // 型別上已擋下，這裡驗的是執行期防線（JS 呼叫端、或 any 繞過型別時）。
  const unchecked = verifier as unknown as { verify: (token: string) => unknown };
  expect(() => unchecked.verify(token)).toThrow(TypeError);
});
