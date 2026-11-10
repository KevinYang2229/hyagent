/**
 * 租戶管理者檢視的回應內容：單一租戶 API、機密欄位遮罩、他人稽核來源 IP 遮蔽。
 */
process.env.ADMIN_PASSWORD = 'super-secret-password';

import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import type { AdminAccount } from '@/modules/admin-account/admin-account.types';
import { auditStore } from '@/modules/audit/audit.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { signAdminToken, signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
const SECRET = 'whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789MIDDLEPART9876';
const MIDDLE = 'MNOPQRSTUVWXYZ0123456789MIDDLE';

let tenantId = '';
let account: AdminAccount;

const bearer = (a: AdminAccount): Record<string, string> => ({
  Authorization: `Bearer ${signTenantAdminToken({
    accountId: a.id,
    tenantId: a.tenantId,
    credentialVersion: a.credentialVersion,
  })}`,
});
const superBearer = (): Record<string, string> => ({ Authorization: `Bearer ${signAdminToken()}` });

beforeAll(() => {
  adminAccountStore.clear();
  tenantId = tenantStore.createTenant('views-own').id;
  account = adminAccountStore.create({
    tenantId,
    username: 'views-user',
    displayName: '檢視',
    passwordHash: 'x',
    permissions: { audit: 'read', webhook: 'read', settings: 'read', ai: 'read', directorySync: 'read', sso: 'read' },
  });
  tenantStore.updateTenant(tenantId, { llmConfig: { provider: 'anthropic', anthropicApiKey: 'sk-ant-api03-PLAINTEXTSECRETVALUE-zzzz' } } as never);
});
beforeEach(() => {
  auditStore.clear();
});

describe('租戶管理者檢視', () => {
  it('audit：他人紀錄拿掉來源 IP，自己的保留；超級管理者不受影響', async () => {
    const mine = `tenant-admin:${account.id}`;
    const at = new Date().toISOString();
    auditStore.record(tenantId, { toolId: 't.a', userId: 'admin', at, ok: true, summary: '改設定｜來源 1.2.3.4｜備註' });
    auditStore.record(tenantId, { toolId: 't.b', userId: mine, at, ok: true, summary: '我改的｜來源 5.6.7.8' });
    auditStore.record(tenantId, { toolId: 't.c', userId: 'tenant-admin:other', at, ok: true, summary: '別人｜來源 9.9.9.9' });

    const t = await request(app).get(`/api/admin/tenants/${tenantId}/audit`).set(bearer(account));
    expect(t.status).toBe(200);
    const items = t.body.data.items as Array<{ userId: string; summary: string }>;
    const byUser = (u: string) => items.find((i) => i.userId === u)!;
    expect(byUser('admin').summary).toBe('改設定｜備註');
    expect(byUser('tenant-admin:other').summary).toBe('別人');
    expect(byUser(mine).summary).toContain('來源 5.6.7.8');

    const s = await request(app).get(`/api/admin/tenants/${tenantId}/audit`).set(superBearer());
    const sItems = s.body.data.items as Array<{ userId: string; summary: string }>;
    expect(sItems.find((i) => i.userId === 'admin')!.summary).toContain('來源 1.2.3.4');
  });

  it('webhook 列表遮罩 secret（含超級管理者）；建立時仍回完整 secret', async () => {
    const created = await request(app)
      .post(`/api/admin/tenants/${tenantId}/webhooks`)
      .set(superBearer())
      .send({ url: 'https://hook.example.com/x', secret: SECRET });
    expect(created.status).toBe(201);
    expect(created.body.data.secret).toBe(SECRET);

    for (const h of [bearer(account), superBearer()]) {
      const res = await request(app).get(`/api/admin/tenants/${tenantId}/webhooks`).set(h);
      expect(res.status).toBe(200);
      const w = (res.body.data as Array<{ secret: string }>)[0]!;
      expect(w.secret).not.toBe(SECRET);
      expect(w.secret).not.toContain(MIDDLE);
    }
    webhookStore.purgeTenant(tenantId);
  });

  it('GET /tenants/:id：自己的租戶 200 且不含 llmConfig / directorySyncKeys；別的租戶 403；不存在 404', async () => {
    const res = await request(app).get(`/api/admin/tenants/${tenantId}`).set(bearer(account));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tenantId);
    expect(res.body.data).not.toHaveProperty('llmConfig');
    expect(res.body.data).not.toHaveProperty('directorySyncKeys');

    const otherId = tenantStore.createTenant('views-other').id;
    expect((await request(app).get(`/api/admin/tenants/${otherId}`).set(bearer(account))).status).toBe(403);
    expect((await request(app).get('/api/admin/tenants/no-such-tenant').set(superBearer())).status).toBe(404);
  });

  it('directory-sync / llm-config / assertion-keys 的 GET 沒有明文金鑰', async () => {
    for (const p of ['directory-sync', 'llm-config', 'assertion-keys']) {
      const res = await request(app).get(`/api/admin/tenants/${tenantId}/${p}`).set(bearer(account));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('PLAINTEXTSECRETVALUE');
      expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY/);
    }
  });
});
