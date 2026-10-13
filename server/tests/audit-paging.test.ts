/**
 * 稽核分頁（後台無限捲動）：以游標往舊的方向翻頁。
 * 游標是絕對序號而非 offset——捲動途中有新紀錄進來，offset 會整批位移造成重複，游標不會。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { auditStore, type AuditEntry } from '@/modules/audit/audit.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const entry = (summary: string): AuditEntry => ({ toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: true, summary });

afterEach(() => auditStore.clear());

describe('auditStore.listPage', () => {
  it('新→舊，每頁 limit 筆，翻到底 nextCursor 為 null', () => {
    for (let i = 1; i <= 25; i++) auditStore.record('t1', entry(`e${i}`));
    const p1 = auditStore.listPage('t1', { limit: 10 });
    expect(p1.items.map((e) => e.summary)).toEqual(['e25', 'e24', 'e23', 'e22', 'e21', 'e20', 'e19', 'e18', 'e17', 'e16']);
    const p2 = auditStore.listPage('t1', { before: p1.nextCursor!, limit: 10 });
    expect(p2.items[0].summary).toBe('e15');
    const p3 = auditStore.listPage('t1', { before: p2.nextCursor!, limit: 10 });
    expect(p3.items.map((e) => e.summary)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('翻頁途中有新紀錄進來，下一頁不重複也不漏', () => {
    for (let i = 1; i <= 15; i++) auditStore.record('t1', entry(`e${i}`));
    const p1 = auditStore.listPage('t1', { limit: 10 });
    auditStore.record('t1', entry('new'));
    const p2 = auditStore.listPage('t1', { before: p1.nextCursor!, limit: 10 });
    expect(p2.items.map((e) => e.summary)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
  });

  it('沒有紀錄 → 空頁', () => {
    expect(auditStore.listPage('none', { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });
});

describe('稽核 API 分頁', () => {
  const app = createApp();
  const ADMIN_KEY = 'test-admin-key-for-audit-paging';
  const original = env.ADMIN_API_KEY;
  beforeAll(() => {
    (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = ADMIN_KEY;
  });
  afterAll(() => {
    (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = original;
  });

  it('預設每頁 10 筆，帶 before 取下一頁', async () => {
    const t = tenantStore.createTenant('audit-paging');
    for (let i = 1; i <= 12; i++) auditStore.record(t.id, entry(`e${i}`));
    const first = await request(app).get(`/api/admin/tenants/${t.id}/audit`).set('x-admin-key', ADMIN_KEY);
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(10);
    expect(typeof first.body.data.nextCursor).toBe('string');
    const next = await request(app)
      .get(`/api/admin/tenants/${t.id}/audit`)
      .query({ before: first.body.data.nextCursor })
      .set('x-admin-key', ADMIN_KEY);
    expect(next.body.data.items.map((e: AuditEntry) => e.summary)).toEqual(['e2', 'e1']);
    expect(next.body.data.nextCursor).toBeNull();
  });

  it('limit 上限 50，超過回 4xx', async () => {
    const t = tenantStore.createTenant('audit-paging-limit');
    const res = await request(app).get(`/api/admin/tenants/${t.id}/audit`).query({ limit: 500 }).set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
