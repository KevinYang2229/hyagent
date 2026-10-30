/** 權限頁改為只有角色：舊直接授權換算成角色後，有效權限必須完全不變。 */
import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes, resolveGuestScopes } from '@/modules/authz/resolve-scopes';
import { toRoleView } from '@/modules/authz/role-view';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };

const USERS = [
  { id: 'amy', name: 'Amy', department: '人資' },
  { id: 'bob', name: 'Bob', department: '人資' },
  { id: 'cat', name: 'Cat', department: '業務' },
  { id: 'dan', name: 'Dan', department: '—' },
];
// 不在目錄的帳號（例如 SSO 使用者）也可能有帳號層授權
const PRINCIPALS = [...USERS.map((u) => u.id), 'sso-only'];

function seedLegacy(name: string) {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, {
    userDirectory: USERS,
    knowledgeLabels: [{ id: 'hr', label: '人資文件' }],
    grantedScopes: ['service:form', 'form:leave-request', 'service:knowledge'],
  });
  scopePolicy.setPolicy(t.id, {
    groups: { 人資: ['service:report', 'kb:hr', 'service:form'], 業務: ['service:report'], '—': ['kb:hr'] },
    accounts: { amy: ['service:agent', 'email:write'], cat: ['service:agent'], 'sso-only': ['service:agent', 'email:write'] },
    bundles: [{ id: 'emp', name: '員工', scopes: ['calendar:read'] }],
    groupBundles: { 業務: ['emp'] },
    accountBundles: { dan: ['emp'] },
  });
  return t;
}

function snapshot(tenantId: string) {
  const sorted = (xs: string[]) => [...xs].sort();
  return {
    guest: sorted(resolveGuestScopes(tenantId)),
    ...Object.fromEntries(PRINCIPALS.map((id) => [id, sorted(resolveScopes({ tenantId, userId: id }))])),
  };
}

it('讀取時換算成角色，直接授權欄位回空，且資料庫尚未變動', async () => {
  const t = seedLegacy('role-view-read');
  const before = scopePolicy.getPolicy(t.id);
  const res = await request(app).get(`/api/admin/tenants/${t.id}/policy`).set(admin).expect(200);
  const view = res.body.data;
  expect(view.grantedScopes).toEqual([]);
  expect(view.groups).toEqual({});
  expect(view.accounts).toEqual({});
  expect(view.convertedRoleIds.length).toBeGreaterThan(0);
  const everyone = view.bundles.find((b: { name: string }) => b.name === '全體人員');
  expect(everyone.scopes.sort()).toEqual(['form:leave-request', 'service:form', 'service:knowledge']);
  expect(view.tenantBundles).toContain(everyone.id);
  // 只讀不寫
  expect(scopePolicy.getPolicy(t.id)).toEqual(before);
  expect(tenantStore.getTenant(t.id)!.grantedScopes).toEqual(['service:form', 'form:leave-request', 'service:knowledge']);
});

it('換算後存檔，每位使用者、SSO 帳號與訪客的有效權限完全不變', async () => {
  const t = seedLegacy('role-view-equivalence');
  const before = snapshot(t.id);
  const view = (await request(app).get(`/api/admin/tenants/${t.id}/policy`).set(admin).expect(200)).body.data;
  await request(app).put(`/api/admin/tenants/${t.id}/policy`).set(admin).send({
    grantedScopes: view.grantedScopes, groups: view.groups, accounts: view.accounts,
    bundles: view.bundles, groupBundles: view.groupBundles, accountBundles: view.accountBundles, tenantBundles: view.tenantBundles,
  }).expect(200);
  expect(snapshot(t.id)).toEqual(before);
  expect(tenantStore.getTenant(t.id)!.grantedScopes).toEqual([]);
  expect(scopePolicy.getPolicy(t.id).groups).toEqual({});
  // 存檔後再讀：已無需換算，角色與 id 穩定
  const again = (await request(app).get(`/api/admin/tenants/${t.id}/policy`).set(admin).expect(200)).body.data;
  expect(again.convertedRoleIds).toEqual([]);
  expect(again.bundles.map((b: { id: string }) => b.id)).toEqual(view.bundles.map((b: { id: string }) => b.id));
});

it('相同對象的直接授權合併成一個角色，id 每次讀取都相同', () => {
  const direct = { grantedScopes: [], groups: {}, accounts: { a: ['x', 'y'], b: ['x', 'y'], c: ['x'] } };
  const roles = { bundles: [], groupBundles: {}, accountBundles: {}, tenantBundles: [] };
  const labels = { department: (d: string) => d, account: (u: string) => u };
  const v1 = toRoleView(direct, roles, labels);
  const v2 = toRoleView(direct, roles, labels);
  expect(v1.bundles.map((b) => b.id)).toEqual(v2.bundles.map((b) => b.id));
  // x 給 a、b、c；y 給 a、b → 兩個角色
  expect(v1.bundles).toHaveLength(2);
  expect(v1.accountBundles.c).toHaveLength(1);
  expect(v1.accountBundles.a).toHaveLength(2);
});

it('套用給所有人的角色對使用者與訪客生效；含知識庫標籤或外部服務時拒絕', async () => {
  const t = tenantStore.createTenant('role-view-everyone');
  tenantStore.updateTenant(t.id, { userDirectory: USERS, knowledgeLabels: [{ id: 'hr', label: '人資文件' }], grantedScopes: [] });
  const base = { grantedScopes: [], groups: {}, accounts: {}, groupBundles: {}, accountBundles: {} };
  await request(app).put(`/api/admin/tenants/${t.id}/policy`).set(admin).send({
    ...base, bundles: [{ id: 'all', name: '全體', scopes: ['service:knowledge'] }], tenantBundles: ['all'],
  }).expect(200);
  expect(resolveGuestScopes(t.id)).toContain('service:knowledge');
  expect(resolveScopes({ tenantId: t.id, userId: 'cat' })).toContain('service:knowledge');

  const res = await request(app).put(`/api/admin/tenants/${t.id}/policy`).set(admin).send({
    ...base, bundles: [{ id: 'all', name: '全體', scopes: ['service:knowledge', 'kb:hr'] }], tenantBundles: ['all'],
  }).expect(400);
  expect(JSON.stringify(res.body)).toContain('不可套用給所有人');
  await request(app).put(`/api/admin/tenants/${t.id}/policy`).set(admin).send({
    ...base, bundles: [], tenantBundles: ['ghost'],
  }).expect(400);
});
