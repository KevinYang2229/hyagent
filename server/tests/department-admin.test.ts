import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { getApplicant } from '@/modules/user/user.directory';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };

function seed(name: string) {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, { userDirectory: [
    { id: 'amy', name: 'Amy', department: '人資' },
    { id: 'bob', name: 'Bob', department: '人資' },
    { id: 'cat', name: 'Cat', department: '業務' },
  ] });
  scopePolicy.setPolicy(t.id, {
    groups: { 人資: ['service:form'], 業務: ['service:knowledge'], 舊部門: ['service:report'] },
    accounts: {},
    bundles: [{ id: 'b1', name: '員工', scopes: ['service:form'] }],
    groupBundles: { 人資: ['b1'], 舊部門: ['b1'] },
    accountBundles: {},
  });
  return { t, base: `/api/admin/tenants/${t.id}/departments` };
}

it('lists departments with members and grants, including orphaned ones that still hold grants', async () => {
  const { base } = seed('dept-list');
  await request(app).get(base).expect(401);
  const res = await request(app).get(base).set(admin).expect(200);
  expect(res.body.data.departments).toEqual([
    { name: '人資', members: 2, directGrants: 1, roles: 1 },
    { name: '業務', members: 1, directGrants: 1, roles: 0 },
    { name: '舊部門', members: 0, directGrants: 1, roles: 1 },
  ]);
});

it('rename moves members and grants to the new name, merging when the target exists', async () => {
  const { t, base } = seed('dept-rename');
  await request(app).patch(`${base}/${encodeURIComponent('人資')}`).set(admin).send({ name: '人力資源' }).expect(200);
  expect(getApplicant('amy', t.id).department).toBe('人力資源');
  let policy = scopePolicy.getPolicy(t.id);
  expect(policy.groups).not.toHaveProperty('人資');
  expect(policy.groups['人力資源']).toEqual(['service:form']);
  expect(policy.groupBundles!['人力資源']).toEqual(['b1']);

  await request(app).patch(`${base}/${encodeURIComponent('業務')}`).set(admin).send({ name: '人力資源' }).expect(200);
  policy = scopePolicy.getPolicy(t.id);
  expect(policy.groups['人力資源'].sort()).toEqual(['service:form', 'service:knowledge']);
  expect(getApplicant('cat', t.id).department).toBe('人力資源');
});

it('the guest bucket cannot be renamed, deleted, or used as a rename target', async () => {
  const { base } = seed('dept-guest');
  await request(app).patch(`${base}/${encodeURIComponent('—')}`).set(admin).send({ name: 'X' }).expect(400);
  await request(app).patch(`${base}/${encodeURIComponent('人資')}`).set(admin).send({ name: '—' }).expect(400);
  await request(app).delete(`${base}/${encodeURIComponent('—')}`).set(admin).expect(400);
  await request(app).patch(`${base}/${encodeURIComponent('不存在')}`).set(admin).send({ name: 'X' }).expect(404);
});

it('delete is refused while members remain, and clears grants once empty', async () => {
  const { t, base } = seed('dept-delete');
  await request(app).delete(`${base}/${encodeURIComponent('人資')}`).set(admin).expect(409);
  await request(app).delete(`${base}/${encodeURIComponent('舊部門')}`).set(admin).expect(200);
  const policy = scopePolicy.getPolicy(t.id);
  expect(policy.groups).not.toHaveProperty('舊部門');
  expect(policy.groupBundles).not.toHaveProperty('舊部門');
  expect(policy.groups['人資']).toEqual(['service:form']);
  await request(app).delete(`${base}/${encodeURIComponent('舊部門')}`).set(admin).expect(404);
});
