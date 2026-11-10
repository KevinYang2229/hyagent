/**
 * 帳號管理 API（/api/admin/tenants/:id/admin-accounts）：只限超級管理者。
 */
process.env.ADMIN_PASSWORD = 'super-secret-password';

import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import { hashPassword } from '@/modules/admin-account/password';
import { auditStore } from '@/modules/audit/audit.store';
import { resetDeniedAuditLimiter } from '@/modules/audit/admin-audit';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { signAdminToken, signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const SUPER = { Authorization: `Bearer ${signAdminToken()}` };
const PW = 'a-long-enough-password';

let tid = '';
let otherTid = '';
const base = () => `/api/admin/tenants/${tid}/admin-accounts`;

beforeEach(() => {
  adminAccountStore.clear();
  auditStore.clear();
  resetDeniedAuditLimiter();
});
beforeAll(() => {
  tid = tenantStore.createTenant('acct-api-own').id;
  otherTid = tenantStore.createTenant('acct-api-other').id;
});

const create = (body: Record<string, unknown> = {}) =>
  request(app).post(base()).set(SUPER).send({ username: 'alice01', displayName: '愛麗絲', password: PW, ...body });

describe('帳號管理 API', () => {
  it('超級管理者可建立、列出、修改、重設密碼、刪除，且不回 passwordHash', async () => {
    const c = await create();
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ username: 'alice01', tenantId: tid, status: 'active', permissions: {} });
    const id = c.body.data.id as string;

    const l = await request(app).get(base()).set(SUPER);
    expect(l.status).toBe(200);
    expect(l.body.data).toHaveLength(1);

    const p = await request(app).patch(`${base()}/${id}`).set(SUPER).send({ permissions: { users: 'write' }, status: 'disabled', displayName: '改名' });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ permissions: { users: 'write' }, status: 'disabled', displayName: '改名' });

    const r = await request(app).put(`${base()}/${id}/password`).set(SUPER).send({ password: 'another-long-password' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id });

    const d = await request(app).delete(`${base()}/${id}`).set(SUPER);
    expect(d.status).toBe(200);
    expect(d.body.data).toEqual({ id });

    for (const res of [c, l, p, r, d]) expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|credentialVersion/);
  });

  it('租戶管理者打這組 API，即使是自己的租戶也 403', async () => {
    const acc = adminAccountStore.create({ tenantId: tid, username: 'tadmin01', displayName: 'T', passwordHash: await hashPassword(PW), permissions: { users: 'write' } });
    const h = { Authorization: `Bearer ${signTenantAdminToken({ accountId: acc.id, tenantId: tid, credentialVersion: acc.credentialVersion })}` };
    expect((await request(app).get(base()).set(h)).status).toBe(403);
    expect((await request(app).post(base()).set(h).send({ username: 'bob0001', displayName: 'b', password: PW })).status).toBe(403);
    expect((await request(app).delete(`${base()}/${acc.id}`).set(h)).status).toBe(403);
  });

  it('驗證：保留帳號 422、重複 409、不認得的權限 key 422、格式與長度', async () => {
    expect((await create({ username: 'admin' })).status).toBe(422);
    expect((await create({ username: 'ADMIN' })).status).toBe(422);
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
    expect((await create({ username: 'Alice01' })).status).toBe(409);
    expect((await create({ username: 'a b' })).status).toBe(422);
    expect((await create({ username: 'bob0001', password: 'short' })).status).toBe(422);
    expect((await create({ username: 'bob0001', password: 'x'.repeat(129) })).status).toBe(422);
    expect((await create({ username: 'bob0001', displayName: '' })).status).toBe(422);
    expect((await create({ username: 'bob0001', displayName: 'x'.repeat(51) })).status).toBe(422);
    const id = adminAccountStore.getByUsername('alice01')!.id;
    const bad = await request(app).patch(`${base()}/${id}`).set(SUPER).send({ permissions: { database: 'read' } });
    expect(bad.status).toBe(422);
    expect((await request(app).patch(`${base()}/${id}`).set(SUPER).send({ permissions: { users: 'admin' } })).status).toBe(422);
  });

  it('租戶不存在或帳號屬於別的租戶時 404', async () => {
    const c = await create();
    const id = c.body.data.id as string;
    const wrong = `/api/admin/tenants/${otherTid}/admin-accounts`;
    expect((await request(app).patch(`${wrong}/${id}`).set(SUPER).send({ displayName: 'x' })).status).toBe(404);
    expect((await request(app).put(`${wrong}/${id}/password`).set(SUPER).send({ password: PW })).status).toBe(404);
    expect((await request(app).delete(`${wrong}/${id}`).set(SUPER)).status).toBe(404);
    expect(adminAccountStore.get(id)).toBeDefined();
    expect((await request(app).get('/api/admin/tenants/nope/admin-accounts').set(SUPER)).status).toBe(404);
    expect((await request(app).post('/api/admin/tenants/nope/admin-accounts').set(SUPER).send({ username: 'bob0001', displayName: 'b', password: PW })).status).toBe(404);
  });

  it('重設密碼後該帳號的舊 token 回 401', async () => {
    const c = await create({ permissions: undefined });
    const acc = adminAccountStore.get(c.body.data.id as string)!;
    const h = { Authorization: `Bearer ${signTenantAdminToken({ accountId: acc.id, tenantId: tid, credentialVersion: acc.credentialVersion })}` };
    expect((await request(app).get('/api/admin/me').set(h)).status).toBe(200);
    await request(app).put(`${base()}/${acc.id}/password`).set(SUPER).send({ password: 'another-long-password' }).expect(200);
    expect((await request(app).get('/api/admin/me').set(h)).status).toBe(401);
  });

  it('稽核 summary 只有欄位名稱，沒有密碼的值', async () => {
    await create({ password: 'super-unique-pw-value' });
    await flush();
    const entries = auditStore.list(tid);
    const e = entries.find((x) => x.summary.includes(`POST /tenants/${tid}/admin-accounts`));
    expect(e).toBeDefined();
    expect(e!.summary).toContain('password');
    expect(JSON.stringify(entries)).not.toContain('super-unique-pw-value');
  });
});
