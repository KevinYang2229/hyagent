/**
 * 租戶管理者的身分辨識與授權：
 *  - requireAdmin 每個請求都從 store 重新載入帳號；停用、刪除、改密碼、重設密碼後舊 token 立即 401
 *  - authorizeAdmin 依分頁權限把關；唯讀帳號呼叫觸發類 POST 一律 403
 *  - 被擋下的嘗試也要寫進該租戶的稽核，操作者記為 tenant-admin:<accountId>
 * 登入限流為每 IP 10 次：本檔只在測「登入換 token」時呼叫 /auth/login，其餘直接簽 token。
 */
const ADMIN_PASSWORD = 'super-secret-password';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import type { AdminAccount } from '@/modules/admin-account/admin-account.types';
import { hashPassword } from '@/modules/admin-account/password';
import {
  DENIED_AUDIT_MAX_PER_WINDOW,
  PLATFORM_AUDIT_TENANT,
  resetDeniedAuditLimiter,
} from '@/modules/audit/admin-audit';
import { auditStore } from '@/modules/audit/audit.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { signAdminToken, signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
const PW = 'correct-horse-battery';

/** finish 事件在回應送出後才觸發；supertest 收到回應時可能還沒寫進稽核 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const bearerOf = (a: AdminAccount): Record<string, string> => ({
  Authorization: `Bearer ${signTenantAdminToken({
    accountId: a.id,
    tenantId: a.tenantId,
    credentialVersion: a.credentialVersion,
  })}`,
});

let hash = '';
let own = '';
let other = '';
let seq = 0;

async function makeAccount(permissions: AdminAccount['permissions']): Promise<AdminAccount> {
  seq += 1;
  return adminAccountStore.create({
    tenantId: own,
    username: `authz-user-${seq}`,
    displayName: `測試 ${seq}`,
    passwordHash: hash,
    permissions,
  });
}

beforeAll(async () => {
  adminAccountStore.clear();
  hash = await hashPassword(PW);
  own = tenantStore.createTenant('authz-own').id;
  other = tenantStore.createTenant('authz-other').id;
});
afterEach(() => {
  auditStore.clear();
  resetDeniedAuditLimiter();
});

describe('authorizeAdmin：依分頁權限把關租戶管理者', () => {
  it('knowledge: read 可讀自己租戶的知識庫；不能觸發 query-test、不能看別的租戶、不能列租戶', async () => {
    adminAccountStore.create({
      tenantId: own, username: 'authz-reader', displayName: '唯讀', passwordHash: hash,
      permissions: { knowledge: 'read' },
    });
    const login = await request(app).post('/api/admin/auth/login').send({ username: 'authz-reader', password: PW });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.token as string}` };

    expect((await request(app).get(`/api/admin/tenants/${own}/knowledge`).set(auth)).status).toBe(200);
    const q = await request(app).post(`/api/admin/tenants/${own}/knowledge/query-test`).set(auth).send({ query: 'x' });
    expect(q.status).toBe(403);
    expect(q.body.error.message).toContain('知識庫');
    expect((await request(app).get(`/api/admin/tenants/${other}/knowledge`).set(auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/tenants').set(auth)).status).toBe(403);
  });

  it('唯讀帳號呼叫觸發類 POST 回 403，且被擋下的嘗試寫進該租戶稽核', async () => {
    const a = await makeAccount({ knowledge: 'read', sso: 'read' });
    const auth = bearerOf(a);
    const paths = [
      `/tenants/${own}/knowledge/query-test`,
      `/tenants/${own}/knowledge/suggestion`,
      `/tenants/${own}/sessions/revoke`,
    ];
    for (const p of paths) {
      const r = await request(app).post(`/api/admin${p}`).set(auth).send({ sub: 'u1', query: 'x' });
      expect(r.status).toBe(403);
    }
    await flush();
    const entries = auditStore.list(own);
    for (const p of paths) {
      const e = entries.find((x) => x.summary.includes(`POST ${p}`));
      expect(e).toMatchObject({ toolId: 'admin.config', ok: false, error: 'HTTP 403', userId: `tenant-admin:${a.id}` });
      expect(e?.summary.startsWith(`帳號 ${a.username}｜`)).toBe(true);
    }
  });

  it('自行記稽核的 PUT llm-config 被擋下時，仍由稽核層補記一筆', async () => {
    const a = await makeAccount({ ai: 'read' });
    const r = await request(app).put(`/api/admin/tenants/${own}/llm-config`).set(bearerOf(a)).send({});
    expect(r.status).toBe(403);
    await flush();
    const e = auditStore.list(own).find((x) => x.summary.includes(`PUT /tenants/${own}/llm-config`));
    expect(e).toMatchObject({ ok: false, error: 'HTTP 403', userId: `tenant-admin:${a.id}` });
  });

  it('ai: write 成功修改 llm-config 時，service 自記的稽核操作者是該租戶管理者', async () => {
    const a = await makeAccount({ ai: 'write' });
    const r = await request(app).put(`/api/admin/tenants/${own}/llm-config`).set(bearerOf(a))
      .send({ model: null });
    expect(r.status).toBe(200);
    await flush();
    const entries = auditStore.list(own);
    expect(entries).toHaveLength(1); // 不重複記
    expect(entries[0]).toMatchObject({ ok: true, userId: `tenant-admin:${a.id}` });
  });

  it('超級管理者 token 與 x-admin-key 照常可列租戶', async () => {
    const bySuper = await request(app).get('/api/admin/tenants').set('Authorization', `Bearer ${signAdminToken()}`);
    expect(bySuper.status).toBe(200);
    const byKey = await request(app).get('/api/admin/tenants').set('x-admin-key', 'test-admin-key');
    expect(byKey.status).toBe(200);
  });

  it('權限改成 {} 之後，下一個請求就回 403', async () => {
    const a = await makeAccount({ knowledge: 'read' });
    const auth = bearerOf(a);
    expect((await request(app).get(`/api/admin/tenants/${own}/knowledge`).set(auth)).status).toBe(200);
    adminAccountStore.update(a.id, { permissions: {} });
    expect((await request(app).get(`/api/admin/tenants/${own}/knowledge`).set(auth)).status).toBe(403);
  });
});

describe('被拒嘗試的稽核：不得寫進別的租戶、每帳號限流', () => {
  it('打別的租戶被拒：該租戶桶沒有新紀錄，改記在平台桶', async () => {
    const a = await makeAccount({});
    const r = await request(app).post(`/api/admin/tenants/${other}/forged-path-text`).set(bearerOf(a)).send({});
    expect(r.status).toBe(403);
    await flush();
    expect(auditStore.list(other)).toEqual([]);
    const e = auditStore.list(PLATFORM_AUDIT_TENANT).find((x) => x.summary.includes(`/tenants/${other}/forged-path-text`));
    expect(e).toMatchObject({ ok: false, error: 'HTTP 403', userId: `tenant-admin:${a.id}` });
  });

  it('URL encode 過的別租戶 id 同樣記平台桶', async () => {
    const a = await makeAccount({});
    const encoded = encodeURIComponent(other).replace(/^./, (c) => `%${c.charCodeAt(0).toString(16)}`);
    const r = await request(app).post(`/api/admin/tenants/${encoded}/knowledge/ingest`).set(bearerOf(a)).send({});
    expect(r.status).toBe(403);
    await flush();
    expect(auditStore.list(other)).toEqual([]);
    expect(auditStore.list(PLATFORM_AUDIT_TENANT).some((x) => x.userId === `tenant-admin:${a.id}`)).toBe(true);
  });

  it('打自己租戶被拒仍記在自己的租戶桶', async () => {
    const a = await makeAccount({});
    await request(app).post(`/api/admin/tenants/${own}/knowledge/ingest`).set(bearerOf(a)).send({});
    await flush();
    expect(auditStore.list(own)[0]).toMatchObject({ ok: false, userId: `tenant-admin:${a.id}` });
    expect(auditStore.list(PLATFORM_AUDIT_TENANT).some((x) => x.userId === `tenant-admin:${a.id}`)).toBe(false);
  });

  it(`同一帳號視窗內被拒超過 ${DENIED_AUDIT_MAX_PER_WINDOW} 次，之後不再寫稽核；別的帳號不受影響`, async () => {
    const a = await makeAccount({});
    const b = await makeAccount({});
    const deny = (acc: AdminAccount) =>
      request(app).post(`/api/admin/tenants/${own}/knowledge/ingest`).set(bearerOf(acc)).send({});
    for (let i = 0; i < DENIED_AUDIT_MAX_PER_WINDOW; i += 1) expect((await deny(a)).status).toBe(403);
    await flush();
    const countOf = (acc: AdminAccount) => auditStore.list(own).filter((x) => x.userId === `tenant-admin:${acc.id}`).length;
    expect(countOf(a)).toBe(DENIED_AUDIT_MAX_PER_WINDOW);

    expect((await deny(a)).status).toBe(403); // 第 31 次仍拒絕，但不記稽核
    await flush();
    expect(countOf(a)).toBe(DENIED_AUDIT_MAX_PER_WINDOW);

    expect((await deny(b)).status).toBe(403);
    await flush();
    expect(countOf(b)).toBe(1);
  });

  it('成功的請求不受被拒限流影響', async () => {
    const a = await makeAccount({ forms: 'write', knowledge: 'read' });
    for (let i = 0; i < DENIED_AUDIT_MAX_PER_WINDOW; i += 1) {
      await request(app).post(`/api/admin/tenants/${own}/knowledge/ingest`).set(bearerOf(a)).send({});
    }
    const ok = await request(app).delete(`/api/admin/tenants/${own}/forms/no-such-form`).set(bearerOf(a));
    expect(ok.status).not.toBe(403);
    await flush();
    const e = auditStore.list(own).find((x) => x.summary.includes(`DELETE /tenants/${own}/forms/no-such-form`));
    expect(e).toBeDefined();
  });
});

describe('requireAdmin：租戶管理者 token 必須對應有效帳號', () => {
  it('GET /me 對租戶管理者回傳 permissions；對超級管理者回 super', async () => {
    const a = await makeAccount({ forms: 'write' });
    const me = await request(app).get('/api/admin/me').set(bearerOf(a));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ kind: 'tenant-admin', accountId: a.id, tenantId: own, permissions: { forms: 'write' } });
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash/);
    const sup = await request(app).get('/api/admin/me').set('Authorization', `Bearer ${signAdminToken()}`);
    expect(sup.body.data).toEqual({ kind: 'super' });
  });

  it('帳號停用後，同一個 token 打 GET /me 回 401', async () => {
    const a = await makeAccount({});
    const auth = bearerOf(a);
    expect((await request(app).get('/api/admin/me').set(auth)).status).toBe(200);
    adminAccountStore.update(a.id, { status: 'disabled', bumpCredential: true });
    expect((await request(app).get('/api/admin/me').set(auth)).status).toBe(401);
  });

  it('只停用（未加 credentialVersion）也回 401', async () => {
    const a = await makeAccount({});
    const auth = bearerOf(a);
    adminAccountStore.update(a.id, { status: 'disabled' });
    expect((await request(app).get('/api/admin/me').set(auth)).status).toBe(401);
  });

  it('帳號刪除後回 401', async () => {
    const a = await makeAccount({});
    const auth = bearerOf(a);
    adminAccountStore.remove(a.id);
    expect((await request(app).get('/api/admin/me').set(auth)).status).toBe(401);
  });

  it('重設密碼（credentialVersion 加 1）後舊 token 回 401', async () => {
    const a = await makeAccount({});
    const auth = bearerOf(a);
    adminAccountStore.update(a.id, { passwordHash: hash, bumpCredential: true });
    expect((await request(app).get('/api/admin/me').set(auth)).status).toBe(401);
  });

  it('token 的 tenantId 與帳號不符回 401', async () => {
    const a = await makeAccount({ knowledge: 'write' });
    const forged = signTenantAdminToken({ accountId: a.id, tenantId: other, credentialVersion: a.credentialVersion });
    expect((await request(app).get('/api/admin/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('PUT /me/password 成功後，舊 token 回 401，新 token 回 200', async () => {
    const a = await makeAccount({});
    const oldAuth = bearerOf(a);
    const res = await request(app).put('/api/admin/me/password').set(oldAuth)
      .send({ currentPassword: PW, newPassword: 'another-long-password' });
    expect(res.status).toBe(200);
    const newToken = res.body.data.token as string;
    expect((await request(app).get('/api/admin/me').set(oldAuth)).status).toBe(401);
    expect((await request(app).get('/api/admin/me').set('Authorization', `Bearer ${newToken}`)).status).toBe(200);
  });

  it('PUT /me/password 目前密碼錯誤回 401', async () => {
    const a = await makeAccount({});
    const res = await request(app).put('/api/admin/me/password').set(bearerOf(a))
      .send({ currentPassword: 'wrong-password-xx', newPassword: 'another-long-password' });
    expect(res.status).toBe(401);
  });
});
