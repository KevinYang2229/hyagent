/**
 * 後台登入支援租戶管理者帳號：super（ADMIN_PASSWORD）與租戶管理者共用 /auth/login，
 * 但 token 的 audience 不同，租戶管理者 token 不可通過 verifyAdminToken。
 * 登入限流為每 IP 10 次，本檔登入呼叫總數須維持在上限內。
 */
const ADMIN_PASSWORD = 'super-secret-password';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import { hashPassword } from '@/modules/admin-account/password';
import { signAdminToken, verifyAdminToken, verifyTenantAdminToken, signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
const PW = 'correct-horse-battery';

describe('POST /api/admin/auth/login', () => {
  let activeId = '';

  beforeAll(async () => {
    adminAccountStore.clear();
    const hash = await hashPassword(PW);
    const a = adminAccountStore.create({
      tenantId: 't1', username: 'alice', displayName: '愛麗絲', passwordHash: hash,
      permissions: { knowledge: 'write' },
    });
    activeId = a.id;
    const d = adminAccountStore.create({ tenantId: 't1', username: 'dora', displayName: '朵拉', passwordHash: hash });
    adminAccountStore.update(d.id, { status: 'disabled' });
  });

  const login = (body: Record<string, unknown>) => request(app).post('/api/admin/auth/login').send(body);

  it('沒帶 username 走 ADMIN_PASSWORD，回 super', async () => {
    const res = await login({ password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.me).toEqual({ kind: 'super' });
    expect(verifyAdminToken(res.body.data.token).role).toBe('admin');
  });

  it('username 為 admin（不分大小寫）也走 ADMIN_PASSWORD', async () => {
    const res = await login({ username: 'Admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.me.kind).toBe('super');
  });

  it('租戶管理者用正確密碼登入，me 帶 tenantId 與 permissions，並更新 lastLoginAt', async () => {
    const res = await login({ username: 'ALICE', password: PW });
    expect(res.status).toBe(200);
    expect(res.body.data.me).toEqual({
      kind: 'tenant-admin', accountId: activeId, username: 'alice', displayName: '愛麗絲',
      tenantId: 't1', permissions: { knowledge: 'write' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    const payload = verifyTenantAdminToken(res.body.data.token);
    expect(payload).toMatchObject({ sub: activeId, role: 'tenant-admin', tenantId: 't1', credentialVersion: 0 });
    expect(adminAccountStore.get(activeId)?.lastLoginAt).toBeTruthy();
    // 租戶管理者 token 不能當 super 的 admin token 用（audience 不同）
    expect(() => verifyAdminToken(res.body.data.token)).toThrow();
  });

  it('密碼錯誤、帳號停用、帳號不存在，回 401 且訊息完全相同', async () => {
    const wrong = await login({ username: 'alice', password: 'wrong-password-123' });
    const disabled = await login({ username: 'dora', password: PW });
    const missing = await login({ username: 'nobody', password: PW });
    for (const r of [wrong, disabled, missing]) expect(r.status).toBe(401);
    expect(disabled.body).toEqual(wrong.body);
    expect(missing.body).toEqual(wrong.body);
    expect(wrong.body.error.message).toBe('帳號或密碼錯誤');
  });

  it('super token 不能通過租戶管理者驗證；租戶管理者 token 可往返', () => {
    expect(() => verifyTenantAdminToken(signAdminToken())).toThrow();
    const t = signTenantAdminToken({ accountId: 'x', tenantId: 't1', credentialVersion: 3 });
    expect(verifyTenantAdminToken(t).credentialVersion).toBe(3);
  });

  it('GET /me：super token 與 x-admin-key 都回 super；PUT /me/password 對 super 回 400', async () => {
    const byKey = await request(app).get('/api/admin/me').set('x-admin-key', 'test-admin-key');
    expect(byKey.body).toEqual({ data: { kind: 'super' } });
    const bearer = { Authorization: `Bearer ${signAdminToken()}` };
    expect((await request(app).get('/api/admin/me').set(bearer)).body.data).toEqual({ kind: 'super' });
    const pw = await request(app).put('/api/admin/me/password').set(bearer)
      .send({ currentPassword: 'x', newPassword: 'a-long-enough-password' });
    expect(pw.status).toBe(400);
    const short = await request(app).put('/api/admin/me/password').set(bearer)
      .send({ currentPassword: 'x', newPassword: 'short' });
    expect(short.status).toBe(422);
  });
});
