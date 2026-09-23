/**
 * Assertion 簽發的測試（規格 §4 Identity Assertion Protocol）。
 *
 * 移植自參考實作 `HyAgentSDK(js)/test/assertion.test.mjs`（12 項）。
 *
 * 受測對象是 `tests/helpers/assertion-signer.ts`——它跑在**客戶後端**，不是 HyAgent 的
 * 正式程式碼（見該檔檔頭）。但驗證器的測試全靠它造 token，它錯了整組驗收都失去意義，
 * 因此照樣納入回歸基準。Phase 2 把簽發器搬進 `sdk/` 時，這份測試一起移過去。
 */
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { AssertionIssuer, issueAssertion } from './helpers/assertion-signer';

const rsa = generateHyAgentKeyPair('RS256');
const ec = generateHyAgentKeyPair('ES256');

const decode = (token: string) => ({
  header: JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>,
  payload: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>,
});

it('header 依規格 §4.1 帶 alg、typ 與 kid', () => {
  const { header } = decode(issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'hyoa', subject: 507 }));
  expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: rsa.kid });
});

it('核心 claims 齊備且有效期預設 60 秒（規格 §4.2.1、§4.3）', () => {
  const { payload } = decode(
    issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'hyoa', subject: 507, now: 1_700_000_000 }),
  );
  expect(payload.iss).toBe('hyoa');
  expect(payload.sub).toBe('507');
  expect(payload.aud).toBe('hyagent');
  expect(payload.iat).toBe(1_700_000_000);
  expect(payload.exp).toBe(1_700_000_060);
  expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
});

it('sub 一律轉成字串（規格 §4.2.1）', () => {
  const { payload } = decode(issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'hyoa', subject: 507 }));
  expect(typeof payload.sub).toBe('string');
});

it('每次簽發的 jti 都不同，才擋得住重放', () => {
  const issuer = new AssertionIssuer({ privateKey: rsa.privateKeyPem, tenant: 'hyoa' });
  const jtis = new Set(Array.from({ length: 50 }, () => decode(issuer.issue(507)).payload.jti));
  expect(jtis.size).toBe(50);
});

it('profile 的選填與自訂 claims 會原樣帶入（規格 §4.2.2、§4.2.3）', () => {
  const { payload } = decode(
    issueAssertion({
      privateKey: ec.privateKeyPem,
      tenant: 'hyoa',
      subject: 507,
      profile: { name: '羅玉瑩', roles: ['staff'], 'hyagent:profile': { deptName: '財務部' } },
    }),
  );
  expect(payload.name).toBe('羅玉瑩');
  expect(payload.roles).toEqual(['staff']);
  expect(payload['hyagent:profile']).toEqual({ deptName: '財務部' });
});

it('profile 不得覆寫核心 claims', () => {
  expect(() =>
    issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'hyoa', subject: 507, profile: { sub: '999' } }),
  ).toThrow(/profile 不得包含核心 claims/);
});

it('有效期超過規格 §4.3 上限即拒絕簽發', () => {
  const base = { privateKey: rsa.privateKeyPem, tenant: 'hyoa', subject: 507 };
  expect(() => issueAssertion({ ...base, lifetimeSeconds: 301 })).toThrow(RangeError);
  expect(() => issueAssertion({ ...base, lifetimeSeconds: 0 })).toThrow(RangeError);
  expect(() => issueAssertion({ ...base, lifetimeSeconds: 300 })).not.toThrow();
});

it('自訂 claims 過大時在簽發端就擋下（規格 §4.2.4）', () => {
  expect(() =>
    issueAssertion({
      privateKey: rsa.privateKeyPem,
      tenant: 'hyoa',
      subject: 507,
      profile: { blob: 'x'.repeat(4096) },
    }),
  ).toThrow(/超過規格 §4.2.4 上限/);
});

it('tenant 與 subject 為必填', () => {
  expect(() => issueAssertion({ privateKey: rsa.privateKeyPem, subject: 507 } as never)).toThrow(TypeError);
  expect(() => issueAssertion({ privateKey: rsa.privateKeyPem, tenant: 'hyoa' } as never)).toThrow(TypeError);
});

it('alg 與私鑰型別不符時拒絕簽發', () => {
  expect(() =>
    issueAssertion({ privateKey: rsa.privateKeyPem, alg: 'ES256', tenant: 'hyoa', subject: 507 }),
  ).toThrow(/private key 型別/);
});

it('ES256 簽章為 64 bytes 的 R||S 格式，而非 DER（規格 §2.1）', () => {
  const token = issueAssertion({ privateKey: ec.privateKeyPem, tenant: 'hyoa', subject: 507 });
  expect(Buffer.from(token.split('.')[2], 'base64url').length).toBe(64);
});

it('AssertionIssuer 自動推得 alg 與 kid', () => {
  const issuer = new AssertionIssuer({ privateKey: ec.privateKeyPem, tenant: 'hyoa' });
  expect(issuer.alg).toBe('ES256');
  expect(issuer.kid).toBe(ec.kid);
});
