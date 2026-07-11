import { adminController } from '@/modules/admin/admin.controller';
import { auditStore } from '@/modules/audit/audit.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

function mockRes() {
  const res = { statusCode: 0, body: null as unknown, status(n: number) { res.statusCode = n; return res; }, json(b: unknown) { res.body = b; } };
  return res;
}

describe('admin 稽核 API', () => {
  afterEach(() => auditStore.clear());

  it('getAudit 回該租戶稽核（新→舊）', async () => {
    const t = tenantStore.createTenant('admin-audit');
    auditStore.record(t.id, { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: true, summary: 'a' });
    auditStore.record(t.id, { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: false, summary: 'b', error: '權限不足' });
    const res = mockRes();
    await adminController.getAudit({ params: { id: t.id } } as never, res as never);
    const data = (res.body as { data: { summary: string; ok: boolean }[] }).data;
    expect(data.map((e) => e.summary)).toEqual(['b', 'a']);
    expect(data[0].ok).toBe(false);
  });
});
