import request from 'supertest';
import { createApp } from '@/app';
import { signAccessToken } from '@/utils/jwt';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const auth = { authorization: `Bearer ${signAccessToken({ sub: 'kevin', role: 'employee', via: 'password' })}` };
beforeEach(() => {
  tenantStore.updateTenant('default', { grantedScopes: [] });
  scopePolicy.clear();
});
afterEach(() => scopePolicy.clear());
it('requires authentication', async () => {
  await request(app).get('/api/skills').expect(401);
});
it('uses only authenticated identity and assigned bundles without exposing other roles', async () => {
  scopePolicy.setPolicy('default', {
    groups: {}, accounts: {},
    bundles: [
      { id: 'reader', name: '讀者', scopes: ['service:knowledge'] },
      { id: 'secret', name: '私人角色', scopes: ['service:report'] },
    ],
    accountBundles: { kevin: ['reader'], other: ['secret'] },
  });
  const res = await request(app).get('/api/skills?userId=other&tenantId=other').set(auth).expect(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.data.roles).toEqual([{ id: 'reader', name: '讀者' }]);
  expect(res.body.data.skills.map((s: { id: string }) => s.id)).toEqual(['knowledge']);
  expect(JSON.stringify(res.body)).not.toContain('私人角色');
});
it('reflects revocation immediately and retains independent grants', async () => {
  scopePolicy.setPolicy('default', { groups: {}, accounts: { kevin: ['service:report'] }, bundles: [{ id: 'r', name: '讀者', scopes: ['service:knowledge'] }], accountBundles: { kevin: ['r'] } });
  expect((await request(app).get('/api/skills').set(auth)).body.data.skills).toHaveLength(2);
  scopePolicy.setPolicy('default', { groups: {}, accounts: { kevin: ['service:report'] } });
  const res = await request(app).get('/api/skills').set(auth).expect(200);
  expect(res.body.data.roles).toEqual([]);
  expect(res.body.data.skills.map((s: { id: string }) => s.id)).toEqual(['report']);
});
it('does not display form capability without any authorized form', async () => {
  tenantStore.updateTenant('default', { grantedScopes: ['service:form'] });
  const res = await request(app).get('/api/skills').set(auth).expect(200);
  expect(res.body.data.skills).toEqual([]);
});
it('角色清單包含「所有人」與「所有登入員工」的角色，不含只給網站訪客的角色', async () => {
  scopePolicy.setPolicy('default', {
    groups: {}, accounts: {},
    bundles: [
      { id: 'all', name: '全體人員', scopes: ['service:knowledge'] },
      { id: 'members', name: '通用服務', scopes: ['service:form'] },
      { id: 'guest', name: '網站訪客：問答', scopes: ['service:knowledge'] },
    ],
    groupBundles: { '—': ['guest'] }, accountBundles: {}, tenantBundles: ['all'], memberBundles: ['members'],
  });
  const res = await request(app).get('/api/skills').set(auth).expect(200);
  expect(res.body.data.roles.map((r: { id: string }) => r.id).sort()).toEqual(['all', 'members']);
});
