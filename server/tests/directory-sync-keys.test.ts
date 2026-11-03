/**
 * 同步專用金鑰：與登入金鑰分開登記、互斥，撤銷不影響登入與 Session。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
const pairA = generateHyAgentKeyPair('RS256');
const pairB = generateHyAgentKeyPair('ES256');
const pairC = generateHyAgentKeyPair('ES256');

function newTenant() {
  return tenantStore.createTenant('sync keys fixture', ['*']);
}
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  throw new Error('預期要被拒絕，但通過了');
}

describe('store：同步金鑰', () => {
  it('貼上私鑰被拒絕', () => {
    const t = newTenant();
    expect(codeOf(() => tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.privateKeyPem }))).toBe(
      'INVALID_REQUEST',
    );
    expect(tenantStore.listDirectorySyncKeys(t.id)).toEqual([]);
  });

  it('可登記並列出；重複上傳冪等', () => {
    const t = newTenant();
    const first = tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem, label: 'oa' }, { via: 'admin' })!;
    expect(first.created).toBe(true);
    expect(first.key).toMatchObject({ kid: pairA.kid, status: 'active', label: 'oa', createdBy: { via: 'admin' } });
    const again = tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem })!;
    expect(again).toEqual({ key: first.key, created: false });
    expect(tenantStore.listDirectorySyncKeys(t.id)).toHaveLength(1);
  });

  it('最多 2 把啟用中', () => {
    const t = newTenant();
    tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem });
    tenantStore.addDirectorySyncKey(t.id, { publicKey: pairB.publicKeyPem });
    expect(codeOf(() => tenantStore.addDirectorySyncKey(t.id, { publicKey: pairC.publicKeyPem }))).toBe(
      'KEY_LIMIT_EXCEEDED',
    );
  });

  it('公鑰已是登入金鑰時，不能登記為同步金鑰', () => {
    const t = newTenant();
    tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem });
    expect(codeOf(() => tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem }))).toBe(
      'INVALID_REQUEST',
    );
    expect(tenantStore.listDirectorySyncKeys(t.id)).toEqual([]);
  });

  it('已撤銷的登入金鑰同樣不能改登記為同步金鑰', () => {
    const t = newTenant();
    tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem });
    tenantStore.revokePublicKey(t.id, pairA.kid, 'compromised');
    expect(codeOf(() => tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem }))).toBe(
      'INVALID_REQUEST',
    );
  });

  it('公鑰已是同步金鑰時，不能登記為登入金鑰', () => {
    const t = newTenant();
    tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem });
    expect(codeOf(() => tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem }))).toBe('INVALID_REQUEST');
    expect(tenantStore.listPublicKeys(t.id)).toEqual([]);
  });

  it('可以撤銷最後一把同步金鑰（即使原因是 rotated）', () => {
    const t = newTenant();
    tenantStore.addDirectorySyncKey(t.id, { publicKey: pairA.publicKeyPem });
    const revoked = tenantStore.revokeDirectorySyncKey(t.id, pairA.kid, 'rotated', { via: 'admin-api-key' })!;
    expect(revoked).toMatchObject({ status: 'revoked', revokedReason: 'rotated', revokedBy: { via: 'admin-api-key' } });
    expect(revoked.revokedAt).toBeTruthy();
  });

  it('撤銷不存在的 kid 回 undefined', () => {
    const t = newTenant();
    expect(tenantStore.revokeDirectorySyncKey(t.id, 'nope', 'other')).toBeUndefined();
  });

  it('撤銷同步金鑰後，登入金鑰與該租戶 Session 都不變', async () => {
    const t = newTenant();
    tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem });
    tenantStore.addDirectorySyncKey(t.id, { publicKey: pairB.publicKeyPem });
    const loginBefore = tenantStore.listPublicKeys(t.id);
    const { sessionToken: token } = await authSessionStore.create({
      tenantId: t.id,
      sub: 'external-user',
      kid: pairA.kid,
      expiresInSeconds: 600,
    });

    tenantStore.revokeDirectorySyncKey(t.id, pairB.kid, 'compromised');

    expect(tenantStore.listPublicKeys(t.id)).toEqual(loginBefore);
    expect(await authSessionStore.get(token)).toMatchObject({ tenantId: t.id, kid: pairA.kid });
  });

  it('沒有同步金鑰的租戶，addPublicKey 行為與原本相同', () => {
    const t = newTenant();
    const r = tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem })!;
    expect(r.created).toBe(true);
    expect(tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem })).toEqual({ key: r.key, created: false });
    expect(tenantStore.listDirectorySyncKeys(t.id)).toEqual([]);
  });
});

describe('後台 API', () => {
  it('需要管理員權限', async () => {
    const t = newTenant();
    await request(app).get(`/api/admin/tenants/${t.id}/directory-sync`).expect(401);
    await request(app).post(`/api/admin/tenants/${t.id}/directory-sync/keys`).send({ publicKey: pairA.publicKeyPem }).expect(401);
  });

  it('租戶不存在回 404', async () => {
    await request(app).get('/api/admin/tenants/no-such/directory-sync').set(admin).expect(404);
  });

  it('開關更新後 GET 反映新值', async () => {
    const t = newTenant();
    const base = `/api/admin/tenants/${t.id}/directory-sync`;
    const before = await request(app).get(base).set(admin).expect(200);
    expect(before.body.data).toMatchObject({ ssoAutoProvision: false, directorySyncEnabled: false, keys: [] });

    const patched = await request(app)
      .patch(base)
      .set(admin)
      .send({ directorySyncEnabled: true, ssoAutoProvision: true })
      .expect(200);
    expect(patched.body.data).toMatchObject({ ssoAutoProvision: true, directorySyncEnabled: true });
    const after = await request(app).get(base).set(admin).expect(200);
    expect(after.body.data).toMatchObject({ ssoAutoProvision: true, directorySyncEnabled: true });

    await request(app).patch(base).set(admin).send({ directorySyncEnabled: 'yes' }).expect(422);
  });

  it('上傳、重複上傳、撤銷、錯誤情境', async () => {
    const t = newTenant();
    const base = `/api/admin/tenants/${t.id}/directory-sync`;
    const up = await request(app).post(`${base}/keys`).set(admin).send({ publicKey: pairA.publicKeyPem, label: 'oa' }).expect(201);
    expect(up.body.data).toMatchObject({ created: true, key: { kid: pairA.kid, status: 'active' } });
    expect(up.body.data.key.createdBy.via).toBe('admin-api-key');
    const dup = await request(app).post(`${base}/keys`).set(admin).send({ publicKey: pairA.publicKeyPem }).expect(200);
    expect(dup.body.data.created).toBe(false);

    await request(app).post(`${base}/keys`).set(admin).send({ publicKey: pairB.privateKeyPem }).expect(400);

    const got = await request(app).get(base).set(admin).expect(200);
    expect(got.body.data.keys).toHaveLength(1);
    expect(JSON.stringify(got.body)).not.toContain('PRIVATE');

    await request(app).post(`${base}/keys/${pairA.kid}/revoke`).set(admin).send({ reason: 'bogus' }).expect(422);
    await request(app).post(`${base}/keys/nope/revoke`).set(admin).send({ reason: 'other' }).expect(404);
    const rev = await request(app).post(`${base}/keys/${pairA.kid}/revoke`).set(admin).send({ reason: 'rotated' }).expect(200);
    expect(rev.body.data.key).toMatchObject({ kid: pairA.kid, status: 'revoked', revokedReason: 'rotated' });
    await request(app).post(`${base}/keys/${pairA.kid}/revoke`).set(admin).send({ reason: 'other' }).expect(400);
  });

  it('登入金鑰與同步金鑰互斥（API 層）', async () => {
    const t = newTenant();
    tenantStore.addPublicKey(t.id, { publicKey: pairA.publicKeyPem });
    const res = await request(app)
      .post(`/api/admin/tenants/${t.id}/directory-sync/keys`)
      .set(admin)
      .send({ publicKey: pairA.publicKeyPem })
      .expect(400);
    expect(res.body.error?.message ?? JSON.stringify(res.body)).toContain('此公鑰已登記於另一用途');
  });
});
