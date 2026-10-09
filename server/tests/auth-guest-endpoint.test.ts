/**
 * `POST /api/auth/guest`：免登入訪客 Session（見 modules/auth/guest-session.ts）。
 *
 * 守的是三件事：租戶沒開就拿不到、拿到的身分只有訪客權限、租戶關掉後既有 Session 立即失效。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { resolveGuestScopes, resolveScopes } from '@/modules/authz/resolve-scopes';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

function fixture(guestAccess?: boolean) {
  const tenant = tenantStore.createTenant('guest fixture', ['*']);
  if (guestAccess !== undefined) tenantStore.updateTenant(tenant.id, { guestAccess });
  const key = tenantStore.createApiKey(tenant.id, 'publishable').key;
  return { tenant, key };
}

it('租戶未開啟訪客使用 → 403 GUEST_ACCESS_DISABLED', async () => {
  const { key } = fixture();
  const res = await request(app).post('/api/auth/guest').set('x-api-key', key);

  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('GUEST_ACCESS_DISABLED');
});

it('開啟後回 201 與 hyas_ Session，可直接呼叫受保護端點', async () => {
  const { key } = fixture(true);
  const res = await request(app).post('/api/auth/guest').set('x-api-key', key);

  expect(res.status).toBe(201);
  expect(res.body.data.sessionToken).toMatch(/^hyas_/);
  expect(res.body.data).toMatchObject({ expiresIn: expect.any(Number), user: { sub: expect.stringMatching(/^guest_[0-9a-f]{32}$/), name: '訪客' } });

  const me = await request(app).get('/api/auth/me').set('x-api-key', key).auth(res.body.data.sessionToken, { type: 'bearer' });
  expect(me.status).toBe(200);
  expect(me.body.data).toMatchObject({ name: '訪客', department: '—' });
});

it('每次換發都是新的訪客身分，呼叫端無法指定 sub', async () => {
  const { key } = fixture(true);
  const a = await request(app).post('/api/auth/guest').set('x-api-key', key).send({ sub: 'admin' });
  const b = await request(app).post('/api/auth/guest').set('x-api-key', key);

  expect(a.body.data.user.sub).not.toBe('admin');
  expect(a.body.data.user.sub).not.toBe(b.body.data.user.sub);
});

it('訪客的權限等同訪客部門，不多不少', async () => {
  const { tenant, key } = fixture(true);
  const res = await request(app).post('/api/auth/guest').set('x-api-key', key);
  const sub = res.body.data.user.sub as string;

  expect(resolveScopes({ tenantId: tenant.id, userId: sub }).sort()).toEqual(resolveGuestScopes(tenant.id).sort());
});

it('租戶關閉訪客使用後，既有訪客 Session 在下一個請求就失效', async () => {
  const { tenant, key } = fixture(true);
  const res = await request(app).post('/api/auth/guest').set('x-api-key', key);
  const token = res.body.data.sessionToken as string;

  tenantStore.updateTenant(tenant.id, { guestAccess: false });
  const me = await request(app).get('/api/auth/me').set('x-api-key', key).auth(token, { type: 'bearer' });
  expect(me.status).toBe(401);
});

it('訪客 Session 不能拿去別的租戶用', async () => {
  const mine = fixture(true);
  const other = fixture(true);
  const res = await request(app).post('/api/auth/guest').set('x-api-key', mine.key);
  const token = res.body.data.sessionToken as string;

  // 掛 resolveTenant 的受保護端點才比對租戶（/api/auth/me 沒有掛，與帳密 token 相同）
  const own = await request(app).get('/api/notifications').set('x-api-key', mine.key).auth(token, { type: 'bearer' });
  const cross = await request(app).get('/api/notifications').set('x-api-key', other.key).auth(token, { type: 'bearer' });
  expect(own.status).toBe(200);
  expect(cross.status).toBe(401);
});
