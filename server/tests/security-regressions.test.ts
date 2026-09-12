import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { authService } from '@/modules/auth/auth.service';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { conversationService } from '@/modules/conversation/conversation.service';
import { formAgentService } from '@/modules/conversation/form.agent-service';
import { submitSession } from '@/modules/conversation/submit-session';
import { reportStore } from '@/modules/report/report.store';
import { toolRegistry } from '@/modules/tools/tool.registry';
import { signAccessToken, signAdminToken } from '@/utils/jwt';
import type { LLMProvider } from '@/lib/llm/types';

const app = createApp();
const values = {
  applicant: '測試使用者', deputy: '林佩蓉(HYW018)', leaveType: 'annual',
  startDate: '2026-10-01', endDate: '2026-10-01', startTime: '09:00', endTime: '18:00', reason: '事務',
};
function fixture(granted = true) {
  const tenant = tenantStore.createTenant('security fixture', [], 'security-test-sso-secret-32-characters');
  if (granted) tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:form', 'form:leave-request'] });
  const key = tenantStore.createApiKey(tenant.id, 'publishable').key;
  const userToken = jwt.sign({ sub: 'shared-user', role: 'admin' }, tenant.ssoSecret!, {
    algorithm: 'HS256', issuer: 'hyagent:handoff', audience: 'hyagent:sso', expiresIn: '5m',
  });
  const tokens = authService.ssoExchange(tenant, userToken);
  const headers = { authorization: `Bearer ${tokens.accessToken}`, 'x-api-key': key };
  return { tenant, key, tokens, headers };
}
function draft(tenantId: string) {
  const session = conversationStore.create(tenantId, 'shared-user', 'leave-request');
  session.values = { ...values };
  session.status = 'confirming';
  return session;
}

afterEach(() => jest.restoreAllMocks());

it('SSO admin claim and user-audience admin token cannot enter platform admin APIs', async () => {
  const { headers } = fixture();
  expect((await request(app).get('/api/admin/tenants').set(headers)).status).toBe(401);
  const fakeAdmin = signAccessToken({ sub: 'admin', role: 'admin', via: 'password' });
  expect((await request(app).get('/api/admin/tenants').auth(fakeAdmin, { type: 'bearer' })).status).toBe(401);
  const admin = await request(app).get('/api/admin/tenants').auth(signAdminToken(), { type: 'bearer' });
  expect(admin.status).toBe(200);
  expect(JSON.stringify(admin.body)).not.toContain('security-test-sso-secret');
  expect(admin.body.data.some((t: { ssoConfigured?: boolean }) => t.ssoConfigured)).toBe(true);
});

it('tenant create/list/update redact secrets while preserving configuration status', async () => {
  const headers = { 'x-admin-key': 'test-admin-key' };
  const created = await request(app).post('/api/admin/tenants').set(headers).send({ name: 'redaction', ssoSecret: 'secret-for-redaction-test' });
  expect(created.status).toBe(201);
  const id = created.body.data.tenant.id;
  expect(created.body.data.tenant).toMatchObject({ ssoConfigured: true });
  expect(created.body.data.tenant.ssoSecret).toBeUndefined();
  tenantStore.updateTenant(id, { llmConfig: { provider: 'anthropic', anthropicApiKey: 'secret-llm-test' } });
  const updated = await request(app).patch(`/api/admin/tenants/${id}`).set(headers).send({ name: 'new name' });
  expect(updated.status).toBe(200);
  const listed = await request(app).get('/api/admin/tenants').set(headers);
  for (const res of [updated, listed]) {
    expect(JSON.stringify(res.body)).not.toContain('secret-for-redaction-test');
    expect(JSON.stringify(res.body)).not.toContain('secret-llm-test');
  }
});

it('binds conversations, reports, forms and tasks to the authenticated tenant', async () => {
  const a = fixture(); const b = fixture();
  const session = draft(b.tenant.id);
  reportStore.save({ reportId: session.id, tenantId: b.tenant.id, userId: 'shared-user', format: 'md', filename: 'private.md', content: Buffer.from('private') });
  const foreign = { ...a.headers, 'x-api-key': b.key };
  for (const url of [`/api/conversations/${session.id}`, `/api/reports/${session.id}/download?format=md`, '/api/forms', '/api/tasks']) {
    expect((await request(app).get(url).set(foreign)).status).toBe(401);
  }
  expect((await request(app).get(`/api/conversations/${session.id}`).set(b.headers)).status).toBe(200);
  const password = signAccessToken({ sub: 'shared-user', role: 'employee', via: 'password' });
  expect((await request(app).get('/api/forms').set('x-api-key', b.key).auth(password, { type: 'bearer' })).status).toBe(401);
});

it('rejects the old default secret for reads and writes; newly issued secret works', async () => {
  expect((await request(app).get('/api/tenant/llm-config').set('x-api-key', 'sk_default')).status).toBe(401);
  expect((await request(app).put('/api/tenant/llm-config').set('x-api-key', 'sk_default').send({ provider: 'anthropic' })).status).toBe(401);
  const key = tenantStore.createApiKey('default', 'secret').key;
  expect((await request(app).get('/api/tenant/llm-config').set('x-api-key', key)).status).toBe(200);
});

it('no form grant permits neutral chat but not implicit form editing or submission', async () => {
  const f = fixture(false);
  const created = await request(app).post('/api/conversations').set(f.headers).send({});
  expect(created.status).toBe(201);
  expect(created.body.data.formId).toBe('');
  const id = created.body.data.id;
  expect((await request(app).patch(`/api/conversations/${id}/fields`).set(f.headers).send({ fields: values })).status).toBe(403);
  expect((await request(app).post(`/api/conversations/${id}/submit`).set(f.headers)).status).toBe(403);
  expect((await request(app).post('/api/conversations').set(f.headers).send({ formId: 'leave-request' })).status).toBe(403);
});

it('rechecks revoked form and service grants on existing sessions and agent tools', async () => {
  const f = fixture(); const session = draft(f.tenant.id);
  for (const scopes of [[], ['form:leave-request'], ['service:form']]) {
    tenantStore.updateTenant(f.tenant.id, { grantedScopes: scopes });
    expect(() => conversationService.get(f.tenant.id, 'shared-user', session.id)).toThrow(/無權/);
    expect(() => conversationService.updateFields(f.tenant.id, 'shared-user', session.id, values)).toThrow(/無權/);
    await expect(conversationService.sendMessage(f.tenant.id, 'shared-user', session.id, '確認')).rejects.toThrow(/無權/);
    await expect(submitSession(session)).rejects.toThrow(/無權/);
    await expect(formAgentService.handleTurn(session, '確認', {} as LLMProvider)).rejects.toThrow(/無權/);
  }
});

it('concurrent HTTP submits call OA once and block edit/cancel while in flight', async () => {
  const f = fixture(); const session = draft(f.tenant.id);
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const submit = jest.spyOn(toolRegistry.get('oa.submitForm')!, 'handler').mockImplementation(async () => {
    entered(); await gate; return { oaRequestId: 'SECURITY-ONCE', status: 'accepted' };
  });
  const first = request(app).post(`/api/conversations/${session.id}/submit`).set(f.headers).then((r) => r);
  await ready;
  try {
    const second = await request(app).post(`/api/conversations/${session.id}/submit`).set(f.headers);
    expect(second.status).toBe(409);
    expect((await request(app).patch(`/api/conversations/${session.id}/fields`).set(f.headers).send({ fields: { reason: 'changed' } })).status).toBe(409);
    expect((await request(app).post(`/api/conversations/${session.id}/cancel`).set(f.headers)).status).toBe(409);
  } finally { release(); }
  expect((await first).status).toBe(200);
  expect(submit).toHaveBeenCalledTimes(1);
  // A stale copy after restart/another instance must also be rejected by the durable claim.
  await expect(submitSession({ ...session, status: 'confirming', submission: undefined })).rejects.toMatchObject({ statusCode: 409 });
  expect(submit).toHaveBeenCalledTimes(1);
});

it('an ambiguous OA error cannot be automatically retried via HTTP or agent', async () => {
  const f = fixture(); const session = draft(f.tenant.id);
  const submit = jest.spyOn(toolRegistry.get('oa.submitForm')!, 'handler').mockRejectedValue(new Error('timeout after acceptance'));
  await expect(submitSession(session)).rejects.toThrow(/timeout/);
  session.status = 'confirming';
  const result = await formAgentService.handleTurn(session, '確認', {} as LLMProvider);
  expect(result.reply).toContain('已有送出紀錄');
  expect(submit).toHaveBeenCalledTimes(1);
});

it('persistence failure prevents any external OA side effect', async () => {
  const f = fixture(); const session = draft(f.tenant.id);
  const submit = jest.spyOn(toolRegistry.get('oa.submitForm')!, 'handler');
  jest.spyOn(conversationStore, 'saveCritical').mockRejectedValue(new Error('disk unavailable'));
  await expect(submitSession(session)).rejects.toThrow(/disk unavailable/);
  expect(submit).not.toHaveBeenCalled();
});
