/**
 * 後台 Session 列表與作廢的 HTTP 契約。
 *
 * auth-session-store.test.ts 測的是儲存層；這支測端點本身：管理金鑰把關、查詢參數的
 * 驗證與預設值、跨租戶防護，以及回應形狀——後台要看得到 `sub` 原文（才知道是誰），
 * 但 `subHash` / `subEnc` 這些內部欄位不得外流。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { authSessionStore } from '@/lib/auth-session.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const KEY = 'test-admin-key';

function fixture() {
  const tenant = tenantStore.createTenant(`sessions-endpoint-${Date.now()}-${Math.random()}`);
  const login = (over: { sub?: string; name?: string; kid?: string } = {}) =>
    authSessionStore.create({
      tenantId: tenant.id,
      sub: '507',
      kid: 'kid-1',
      expiresInSeconds: 3600,
      ...over,
    });
  const list = (qs = '') =>
    request(app).get(`/api/admin/tenants/${tenant.id}/sessions${qs}`).set('x-admin-key', KEY);
  return { tenant, login, list };
}

it('未帶管理金鑰時 401', async () => {
  const { tenant } = fixture();
  await request(app).get(`/api/admin/tenants/${tenant.id}/sessions`).expect(401);
});

it('列出有效 Session，帶 sub 原文供後台顯示，但不外流 subHash / subEnc', async () => {
  const { login, list } = fixture();
  await login({ sub: 'employee-507', name: '羅玉瑩' });

  const res = await list();

  expect(res.status).toBe(200);
  expect(res.body.data.total).toBe(1);
  expect(res.body.data.sessions[0]).toMatchObject({
    sub: 'employee-507',
    name: '羅玉瑩',
    kid: 'kid-1',
  });
  expect(JSON.stringify(res.body)).not.toContain('subHash');
  expect(JSON.stringify(res.body)).not.toContain('subEnc');
});

it('query 搜尋沿用儲存層的兩路聯集：完整 sub 或 name 關鍵字', async () => {
  const { login, list } = fixture();
  await login({ sub: 'employee-507', name: '羅玉瑩' });
  await login({ sub: 'employee-508', name: '陳小明' });

  await expect(list('?query=employee-507')).resolves.toMatchObject({
    body: { data: { total: 1 } },
  });
  await expect(list('?query=小明')).resolves.toMatchObject({ body: { data: { total: 1 } } });
  // 半截 sub 搜不到——儲存層只有 HMAC，做不了前綴比對
  await expect(list('?query=employee')).resolves.toMatchObject({ body: { data: { total: 0 } } });
});

it('kid 可篩選，供撤銷公鑰前評估影響範圍', async () => {
  const { login, list } = fixture();
  await login({ sub: 'a', kid: 'kid-old' });
  await login({ sub: 'b', kid: 'kid-new' });

  const res = await list('?kid=kid-old');

  expect(res.body.data.sessions.map((s: { sub: string }) => s.sub)).toEqual(['a']);
});

it('limit 超過上限被擋下，不讓人一次撈整個租戶', async () => {
  const { list } = fixture();
  await expect(list('?limit=500')).resolves.toMatchObject({ status: 422 });
});

it('不存在的租戶回 404', async () => {
  await request(app).get('/api/admin/tenants/no-such-tenant/sessions').set('x-admin-key', KEY).expect(404);
});

it('DELETE 作廢單筆，列表隨即少一筆', async () => {
  const { tenant, login, list } = fixture();
  const target = await login({ sub: '507' });
  await login({ sub: '508' });

  const res = await request(app)
    .delete(`/api/admin/tenants/${tenant.id}/sessions/${target.session.id}`)
    .set('x-admin-key', KEY);

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ revoked: 1 });
  await expect(authSessionStore.get(target.sessionToken)).resolves.toBeUndefined();
  await expect(list()).resolves.toMatchObject({ body: { data: { total: 1 } } });
});

it('DELETE 已失效的 id 回 404——通常代表它剛過期或被別人踢掉了', async () => {
  const { tenant } = fixture();
  await request(app)
    .delete(`/api/admin/tenants/${tenant.id}/sessions/no-such-session`)
    .set('x-admin-key', KEY)
    .expect(404);
});

it('DELETE 不跨租戶：在 A 租戶的路徑下拿 B 租戶的 id 不會得逞', async () => {
  const a = fixture();
  const b = fixture();
  const theirs = await b.login({ sub: '507' });

  await request(app)
    .delete(`/api/admin/tenants/${a.tenant.id}/sessions/${theirs.session.id}`)
    .set('x-admin-key', KEY)
    .expect(404);

  await expect(authSessionStore.get(theirs.sessionToken)).resolves.toBeDefined();
});
