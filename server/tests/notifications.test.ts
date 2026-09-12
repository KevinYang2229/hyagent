import request from 'supertest';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { createApp } from '@/app';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { reportStore } from '@/modules/report/report.store';
import { submissionStore } from '@/modules/workflow/submission.store';
import { signAccessToken } from '@/utils/jwt';
import { listNotifications } from '@/modules/notifications/notifications.service';
import { readReceipts, markReceipts } from '@/modules/notifications/notification-reads';

const app = createApp();
const auth = { authorization: `Bearer ${signAccessToken({ sub: 'kevin', role: 'employee', via: 'password' })}` };
function draft(userId = 'kevin', tenantId = 'default') {
  const session = conversationStore.create(tenantId, userId, 'leave-request');
  session.activeServiceId = 'form';
  session.status = 'confirming';
  session.values = { reason: 'sensitive-reason' };
  conversationStore.save(session);
  return session;
}
beforeEach(() => {
  tenantStore.updateTenant('default', { grantedScopes: ['service:form', 'form:leave-request'] });
  conversationStore.purgeTenant('default');
  conversationStore.purgeTenant('other');
  submissionStore.clear();
  reportStore._resetForTest();
});
it('requires authentication and isolates notifications despite forged identity filters', async () => {
  expect((await request(app).get('/api/notifications').set('x-user-id', 'kevin')).status).toBe(401);
  const mine = draft();
  const other = draft('someone-else');
  const tenant = draft('kevin', 'other');
  const response = await request(app).get('/api/notifications?userId=someone-else').set(auth).set('x-user-id', 'someone-else').expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data.items).toHaveLength(1);
  expect(response.body.data.items[0]).toMatchObject({ kind: 'confirming', read: false, target: { conversationId: mine.id } });
  expect(JSON.stringify(response.body)).not.toMatch(new RegExp(`sensitive-reason|${other.id}|${tenant.id}`));
});
it('persists read state and rejects receipts for another user or nonexistent notification', async () => {
  draft();
  draft('someone-else');
  const mine = (await listNotifications('default', 'kevin')).items[0];
  const other = (await listNotifications('default', 'someone-else')).items[0];
  await request(app).post('/api/notifications/read').set(auth).send({ ids: [other.id] }).expect(404);
  await request(app).post('/api/notifications/read').set(auth).send({ ids: ['invalid'] }).expect(422);
  await request(app).post('/api/notifications/read').set(auth).send({ ids: [mine.id] }).expect(200);
  expect((await listNotifications('default', 'kevin')).unreadCount).toBe(0);
  expect((await readReceipts('default', 'kevin')).has(mine.id)).toBe(true);
  expect((await listNotifications('default', 'someone-else')).unreadCount).toBe(1);
  await request(app).post('/api/notifications/read').set(auth).send({ ids: [mine.id] }).expect(200);
});
it('removes resolved reminders and emits a distinct unread submission result', async () => {
  const s = draft();
  const initial = (await listNotifications('default', 'kevin')).items[0];
  await markReceipts('default', 'kevin', [initial.id]);
  s.status = 'submitted';
  s.submission = { oaRequestId: 'NOTIFY-REQ', submittedAt: new Date().toISOString() } as NonNullable<typeof s.submission>;
  conversationStore.save(s);
  const feed = await listNotifications('default', 'kevin');
  expect(feed.items).toHaveLength(1);
  expect(feed.items[0]).toMatchObject({ kind: 'submitted', read: false });
  expect(feed.items[0].id).not.toBe(initial.id);
});
it('only reminds about collecting drafts after 24 hours and hides cancelled tasks', async () => {
  const s = draft();
  s.status = 'collecting';
  s.updatedAt = new Date().toISOString();
  expect((await listNotifications('default', 'kevin')).items).toHaveLength(0);
  s.updatedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  expect((await listNotifications('default', 'kevin')).items[0].kind).toBe('draft');
  s.status = 'cancelled';
  expect((await listNotifications('default', 'kevin')).items).toHaveLength(0);
});
it('includes available report results only for their owner', async () => {
  for (const userId of ['kevin', 'someone-else']) reportStore.save({ reportId: `report-${userId}`, tenantId: 'default', userId, format: 'md', filename: 'summary.md', content: Buffer.from('private-report-body') });
  const feed = await listNotifications('default', 'kevin');
  expect(feed.items).toHaveLength(1);
  expect(feed.items[0]).toMatchObject({ kind: 'report_done', target: { category: 'reports', id: 'report-kevin' } });
  expect(JSON.stringify(feed)).not.toContain('private-report-body');
});
it('receipt keys do not collide across tenants or users and concurrent marks merge', async () => {
  await Promise.all([markReceipts('receipt-tenant', 'one', ['first']), markReceipts('receipt-tenant', 'one', ['second'])]);
  expect(await readReceipts('receipt-tenant', 'one')).toEqual(new Set(['first', 'second']));
  expect(await readReceipts('receipt-tenant', 'two')).toEqual(new Set());
  expect(await readReceipts('another-tenant', 'one')).toEqual(new Set());
});
