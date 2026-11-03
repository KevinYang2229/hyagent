/**
 * 開關關閉必須回到開啟前的行為：自動建立的帳號改回使用登入資料、鎖定跟著開關走。
 * 規則見規格 §4「關閉開關」與 §7。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { runWithSsoIdentity } from '@/lib/sso-identity.context';
import { assertionExchange } from '@/modules/auth/assertion-exchange';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';
import { getApplicant, isPasswordLoginUser } from '@/modules/user/user.directory';
import { issueAssertion } from './helpers/assertion-signer';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
const keyPair = generateHyAgentKeyPair('ES256');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ISO = '2026-11-03T00:00:00.000Z';

function tenantWith(userDirectory?: DirectoryEntry[], switches: { ssoAutoProvision?: boolean; directorySyncEnabled?: boolean } = {}) {
  const tenant = tenantStore.createTenant('switch-off fixture', ['*']);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  tenantStore.updateTenant(tenant.id, { ...(userDirectory ? { userDirectory } : {}), ...switches });
  return tenant.id;
}
const identity = (tenantId: string, sub: string, deptName: string, name = '王小明') => ({ tenantId, sub, name, profile: { deptName } });
const asSelf = <T,>(tenantId: string, sub: string, deptName: string, fn: () => T) =>
  runWithSsoIdentity(identity(tenantId, sub, deptName), fn);
const ssoEntry: DirectoryEntry = { id: 'E1', name: '舊名', department: '舊部', email: 'old@example.com', region: '台北', origin: 'sso' };
const usersUrl = (id: string) => `/api/admin/tenants/${id}/users`;
const stored = (id: string) => tenantStore.getTenant(id)!.userDirectory!;

describe('getApplicant', () => {
  it('開關開啟：本人仍讀目錄', () => {
    const id = tenantWith([ssoEntry], { ssoAutoProvision: true });
    asSelf(id, 'E1', '新部', () => expect(getApplicant('E1', id).department).toBe('舊部'));
  });

  it.each([[false], [undefined]])('ssoAutoProvision=%s：本人改用登入資料，不含目錄的 email／region', (flag) => {
    const id = tenantWith([ssoEntry], { ssoAutoProvision: flag });
    asSelf(id, 'E1', '新部', () => {
      expect(getApplicant('E1', id)).toEqual({ id: 'E1', name: '王小明', department: '新部' });
    });
  });

  it('關閉後查別人：仍回目錄項目（登入者的部門不會張冠李戴）', () => {
    const id = tenantWith([ssoEntry]);
    asSelf(id, 'E2', '別的部門', () => {
      expect(getApplicant('E1', id)).toEqual({ id: 'E1', name: '舊名', department: '舊部', email: 'old@example.com', region: '台北' });
    });
  });

  it('關閉後沒有 Session 身分（背景工作）：回目錄項目', () => {
    const id = tenantWith([ssoEntry]);
    expect(getApplicant('E1', id).department).toBe('舊部');
  });

  it('關閉後憑證只帶 sub：回目錄項目', () => {
    const id = tenantWith([ssoEntry]);
    runWithSsoIdentity({ tenantId: id, sub: 'E1' }, () => {
      expect(getApplicant('E1', id).department).toBe('舊部');
    });
  });

  it.each<[string, Partial<DirectoryEntry>]>([
    ['手動', { origin: 'manual' }],
    ['舊資料', { origin: undefined }],
    ['OA 同步', { origin: 'sync', syncedAt: ISO }],
    ['自動建立後被 webhook 接手', { origin: 'sso', syncedAt: ISO }],
  ])('其他來源（%s）關閉後本人仍讀目錄', (_label, over) => {
    const entry = { ...ssoEntry, ...over };
    const id = tenantWith([entry]);
    asSelf(id, 'E1', '新部', () => expect(getApplicant('E1', id).department).toBe('舊部'));
  });

  it('關閉後部門角色跟著登入資料走', () => {
    const id = tenantWith([ssoEntry]);
    scopePolicy.setPolicy(id, { groups: { 舊部: ['old:scope'], 新部: ['new:scope'] }, accounts: {} });
    asSelf(id, 'E1', '新部', () => {
      const scopes = resolveScopes({ tenantId: id, userId: 'E1' });
      expect(scopes).toContain('new:scope');
      expect(scopes).not.toContain('old:scope');
    });
  });

  it('關閉不影響帳密登入資格：仍只看 origin', () => {
    const id = tenantWith([ssoEntry, { id: 'M', name: 'M', department: 'D' }]);
    expect(isPasswordLoginUser('E1', id)).toBe(false);
    expect(isPasswordLoginUser('M', id)).toBe(true);
  });
});

describe('開→關完整流程', () => {
  const profile = (deptName: string) => ({ name: '王小明', 'hyagent:profile': { deptName } });
  const sign = (tenant: string, deptName: string) =>
    issueAssertion({ privateKey: keyPair.privateKeyPem, tenant, subject: 'E1', profile: profile(deptName) });
  const exchange = (assertion: string) => assertionExchange.exchange({ assertion, origin: 'https://any.example.com' });
  const meOf = async (token: string) => (await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).body.data;

  it('憑證換部門、關開關：本人的 /me 回新部門，他人查詢回目錄；PATCH 開時 409、關時可改；再開回去恢復鎖定', async () => {
    const id = tenantWith(undefined, { ssoAutoProvision: true });
    await exchange(sign(id, '舊部'));
    await flush();
    expect(stored(id)).toEqual([expect.objectContaining({ id: 'E1', department: '舊部', origin: 'sso' })]);

    await request(app).patch(`${usersUrl(id)}/E1`).set(admin).send({ name: '手改' }).expect(409);

    tenantStore.updateTenant(id, { ssoAutoProvision: false });
    const { sessionToken } = await exchange(sign(id, '新部'));
    await flush();
    expect(stored(id)[0].department).toBe('舊部'); // 關閉後登入不再刷新目錄
    expect(await meOf(sessionToken)).toMatchObject({ name: '王小明', department: '新部' });
    asSelf(id, 'E9', '別的部門', () => expect(getApplicant('E1', id).department).toBe('舊部'));

    await request(app).patch(`${usersUrl(id)}/E1`).set(admin).send({ name: '手改' }).expect(200);
    expect(stored(id)[0]).toMatchObject({ name: '手改', origin: 'sso' });

    tenantStore.updateTenant(id, { ssoAutoProvision: true });
    await request(app).patch(`${usersUrl(id)}/E1`).set(admin).send({ name: '再改' }).expect(409);
  });
});

describe('後台 PUT／PATCH 的鎖定跟著開關', () => {
  const syncEntry: DirectoryEntry = { id: 'S', name: 'S', department: 'D', origin: 'sync', syncedAt: ISO };

  it('同步帳號：directorySyncEnabled 開時 409，關時可改並保留 origin／syncedAt', async () => {
    const id = tenantWith([syncEntry], { directorySyncEnabled: true });
    await request(app).patch(`${usersUrl(id)}/S`).set(admin).send({ department: 'D2' }).expect(409);
    await request(app).put(usersUrl(id)).set(admin).send({ users: [{ id: 'S', name: 'S2', department: 'D' }] }).expect(409);

    tenantStore.updateTenant(id, { directorySyncEnabled: false });
    await request(app).patch(`${usersUrl(id)}/S`).set(admin).send({ department: 'D2' }).expect(200);
    await request(app).put(usersUrl(id)).set(admin).send({ users: [{ id: 'S', name: 'S2', department: 'D2' }] }).expect(200);
    expect(stored(id)[0]).toEqual({ id: 'S', name: 'S2', department: 'D2', origin: 'sync', syncedAt: ISO });
  });

  it('各自看自己的開關：只開 ssoAutoProvision 時同步帳號可改；只開同步時自動建立帳號可改', async () => {
    const onlySso = tenantWith([syncEntry], { ssoAutoProvision: true });
    await request(app).patch(`${usersUrl(onlySso)}/S`).set(admin).send({ name: 'S2' }).expect(200);
    const onlySync = tenantWith([ssoEntry], { directorySyncEnabled: true });
    await request(app).patch(`${usersUrl(onlySync)}/E1`).set(admin).send({ name: 'E2' }).expect(200);
  });

  it('兩個開關都關的預設租戶：所有帳號都可改', async () => {
    const id = tenantWith([ssoEntry, syncEntry]);
    await request(app).patch(`${usersUrl(id)}/E1`).set(admin).send({ name: 'E2' }).expect(200);
    await request(app).patch(`${usersUrl(id)}/S`).set(admin).send({ name: 'S2' }).expect(200);
  });
});
