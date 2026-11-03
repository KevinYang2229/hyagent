/**
 * 同步端點有自己的速率限制，用完不影響登入換發。
 * 上限須在載入 env 之前設定，所以 app 以 require 延後載入。
 */
process.env.DIRECTORY_SYNC_RATE_LIMIT_MAX = '3';

import request from 'supertest';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { issueAssertion } from './helpers/assertion-signer';

it('同步觸發 429（扁平格式、含 Retry-After）時，/api/auth/sso/exchange 仍可用', async () => {
  const { createApp } = require('@/app') as typeof import('@/app');
  const { tenantStore } = require('@/modules/tenant/tenant.store') as typeof import('@/modules/tenant/tenant.store');
  const app = createApp();
  const pair = generateHyAgentKeyPair('ES256');
  const t = tenantStore.createTenant('rate fixture', ['*']);
  tenantStore.addPublicKey(t.id, { publicKey: pair.publicKeyPem });

  let last = await request(app).post('/api/directory-sync/events').send('{}');
  for (let i = 0; i < 3; i += 1) last = await request(app).post('/api/directory-sync/events').send('{}');
  expect(last.status).toBe(429);
  expect(last.body).toMatchObject({ error: 'RATE_LIMITED', message: expect.any(String), requestId: expect.any(String) });
  expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);

  const assertion = issueAssertion({ privateKey: pair.privateKeyPem, tenant: t.id, subject: '507' });
  const ok = await request(app).post('/api/auth/sso/exchange').send({ assertion });
  expect(ok.status).toBe(201);
});
