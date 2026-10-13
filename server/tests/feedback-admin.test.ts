import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { auditStore } from '@/modules/audit/audit.store';
import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import { feedbackStore } from '@/modules/feedback/feedback.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const ADMIN_KEY = 'test-admin-key-for-feedback';
const admin = { 'x-admin-key': ADMIN_KEY };
const original = env.ADMIN_API_KEY;
beforeAll(() => { (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = ADMIN_KEY; });
afterAll(() => { (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = original; });
afterEach(() => { feedbackStore.clear(); auditStore.clear(); });

const reply = (id: string): ReplyRecord => ({ id, question: `q-${id}`, answer: `a-${id}`, serviceId: 'knowledge', at: '2026-10-13T00:00:00.000Z' });
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

it('清單：篩選待處理倒讚、每頁預設 10 筆、帶游標翻頁', async () => {
  const t = tenantStore.createTenant('fb-admin-list');
  for (let i = 0; i < 12; i++) feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply(`r${i}`), rating: 'down' });
  feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('up'), rating: 'up' });
  const first = await request(app).get(`/api/admin/tenants/${t.id}/feedback`).query({ rating: 'down', status: 'open' }).set(admin);
  expect(first.status).toBe(200);
  expect(first.body.data.items).toHaveLength(10);
  const next = await request(app).get(`/api/admin/tenants/${t.id}/feedback`)
    .query({ rating: 'down', status: 'open', before: first.body.data.nextCursor }).set(admin);
  expect(next.body.data.items).toHaveLength(2);
  expect(next.body.data.nextCursor).toBeNull();
});

it('統計：days 只接受 7／30／90', async () => {
  const t = tenantStore.createTenant('fb-admin-stats');
  feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'up' });
  const ok = await request(app).get(`/api/admin/tenants/${t.id}/feedback/stats`).query({ days: 7 }).set(admin);
  expect(ok.status).toBe(200);
  expect(ok.body.data).toMatchObject({ days: 7, total: 1, up: 1 });
  expect((await request(app).get(`/api/admin/tenants/${t.id}/feedback/stats`).query({ days: 14 }).set(admin)).status).toBe(422);
});

it('PATCH 更新處理狀態並寫入稽核；跨租戶 404', async () => {
  const t = tenantStore.createTenant('fb-admin-patch');
  const other = tenantStore.createTenant('fb-admin-other');
  const f = feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'down' });
  const res = await request(app).patch(`/api/admin/tenants/${t.id}/feedback/${f.id}`).set(admin)
    .send({ status: 'resolved', resolutionNote: '已補上 2026 年請假規定' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ status: 'resolved', resolutionNote: '已補上 2026 年請假規定' });
  await flush();
  expect(auditStore.list(t.id)[0].summary).toContain(`PATCH /tenants/${t.id}/feedback/${f.id}`);
  expect((await request(app).patch(`/api/admin/tenants/${other.id}/feedback/${f.id}`).set(admin).send({ status: 'open' })).status).toBe(404);
});

it('處理說明超過 200 字 → 422', async () => {
  const t = tenantStore.createTenant('fb-admin-note');
  const f = feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'down' });
  const res = await request(app).patch(`/api/admin/tenants/${t.id}/feedback/${f.id}`).set(admin).send({ status: 'resolved', resolutionNote: 'x'.repeat(201) });
  expect(res.status).toBe(422);
});

it('沒有管理憑證 → 401', async () => {
  const t = tenantStore.createTenant('fb-admin-auth');
  expect((await request(app).get(`/api/admin/tenants/${t.id}/feedback`)).status).toBe(401);
});
