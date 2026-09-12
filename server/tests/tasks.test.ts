import request from 'supertest';
import { createApp } from '@/app';
import { conversationStore, sessionFromRow, sessionToRow } from '@/modules/conversation/conversation.store';
import { reportStore } from '@/modules/report/report.store';
import { submissionStore } from '@/modules/workflow/submission.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { startReportJob, _resetJobsForTest } from '@/modules/report/report.job';
import { signAccessToken } from '@/utils/jwt';
import type { SessionStatus } from '@hyagent/shared';

const app = createApp();
const token = signAccessToken({ sub: 'kevin', role: 'employee' });
const auth = { authorization: `Bearer ${token}` };

function draft(userId = 'kevin', tenantId = 'default', status: SessionStatus = 'collecting') {
  const s = conversationStore.create(tenantId, userId, 'leave-request');
  s.activeServiceId = 'form';
  s.status = status;
  s.values = { applicant: 'Kevin', reason: 'private form content' };
  s.messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'secret', name: 'internal', input: {} }] }];
  conversationStore.save(s);
  return s;
}

beforeEach(() => {
  _resetJobsForTest();
  tenantStore.updateTenant('default', { grantedScopes: ['service:form', 'form:leave-request'] });
  conversationStore.purgeTenant('default');
  conversationStore.purgeTenant('other');
  reportStore._resetForTest();
  submissionStore.clear();
});

it('requires a verified identity, ignoring forged user headers and query filters', async () => {
  expect((await request(app).get('/api/tasks').set('x-user-id', 'kevin')).status).toBe(401);
  const mine = draft();
  draft('another-user');
  draft('kevin', 'other');
  const res = await request(app).get('/api/tasks?userId=another-user').set(auth).set('x-user-id', 'another-user');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.data.drafts.map((d: { id: string }) => d.id)).toEqual([mine.id]);
  expect(JSON.stringify(res.body)).not.toContain('private form content');
  expect(JSON.stringify(res.body)).not.toContain('tool_use');
});

it('does not mistake knowledge/report conversations or cancelled forms for drafts', async () => {
  const mine = draft();
  const knowledge = draft();
  delete knowledge.activeServiceId;
  draft('kevin', 'default', 'cancelled');
  draft('kevin', 'default', 'submitted');
  const res = await request(app).get('/api/tasks').set(auth);
  expect(res.body.data.drafts.map((d: { id: string }) => d.id)).toEqual([mine.id]);
});

it('restores saved values without returning model messages; updates survive serialization', async () => {
  const s = draft('kevin', 'default', 'confirming');
  const res = await request(app).get(`/api/tasks/${s.id}`).set(auth);
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ id: s.id, status: 'confirming', values: s.values });
  expect(res.body.data.messages).toBeUndefined();
  expect(sessionFromRow(sessionToRow(s))).toMatchObject({ updatedAt: s.updatedAt, values: s.values });
});

it('returns 404 for another user or tenant and rejects malformed task IDs', async () => {
  const otherUser = draft('another-user');
  const otherTenant = draft('kevin', 'other');
  for (const s of [otherUser, otherTenant]) {
    expect((await request(app).get(`/api/tasks/${s.id}`).set(auth)).status).toBe(404);
    expect((await request(app).post(`/api/tasks/${s.id}/cancel`).set(auth)).status).toBe(404);
    expect(s.status).toBe('collecting');
  }
  expect((await request(app).get('/api/tasks/invalid').set(auth)).status).toBe(422);
});

it('rejects a token issued for a different tenant', async () => {
  const wrongTenant = signAccessToken({ sub: 'kevin', role: 'employee', via: 'sso', tenantId: 'other' });
  expect((await request(app).get('/api/tasks').set('authorization', `Bearer ${wrongTenant}`)).status).toBe(401);
});

it('rechecks current form permissions before restoring or cancelling', async () => {
  const s = draft();
  s.formId = 'not-granted';
  const list = await request(app).get('/api/tasks').set(auth);
  expect(list.body.data.drafts[0]).toMatchObject({ canResume: false, canCancel: false });
  expect((await request(app).get(`/api/tasks/${s.id}`).set(auth)).status).toBe(403);
  expect((await request(app).post(`/api/tasks/${s.id}/cancel`).set(auth)).status).toBe(403);
});

it('cancels unfinished forms but never submitted or currently submitting forms', async () => {
  const s = draft();
  expect((await request(app).post(`/api/tasks/${s.id}/cancel`).set(auth)).status).toBe(200);
  expect(s.status).toBe('cancelled');
  for (const status of ['submitted', 'submitting'] as const) {
    const locked = draft('kevin', 'default', status);
    expect((await request(app).post(`/api/tasks/${locked.id}/cancel`).set(auth)).status).toBe(409);
    expect(locked.status).toBe(status);
  }
});

it('merges retained submission records with sessions without duplicates', async () => {
  const s = draft('kevin', 'default', 'submitted');
  const submittedAt = new Date().toISOString();
  s.submission = { oaRequestId: 'REQ-1', status: 'pending', submittedAt };
  for (const [oaRequestId, userId] of [['REQ-1', 'kevin'], ['OLD', 'kevin'], ['PRIVATE', 'another-user']]) {
    submissionStore.record('default', { oaRequestId, userId, formId: 'leave-request', formTitle: '原始表單標題', submittedAt });
  }
  const res = await request(app).get('/api/tasks').set(auth);
  expect(res.body.data.submissions).toHaveLength(2);
  expect(res.body.data.submissions.find((r: { oaRequestId: string }) => r.oaRequestId === 'REQ-1'))
    .toMatchObject({ conversationId: s.id, title: '原始表單標題' });
  expect(res.body.data.submissions.find((r: { oaRequestId: string }) => r.oaRequestId === 'OLD').conversationId).toBeUndefined();
});

it('lists only owned, unexpired reports and deduplicates output formats without requiring a live job', async () => {
  for (const [reportId, tenantId, userId] of [['mine', 'default', 'kevin'], ['private', 'default', 'other'], ['cross', 'other', 'kevin']]) {
    for (const format of ['md', 'html']) {
      reportStore.save({ reportId, tenantId, userId, format, filename: `${reportId}.${format}`, content: Buffer.from('private report bytes') });
    }
  }
  const res = await request(app).get('/api/tasks').set(auth);
  expect(res.body.data.reports).toHaveLength(1);
  expect(res.body.data.reports[0].id).toBe('mine');
  expect(JSON.stringify(res.body)).not.toContain('private report bytes');
  const expired = (await reportStore.get('mine', 'md'))!;
  expired.expiresAt = '2000-01-01T00:00:00.000Z';
  (await reportStore.get('mine', 'html'))!.expiresAt = expired.expiresAt;
  expect((await request(app).get('/api/tasks').set(auth)).body.data.reports).toEqual([]);
});

it('keeps listing, reading and cancelling available when LLM quota is exhausted', async () => {
  const tenant = tenantStore.getTenant('default')!;
  const previous = tenant.quotaMonthlyLlmTokens;
  tenant.quotaMonthlyLlmTokens = 1;
  const spy = jest.spyOn(usageStore, 'currentMonthLlmTokens').mockReturnValue(100);
  try {
    const s = draft();
    expect((await request(app).get('/api/tasks').set(auth)).status).toBe(200);
    expect((await request(app).get(`/api/tasks/${s.id}`).set(auth)).status).toBe(200);
    expect((await request(app).post(`/api/tasks/${s.id}/cancel`).set(auth)).status).toBe(200);
  } finally {
    tenant.quotaMonthlyLlmTokens = previous;
    spy.mockRestore();
  }
});


it('includes running and failed report jobs only for their owner and deduplicates stored outputs', async () => {
  const params = { tenantId: 'default', userId: 'kevin', topic: '尚在產生的報告', llm: { name: 'test', createMessage: jest.fn() } };
  // 暫停在大綱階段，避免任何 LLM／外部服務呼叫。
  const deps = { outline: () => new Promise<never>(() => {}) };
  const mine = startReportJob(params, deps);
  const other = startReportJob({ ...params, tenantId: 'other', userId: 'someone-else' }, deps);
  const ownList = await request(app).get('/api/tasks').set(auth);
  expect(ownList.body.data.reports.map((r: { id: string }) => r.id)).toEqual([mine.id]);
  expect(JSON.stringify(ownList.body)).not.toContain(other.id);
  mine.status = 'failed';
  mine.finishedAt = new Date().toISOString();
  reportStore.save({ reportId: mine.id, tenantId: 'default', userId: 'kevin', format: 'md', filename: 'partial.md', content: Buffer.from('partial') });
  const merged = await request(app).get('/api/tasks').set(auth);
  expect(merged.body.data.reports).toHaveLength(1);
  expect(merged.body.data.reports[0].title).toBe(params.topic);
  reportStore._resetForTest();
  mine.finishedAt = '2000-01-01T00:00:00.000Z';
  expect((await request(app).get('/api/tasks').set(auth)).body.data.reports).toEqual([]);
});
