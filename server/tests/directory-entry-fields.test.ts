import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { authService } from '@/modules/auth/auth.service';
import { validateIdentity } from '@/modules/auth/credential-version';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';
import { getApplicant, isFieldLocked, isPasswordLoginUser } from '@/modules/user/user.directory';
import { verifyAccessToken } from '@/utils/jwt';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
const ISO = '2026-11-03T00:00:00.000Z';

type Switches = { ssoAutoProvision?: boolean; directorySyncEnabled?: boolean };
function tenantWith(name: string, userDirectory: DirectoryEntry[], switches: Switches = {}) {
  const tenant = tenantStore.createTenant(name);
  tenantStore.updateTenant(tenant.id, { userDirectory, ...switches });
  return tenant;
}
const usersUrl = (id: string) => `/api/admin/tenants/${id}/users`;
const stored = (id: string) => tenantStore.getTenant(id)!.userDirectory!;

it('getApplicant 不回傳內部欄位', () => {
  const tenant = tenantWith('fields-applicant', [{ id: 'a', name: 'A', department: 'D', origin: 'sync', syncedAt: ISO }]);
  expect(getApplicant('a', tenant.id)).toEqual({ id: 'a', name: 'A', department: 'D' });
});

describe('isFieldLocked：鎖定跟著負責的開關走', () => {
  const base = { id: 'a', name: 'A', department: 'D' };
  const on = { ssoAutoProvision: true, directorySyncEnabled: true };
  const off = { ssoAutoProvision: false, directorySyncEnabled: false };

  it('手動帳號永遠不鎖', () => {
    expect(isFieldLocked(base, on)).toBe(false);
    expect(isFieldLocked({ ...base, origin: 'manual' }, on)).toBe(false);
  });

  it('origin=sso 且沒有 syncedAt：只看 ssoAutoProvision', () => {
    const entry = { ...base, origin: 'sso' as const };
    expect(isFieldLocked(entry, { ssoAutoProvision: true })).toBe(true);
    expect(isFieldLocked(entry, { directorySyncEnabled: true })).toBe(false);
    expect(isFieldLocked(entry, off)).toBe(false);
    expect(isFieldLocked(entry, {})).toBe(false);
  });

  it.each([
    ['origin=sync', { origin: 'sync' as const }],
    ['manual 被 webhook 接手', { origin: 'manual' as const, syncedAt: ISO }],
    ['sso 被 webhook 接手', { origin: 'sso' as const, syncedAt: ISO }],
    ['舊資料被 webhook 接手', { syncedAt: ISO }],
  ])('%s：只看 directorySyncEnabled', (_label, over) => {
    const entry = { ...base, ...over };
    expect(isFieldLocked(entry, { directorySyncEnabled: true })).toBe(true);
    expect(isFieldLocked(entry, { ssoAutoProvision: true })).toBe(false);
    expect(isFieldLocked(entry, off)).toBe(false);
  });
});

describe('帳密登入資格', () => {
  it.each(['sso', 'sync'] as const)('origin=%s 不能帳密登入', async (origin) => {
    const tenant = tenantWith(`fields-login-${origin}`, [{ id: 'a', name: 'A', department: 'D', origin }]);
    expect(isPasswordLoginUser('a', tenant.id)).toBe(false);
    expect(() => authService.login('a', env.AUTH_DEV_PASSWORD, tenant.id)).toThrow('帳號或密碼錯誤');
  });

  it('已簽發的 token 在帳號變成 sso 後，refresh 與身分驗證都失效', async () => {
    const tenant = tenantWith('fields-login-revoke', [{ id: 'a', name: 'A', department: 'D' }]);
    const tokens = authService.login('a', env.AUTH_DEV_PASSWORD, tenant.id);
    await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).resolves.toBeUndefined();
    tenantStore.updateTenant(tenant.id, { userDirectory: [{ id: 'a', name: 'A', department: 'D', origin: 'sso' }] });
    await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
    await expect(authService.refresh(tokens.refreshToken)).rejects.toThrow();
  });

  it('沒有 origin 的舊資料仍可帳密登入', () => {
    const tenant = tenantWith('fields-login-legacy', [{ id: 'a', name: 'A', department: 'D' }]);
    expect(authService.login('a', env.AUTH_DEV_PASSWORD, tenant.id).user.id).toBe('a');
  });

  it('webhook 接手的 manual 帳號仍可帳密登入', () => {
    const tenant = tenantWith('fields-login-manual', [{ id: 'a', name: 'A', department: 'D', origin: 'manual', syncedAt: ISO }]);
    expect(authService.login('a', env.AUTH_DEV_PASSWORD, tenant.id).user).toEqual({ id: 'a', name: 'A', department: 'D' });
  });
});

describe('後台目錄 API', () => {
  it('PATCH 鎖定帳號回 409 DIRECTORY_FIELD_MANAGED，未動資料', async () => {
    const tenant = tenantWith('fields-patch-locked', [{ id: 'a', name: 'A', department: 'D', origin: 'sso' }], { ssoAutoProvision: true });
    const res = await request(app).patch(`${usersUrl(tenant.id)}/a`).set(admin).send({ name: 'B' }).expect(409);
    expect(res.body.error.code).toBe('DIRECTORY_FIELD_MANAGED');
    expect(stored(tenant.id)[0].name).toBe('A');
  });

  it('PATCH 鎖定帳號但值沒變則放行，並保留 origin', async () => {
    const tenant = tenantWith('fields-patch-same', [{ id: 'a', name: 'A', department: 'D', origin: 'sync', syncedAt: ISO }], { directorySyncEnabled: true });
    await request(app).patch(`${usersUrl(tenant.id)}/a`).set(admin).send({ name: 'A' }).expect(200);
    expect(stored(tenant.id)[0]).toMatchObject({ origin: 'sync', syncedAt: ISO });
  });

  it('PATCH／DELETE 其他人時，保留他人的 origin 與 syncedAt', async () => {
    const tenant = tenantWith('fields-others', [
      { id: 'a', name: 'A', department: 'D' },
      { id: 'b', name: 'B', department: 'D', origin: 'sync', syncedAt: ISO, deputyIds: ['c'] },
      { id: 'c', name: 'C', department: 'D', origin: 'sso' },
    ]);
    await request(app).patch(`${usersUrl(tenant.id)}/a`).set(admin).send({ name: 'A2' }).expect(200);
    expect(stored(tenant.id).find((u) => u.id === 'b')).toMatchObject({ origin: 'sync', syncedAt: ISO });
    await request(app).delete(`${usersUrl(tenant.id)}/a`).set(admin).expect(200);
    expect(stored(tenant.id).find((u) => u.id === 'b')).toMatchObject({ origin: 'sync', syncedAt: ISO });
    expect(stored(tenant.id).find((u) => u.id === 'c')).toMatchObject({ origin: 'sso' });
  });

  it('POST 帶 origin 無效，新帳號視為手動', async () => {
    const tenant = tenantWith('fields-post', []);
    const res = await request(app).post(usersUrl(tenant.id)).set(admin)
      .send({ id: 'n', name: 'N', origin: 'sync', syncedAt: ISO }).expect(201);
    expect(res.body.data.users[0].origin).toBeUndefined();
    expect(res.body.data.users[0].syncedAt).toBeUndefined();
    expect(isPasswordLoginUser('n', tenant.id)).toBe(true);
  });

  it('POST 到已有鎖定帳號的目錄不會因重新驗證而失敗', async () => {
    const tenant = tenantWith('fields-post-existing', [{ id: 'a', name: 'A', department: 'D', origin: 'sso', syncedAt: ISO }]);
    const res = await request(app).post(usersUrl(tenant.id)).set(admin).send({ id: 'n', name: 'N' }).expect(201);
    expect(res.body.data.users[0]).toMatchObject({ origin: 'sso', syncedAt: ISO });
  });

  it('PUT 依 id 保留既有 origin、syncedAt，輸入值被忽略', async () => {
    const tenant = tenantWith('fields-put', [
      { id: 'a', name: 'A', department: 'D', origin: 'sync', syncedAt: ISO },
      { id: 'b', name: 'B', department: 'D' },
    ]);
    await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [
      { id: 'a', name: 'A', department: 'D', origin: 'manual', syncedAt: '2000-01-01T00:00:00.000Z' },
      { id: 'b', name: 'B', department: 'D', origin: 'sso', syncedAt: ISO },
      { id: 'c', name: 'C', origin: 'sync' },
    ] }).expect(200);
    const users = stored(tenant.id);
    expect(users.find((u) => u.id === 'a')).toMatchObject({ origin: 'sync', syncedAt: ISO });
    expect(users.find((u) => u.id === 'b')?.origin).toBeUndefined();
    expect(users.find((u) => u.id === 'b')?.syncedAt).toBeUndefined();
    expect(users.find((u) => u.id === 'c')?.origin).toBeUndefined();
  });

  it('PUT 改鎖定帳號的姓名或部門回 409，且整批不寫入', async () => {
    const tenant = tenantWith('fields-put-locked', [
      { id: 'a', name: 'A', department: 'D', origin: 'sso' },
      { id: 'b', name: 'B', department: 'D' },
    ], { ssoAutoProvision: true });
    for (const change of [{ name: 'A2', department: 'D' }, { name: 'A', department: 'D2' }]) {
      const res = await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [
        { id: 'a', ...change }, { id: 'b', name: 'B2', department: 'D' },
      ] }).expect(409);
      expect(res.body.error.code).toBe('DIRECTORY_FIELD_MANAGED');
    }
    expect(stored(tenant.id).map((u) => u.name)).toEqual(['A', 'B']);
  });

  it('PUT 省略或改動鎖定帳號的 email／title／company 回 409，不可藉省略清除', async () => {
    const full = { id: 'a', name: 'A', department: 'D', email: 'a@example.com', title: 'T', company: 'C' };
    const tenant = tenantWith('fields-put-omit', [{ ...full, origin: 'sync' }], { directorySyncEnabled: true });
    const attempts = [
      { id: 'a', name: 'A', department: 'D', title: 'T', company: 'C' },
      { id: 'a', name: 'A', department: 'D', email: 'a@example.com', company: 'C' },
      { id: 'a', name: 'A', department: 'D', email: 'a@example.com', title: 'T' },
      { ...full, title: 'T2' },
    ];
    for (const user of attempts) {
      const res = await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [user] }).expect(409);
      expect(res.body.error.code).toBe('DIRECTORY_FIELD_MANAGED');
    }
    await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [full] }).expect(200);
    expect(stored(tenant.id)[0]).toMatchObject({ ...full, origin: 'sync' });
  });

  it('PATCH 以 email: null 清除鎖定帳號的 email 回 409', async () => {
    const tenant = tenantWith('fields-patch-null', [{ id: 'a', name: 'A', department: 'D', email: 'a@example.com', origin: 'sso' }], { ssoAutoProvision: true });
    await request(app).patch(`${usersUrl(tenant.id)}/a`).set(admin).send({ email: null }).expect(409);
    expect(stored(tenant.id)[0].email).toBe('a@example.com');
  });

  it('PUT 重複 id 或代理人不存在回 422 且不寫入（與改動前相同的驗證錯誤碼）', async () => {
    const tenant = tenantWith('fields-put-invalid', [{ id: 'a', name: 'A', department: 'D' }]);
    await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [
      { id: 'x', name: 'X' }, { id: 'x', name: 'Y' },
    ] }).expect(422);
    await request(app).put(usersUrl(tenant.id)).set(admin).send({ users: [
      { id: 'x', name: 'X', deputyIds: ['nobody'] },
    ] }).expect(422);
    expect(stored(tenant.id).map((u) => u.id)).toEqual(['a']);
  });

  it('後台租戶檢視與 /api/tenant 回應不含 directoryTombstones、directorySyncKeys', async () => {
    const tenant = tenantStore.createTenant('fields-redact');
    tenantStore.updateTenant(tenant.id, {
      ssoAutoProvision: true,
      directorySyncEnabled: true,
      directoryTombstones: { gone: ISO },
      directorySyncStatus: { at: ISO, applied: 1, stale: 0, rejected: 0 },
    });
    // directorySyncKeys 無 updateTenant 通道（之後由專屬流程寫入），測試直接放進 store 物件
    tenantStore.getTenant(tenant.id)!.directorySyncKeys = [
      { kid: 'k1', alg: 'ES256', publicKey: 'PEM', status: 'active', createdAt: ISO },
    ];
    const list = await request(app).get('/api/admin/tenants').set(admin).expect(200);
    const view = list.body.data.find((t: { id: string }) => t.id === tenant.id);
    expect(view).toMatchObject({ ssoAutoProvision: true, directorySyncEnabled: true });
    expect(view).not.toHaveProperty('directoryTombstones');
    expect(view).not.toHaveProperty('directorySyncKeys');
    expect(JSON.stringify(list.body)).not.toContain('gone');

    // /api/tenant 只有 llm-config 端點，回應是白名單欄位
    const key = tenantStore.createApiKey(tenant.id, 'secret').key;
    const self = await request(app).get('/api/tenant/llm-config').set('x-api-key', key).expect(200);
    const text = JSON.stringify(self.body);
    expect(text).not.toContain('directoryTombstones');
    expect(text).not.toContain('directorySyncKeys');
    expect(text).not.toContain('gone');
  });
});
