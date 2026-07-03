import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

it('GET services 回傳 catalog（含 enabled 狀態）', async () => {
  const t = tenantStore.createTenant('catalog-test');
  tenantStore.updateTenant(t.id, { disabledServices: ['knowledge'] });
  const res = await request(app).get(`/api/admin/tenants/${t.id}/services`).set(auth).expect(200);
  const knowledge = res.body.data.services.find((s: { id: string }) => s.id === 'knowledge');
  expect(knowledge.enabled).toBe(false);
  expect(res.body.data.forms.length).toBeGreaterThan(0);
  expect(res.body.data.forms[0]).toHaveProperty('enabled');
});

it('PATCH tenant 存 disabledForms', async () => {
  const t = tenantStore.createTenant('patch-test');
  await request(app)
    .patch(`/api/admin/tenants/${t.id}`)
    .set(auth)
    .send({ disabledForms: ['business-trip-domestic'] })
    .expect(200);
  expect(tenantStore.getTenant(t.id)?.disabledForms).toEqual(['business-trip-domestic']);
});
