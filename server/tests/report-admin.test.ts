/**
 * 後台報告查詢與下載。
 *
 * 與使用者端下載的關鍵差異：admin 不做建立者比對（管理者本來就要能看別人的報告），
 * 因此每次下載都必須留下稽核軌跡——誰下載了誰的報告。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { auditStore } from '@/modules/audit/audit.store';
import { reportStore } from '@/modules/report/report.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const ADMIN_KEY = process.env.ADMIN_API_KEY as string;

function saveReport(tenantId: string, reportId: string, userId: string, base: string): void {
  for (const format of ['md', 'html']) {
    reportStore.save({
      reportId,
      tenantId,
      userId,
      format,
      filename: `${base}.${format}`,
      content: Buffer.from(`# ${base}`, 'utf8'),
    });
  }
}

beforeEach(() => {
  reportStore._resetForTest();
  auditStore.clear();
});

describe('GET /api/admin/tenants/:id/reports', () => {
  it('列出該租戶的報告，一份一列、多格式收在 files', async () => {
    const t = tenantStore.createTenant('rep-admin-list');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');

    const res = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports`)
      .set('x-admin-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].reportId).toBe('r1');
    expect(res.body.data[0].userId).toBe('kevin');
    expect(res.body.data[0].files.map((f: { format: string }) => f.format).sort()).toEqual([
      'html',
      'md',
    ]);
  });

  it('清單不夾帶報告內容——列表頁不需要 bytes', async () => {
    const t = tenantStore.createTenant('rep-admin-nobytes');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');
    const res = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports`)
      .set('x-admin-key', ADMIN_KEY);
    expect(JSON.stringify(res.body)).not.toContain('content');
  });

  it('keyword 篩選（檔名／使用者）', async () => {
    const t = tenantStore.createTenant('rep-admin-q');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');
    saveReport(t.id, 'r2', 'amy', '請假規定彙整');

    const byName = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports?q=請假`)
      .set('x-admin-key', ADMIN_KEY);
    expect(byName.body.data.map((r: { reportId: string }) => r.reportId)).toEqual(['r2']);

    const byUser = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports?q=kevin`)
      .set('x-admin-key', ADMIN_KEY);
    expect(byUser.body.data.map((r: { reportId: string }) => r.reportId)).toEqual(['r1']);
  });

  it('時間區間篩選', async () => {
    const t = tenantStore.createTenant('rep-admin-range');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');

    const future = new Date(Date.now() + 3600_000).toISOString();
    const res = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports?from=${encodeURIComponent(future)}`)
      .set('x-admin-key', ADMIN_KEY);
    expect(res.body.data).toHaveLength(0);
  });

  it('未帶 admin 金鑰回 401（403 是「管理 API 未啟用」，語意不同）', async () => {
    const t = tenantStore.createTenant('rep-admin-noauth');
    const res = await request(app).get(`/api/admin/tenants/${t.id}/reports`);
    expect(res.status).toBe(401);
  });

  it('租戶不存在回 404', async () => {
    const res = await request(app)
      .get('/api/admin/tenants/no-such-tenant/reports')
      .set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/tenants/:id/reports/:reportId/download', () => {
  it('admin 可下載他人產出的報告，且留下稽核軌跡', async () => {
    const t = tenantStore.createTenant('rep-admin-dl');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');

    const res = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports/r1/download?format=md`)
      .set('x-admin-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/markdown');
    expect(res.header['content-disposition']).toContain("filename*=UTF-8''");

    const audit = auditStore.list(t.id, 10);
    expect(audit).toHaveLength(1);
    expect(audit[0].toolId).toBe('report.download');
    expect(audit[0].ok).toBe(true);
    // 軌跡要看得出「下載了誰的報告」，否則稽核沒有意義
    expect(audit[0].summary).toContain('kevin');
    expect(audit[0].summary).toContain('產品分析報告');
  });

  it('未帶 admin 金鑰回 401，且不留稽核', async () => {
    const t = tenantStore.createTenant('rep-admin-dl-noauth');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');
    const res = await request(app).get(`/api/admin/tenants/${t.id}/reports/r1/download?format=md`);
    expect(res.status).toBe(401);
    expect(auditStore.list(t.id, 10)).toHaveLength(0);
  });

  it('跨租戶不得取得：報告屬於別的租戶時回 404', async () => {
    const owner = tenantStore.createTenant('rep-admin-owner');
    const other = tenantStore.createTenant('rep-admin-other');
    saveReport(owner.id, 'r1', 'kevin', '產品分析報告');

    const res = await request(app)
      .get(`/api/admin/tenants/${other.id}/reports/r1/download?format=md`)
      .set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it('登錄表外的格式回 422', async () => {
    const t = tenantStore.createTenant('rep-admin-badformat');
    saveReport(t.id, 'r1', 'kevin', '產品分析報告');
    const res = await request(app)
      .get(`/api/admin/tenants/${t.id}/reports/r1/download?format=pdf`)
      .set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(422);
  });
});
