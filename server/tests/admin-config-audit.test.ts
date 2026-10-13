/**
 * 後台設定變更稽核：管理 API 的每一個有副作用的請求都要留下「誰、何時、改了什麼、成功與否」。
 * 租戶層動作記在該租戶；平台層動作（建立／刪除租戶、MCP 服務）記在平台桶——
 * 刪租戶會級聯清掉該租戶的稽核，記在租戶桶等於刪除的同時銷毀證據。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { PLATFORM_AUDIT_TENANT } from '@/modules/audit/admin-audit';
import { auditStore } from '@/modules/audit/audit.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const ADMIN_KEY = 'test-admin-key-for-config-audit';
const admin = { 'x-admin-key': ADMIN_KEY };
const originalKey = env.ADMIN_API_KEY;

beforeAll(() => {
  (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = ADMIN_KEY;
});
afterAll(() => {
  (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = originalKey;
});
afterEach(() => auditStore.clear());

/** finish 事件在回應送出後才觸發；supertest 收到回應時可能還沒寫進稽核 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('後台設定變更稽核', () => {
  it('租戶層變更記在該租戶：路徑、欄位名、操作者；不記內容', async () => {
    const t = tenantStore.createTenant('cfg-audit-policy');
    const res = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set(admin)
      .send({ grantedScopes: [], groups: { 業務部: ['service:agent'] }, accounts: {} });
    expect(res.status).toBe(200);
    await flush();

    const [entry] = auditStore.list(t.id);
    expect(entry).toMatchObject({ toolId: 'admin.config', userId: 'admin-api-key', ok: true });
    expect(entry.summary).toContain(`PUT /tenants/${t.id}/policy`);
    expect(entry.summary).toContain('groups');
    expect(entry.summary).not.toContain('service:agent');
  });

  it('失敗的變更也記錄，標示狀態碼', async () => {
    const t = tenantStore.createTenant('cfg-audit-fail');
    const res = await request(app).put(`/api/admin/tenants/${t.id}/policy`).set(admin).send({ groups: 'bad' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await flush();
    expect(auditStore.list(t.id)[0]).toMatchObject({ ok: false, error: `HTTP ${res.status}` });
  });

  it('刪除租戶記在平台桶，不隨租戶稽核一起被清掉', async () => {
    const t = tenantStore.createTenant('cfg-audit-delete');
    const res = await request(app).delete(`/api/admin/tenants/${t.id}`).set(admin);
    expect(res.status).toBeLessThan(300);
    await flush();
    expect(auditStore.list(t.id)).toEqual([]);
    expect(auditStore.list(PLATFORM_AUDIT_TENANT)[0].summary).toContain(`DELETE /tenants/${t.id}`);
  });

  it('建立租戶與 MCP 服務等平台層動作記在平台桶，可由 /api/admin/audit 讀取', async () => {
    const res = await request(app).post('/api/admin/tenants').set(admin).send({ name: 'cfg-audit-new' });
    expect(res.status).toBe(201);
    await flush();
    const list = await request(app).get('/api/admin/audit').set(admin);
    expect(list.status).toBe(200);
    expect(list.body.data.items[0].summary).toContain('POST /tenants');
  });

  it('讀取不記錄', async () => {
    const t = tenantStore.createTenant('cfg-audit-read');
    await request(app).get(`/api/admin/tenants/${t.id}/policy`).set(admin);
    await flush();
    expect(auditStore.list(t.id)).toEqual([]);
  });

  it('AI 模型設定已由 service 自行稽核，不重複記一筆', async () => {
    const t = tenantStore.createTenant('cfg-audit-llm');
    await request(app).put(`/api/admin/tenants/${t.id}/llm-config`).set(admin).send({ model: 'claude-sonnet-4-5' });
    await flush();
    const entries = auditStore.list(t.id);
    expect(entries.filter((e) => e.toolId === 'admin.config')).toEqual([]);
  });

  it('未通過管理驗證的請求不寫入租戶稽核', async () => {
    const t = tenantStore.createTenant('cfg-audit-unauth');
    const res = await request(app).put(`/api/admin/tenants/${t.id}/policy`).send({ groups: {}, accounts: {} });
    expect(res.status).toBe(401);
    await flush();
    expect(auditStore.list(t.id)).toEqual([]);
  });
});
