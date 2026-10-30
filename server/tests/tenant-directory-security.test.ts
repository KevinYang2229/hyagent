import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant, listDeputyCandidates, listUserIds } from '@/modules/user/user.directory';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { guestVisibilityScopesOf } from '@/modules/knowledge/knowledge.visibility';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };

it('external names never inherit default-tenant department, contact details or deputies', () => {
  const t = tenantStore.createTenant('external');
  scopePolicy.setPolicy(t.id, { groups: { 行銷部: ['kb:marketing'] }, accounts: {} });
  expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).not.toContain('kb:marketing');
  expect(getApplicant('kevin', t.id)).toEqual({ id: 'kevin', name: 'kevin', department: '—' });
  expect(listDeputyCandidates({ tenantId: t.id, requesterId: 'kevin' })).toEqual([]);
  expect(listUserIds(t.id)).toEqual([]);
  expect(() => resolveScopes({ tenantId: t.id, userId: '__proto__' })).not.toThrow();
});

it('the same user ID has independent profiles and permissions in each tenant', () => {
  const a = tenantStore.createTenant('A'); const b = tenantStore.createTenant('B');
  tenantStore.updateTenant(a.id, { userDirectory: [{ id: 'shared', name: 'A user', department: '行銷部', email: 'a@example.com', deputyIds: ['deputy'] }, { id: 'deputy', name: 'A deputy', department: '行銷部' }] });
  tenantStore.updateTenant(b.id, { userDirectory: [{ id: 'shared', name: 'B user', department: '資訊部', email: 'b@example.com' }] });
  for (const t of [a, b]) scopePolicy.setPolicy(t.id, { groups: { 行銷部: ['kb:marketing'] }, accounts: {} });
  expect(resolveScopes({ tenantId: a.id, userId: 'shared' })).toContain('kb:marketing');
  expect(resolveScopes({ tenantId: b.id, userId: 'shared' })).not.toContain('kb:marketing');
  expect(getApplicant('shared', b.id).email).toBe('b@example.com');
  expect(listDeputyCandidates({ tenantId: a.id, requesterId: 'shared' }).map((p) => p.name)).toEqual(['A deputy']);
  tenantStore.updateTenant(a.id, { userDirectory: [] });
  expect(resolveScopes({ tenantId: a.id, userId: 'shared' })).not.toContain('kb:marketing');
});

it('directory writes require admin, validate membership, and persist across module reload', async () => {
  const t = tenantStore.createTenant('managed'); const url = `/api/admin/tenants/${t.id}/users`;
  expect((await request(app).put(url).send({ users: [] })).status).toBe(401);
  expect((await request(app).put(url).set(admin).send({ users: [{ id: 'a', name: 'A', deputyIds: ['foreign'] }] })).status).toBe(422);
  const users = [{ id: 'shared', name: 'Tenant user', department: '資訊部', email: 'tenant@example.com' }];
  expect((await request(app).put(url).set(admin).send({ users })).status).toBe(200);
  expect((await request(app).get(url).set(admin)).body.data.users).toEqual(users);
  let restored!: typeof tenantStore;
  jest.isolateModules(() => { restored = require('@/modules/tenant/tenant.store').tenantStore; });
  expect(restored.getTenant(t.id)?.userDirectory).toEqual(users);
  const list = await request(app).get('/api/admin/tenants').set(admin);
  expect(JSON.stringify(list.body)).not.toContain('tenant@example.com');
});

it('anonymous knowledge access cannot inherit an account named after the tenant ID', () => {
  const t = tenantStore.createTenant('guest-collision');
  scopePolicy.setPolicy(t.id, { groups: { '—': ['kb:public'] }, accounts: { [t.id]: ['kb:secret'] } });
  expect(guestVisibilityScopesOf(t.id)).toEqual(['kb:public']);
});

it('admin can append a login account without replacing existing profiles or accepting duplicates', async () => {
  const tenant = tenantStore.createTenant('append-directory');
  tenantStore.updateTenant(tenant.id, { userDirectory: [{ id: 'existing', name: 'Existing', department: 'HR', title: 'Manager', deputyIds: [] }] });
  const path = `/api/admin/tenants/${tenant.id}/users`;
  await request(app).post(path).send({ id: 'hyweb', name: 'Hyweb' }).expect(401);
  await request(app).post(path).set(admin).send({ id: 'hyweb', name: 'Hyweb' }).expect(201);
  const users = tenantStore.getTenant(tenant.id)!.userDirectory!;
  expect(users).toHaveLength(2);
  expect(users[0]).toMatchObject({ id: 'existing', title: 'Manager', deputyIds: [] });
  expect(users[1]).toMatchObject({ id: 'hyweb', department: '—' });
  await request(app).post(path).set(admin).send({ id: 'hyweb', name: 'Overwrite' }).expect(409);
  expect(tenantStore.getTenant(tenant.id)!.userDirectory![1].name).toBe('Hyweb');
});

it('admin can edit a profile in place without touching its id or other fields', async () => {
  const tenant = tenantStore.createTenant('edit-directory');
  tenantStore.updateTenant(tenant.id, { userDirectory: [
    { id: 'amy', name: 'Amy', department: 'HR', title: 'Manager', email: 'amy@example.com', deputyIds: ['bob'] },
    { id: 'bob', name: 'Bob', department: 'HR' },
  ] });
  const path = `/api/admin/tenants/${tenant.id}/users/amy`;
  await request(app).patch(path).send({ name: 'X' }).expect(401);
  const res = await request(app).patch(path).set(admin).send({ name: 'Amy Lin', department: 'Sales', email: null }).expect(200);
  const amy = res.body.data.users.find((u: { id: string }) => u.id === 'amy');
  expect(amy).toEqual({ id: 'amy', name: 'Amy Lin', department: 'Sales', title: 'Manager', deputyIds: ['bob'] });
  expect(getApplicant('amy', tenant.id).department).toBe('Sales');
  await request(app).patch(path).set(admin).send({ id: 'renamed' }).expect(422);
  await request(app).patch(`/api/admin/tenants/${tenant.id}/users/ghost`).set(admin).send({ name: 'G' }).expect(404);
});

it('admin can delete a profile; it is removed from deputy lists and loses login', async () => {
  const tenant = tenantStore.createTenant('delete-directory');
  tenantStore.updateTenant(tenant.id, { userDirectory: [
    { id: 'amy', name: 'Amy', department: 'HR', deputyIds: ['bob'] },
    { id: 'bob', name: 'Bob', department: 'HR' },
  ] });
  const base = `/api/admin/tenants/${tenant.id}/users`;
  await request(app).delete(`${base}/bob`).expect(401);
  const res = await request(app).delete(`${base}/bob`).set(admin).expect(200);
  expect(res.body.data.users).toEqual([{ id: 'amy', name: 'Amy', department: 'HR', deputyIds: [] }]);
  expect(listUserIds(tenant.id)).toEqual(['amy']);
  await request(app).delete(`${base}/bob`).set(admin).expect(404);
});
