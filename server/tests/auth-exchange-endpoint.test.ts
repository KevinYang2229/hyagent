/**
 * `POST /api/auth/sso/exchange` 的 HTTP 契約（規格 §5.3、§7.1、§7.5、§9）。
 *
 * assertion-exchange.test.ts 測的是換發邏輯；這裡測的是**端點**：狀態碼、回應形狀、
 * 錯誤格式，以及「租戶由 iss 決定、API Key 不參與身分判定」這條在 HTTP 層仍然成立。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { issueAssertion } from './helpers/assertion-signer';

const app = createApp();
const keyPair = generateHyAgentKeyPair('ES256');

function fixture(origins: string[] = ['*']) {
  const tenant = tenantStore.createTenant('endpoint fixture', origins);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  const sign = () =>
    issueAssertion({ privateKey: keyPair.privateKeyPem, tenant: tenant.id, subject: '507', profile: { name: '羅玉瑩' } });
  return { tenant, sign };
}

it('成功回 201 與不透明 sessionToken，並可直接用於受保護端點', async () => {
  const { sign } = fixture();
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion: sign() });

  expect(res.status).toBe(201);
  expect(res.body.data).toMatchObject({ expiresIn: expect.any(Number), user: { sub: '507', name: '羅玉瑩' } });
  expect(res.body.data.sessionToken).toMatch(/^hyas_/);
  // 回應不得帶出任何金鑰或 Assertion 原文（規格 §11.1）
  expect(JSON.stringify(res.body)).not.toContain('PUBLIC KEY');

  const me = await request(app).get('/api/auth/me').auth(res.body.data.sessionToken, { type: 'bearer' });
  expect(me.status).toBe(200);
});

it('租戶由 iss 決定：帶了別的租戶的 API Key 也不影響結果（決策 A）', async () => {
  const mine = fixture();
  const other = fixture();
  const otherKey = tenantStore.createApiKey(other.tenant.id, 'publishable').key;

  const res = await request(app)
    .post('/api/auth/sso/exchange')
    .set('x-api-key', otherKey)
    .send({ assertion: mine.sign() });

  expect(res.status).toBe(201);
});

it('失敗回應為 §7.5 的形狀，且用規格 §9 的細分代碼與狀態', async () => {
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion: 'not.a.jwt' });

  expect(res.status).toBe(401);
  expect(res.body).toMatchObject({ error: expect.any(String), message: expect.any(String) });
  expect(res.body.data).toBeUndefined();
});

it('iss 指向不存在的租戶 → 404 TENANT_NOT_FOUND', async () => {
  const { sign } = fixture();
  const assertion = issueAssertion({ privateKey: keyPair.privateKeyPem, tenant: 'nope', subject: 'x' });
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('TENANT_NOT_FOUND');
  expect(sign).toBeDefined();
});

it('超過 4096 bytes → 413 ASSERTION_TOO_LARGE（步驟 0，先於解碼）', async () => {
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion: 'x'.repeat(5000) });

  expect(res.status).toBe(413);
  expect(res.body.error).toBe('ASSERTION_TOO_LARGE');
});

it('Origin 不在白名單 → 403 ORIGIN_NOT_ALLOWED', async () => {
  const { sign } = fixture(['https://allowed.example.com']);
  const res = await request(app)
    .post('/api/auth/sso/exchange')
    .set('origin', 'https://evil.example.com')
    .send({ assertion: sign() });

  expect(res.status).toBe(403);
  expect(res.body.error).toBe('ORIGIN_NOT_ALLOWED');
});

describe('面板送來的 embedOrigin（規格 §8.6）', () => {
  const PANEL = 'https://panel.hyagent.test';
  const original = env.CORS_ORIGIN;
  beforeEach(() => {
    env.CORS_ORIGIN = PANEL;
  });
  afterEach(() => {
    env.CORS_ORIGIN = original;
  });

  it('Origin 是自己的面板時，改以 body 的 embedOrigin 比對白名單', async () => {
    const { sign } = fixture(['https://allowed.example.com']);
    const res = await request(app)
      .post('/api/auth/sso/exchange')
      .set('origin', PANEL)
      .send({ assertion: sign(), embedOrigin: 'https://allowed.example.com' });

    expect(res.status).toBe(201);
  });

  it('面板沒回報嵌入者（referrer 被抑制）→ 403，fail closed', async () => {
    const { sign } = fixture(['https://allowed.example.com']);
    const res = await request(app)
      .post('/api/auth/sso/exchange')
      .set('origin', PANEL)
      .send({ assertion: sign(), embedOrigin: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('第三方呼叫端偽造 embedOrigin 無效——瀏覽器設的 Origin 才算數', async () => {
    const { sign } = fixture(['https://allowed.example.com']);
    const res = await request(app)
      .post('/api/auth/sso/exchange')
      .set('origin', 'https://evil.example.com')
      .send({ assertion: sign(), embedOrigin: 'https://allowed.example.com' });

    expect(res.status).toBe(403);
  });
});

it('同一張送兩次 → 401 TOKEN_REPLAYED', async () => {
  const { sign } = fixture();
  const assertion = sign();
  expect((await request(app).post('/api/auth/sso/exchange').send({ assertion })).status).toBe(201);

  const again = await request(app).post('/api/auth/sso/exchange').send({ assertion });
  expect(again.status).toBe(401);
  expect(again.body.error).toBe('TOKEN_REPLAYED');
});

it('logout 結束 Session，之後同一個 token 不再通過', async () => {
  const { sign } = fixture();
  const { body } = await request(app).post('/api/auth/sso/exchange').send({ assertion: sign() });
  const token = body.data.sessionToken;

  expect((await request(app).post('/api/auth/logout').auth(token, { type: 'bearer' })).status).toBe(204);
  expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(401);
});

it('撤銷公鑰後，既有 Session 立刻失效（規格 §2.6）', async () => {
  const { tenant, sign } = fixture();
  const { body } = await request(app).post('/api/auth/sso/exchange').send({ assertion: sign() });
  const token = body.data.sessionToken;
  expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(200);

  await request(app)
    .patch(`/api/admin/tenants/${tenant.id}/assertion-keys/${encodeURIComponent(keyPair.kid)}`)
    .set('x-admin-key', 'test-admin-key')
    .send({ status: 'revoked' });

  expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(401);
});
