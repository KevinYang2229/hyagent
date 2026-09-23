import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { assertionExchange } from '@/modules/auth/assertion-exchange';
import { issueAssertion } from './helpers/assertion-signer';
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
const keyPair = generateHyAgentKeyPair('ES256');

/**
 * 以 Identity Assertion 換一個 HyAgent Session（改造前是 HS256 的 ssoExchange）。
 *
 * Assertion 裡刻意帶 `role: 'admin'`：規格不賦予外部 claims 任何授權意義，
 * 本系統一律換發 employee——那正是下面第一支測試要釘的事。
 */
async function fixture(granted = true) {
  const tenant = tenantStore.createTenant('security fixture', ['*']);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  if (granted) tenantStore.updateTenant(tenant.id, { grantedScopes: ['service:form', 'form:leave-request'] });
  const key = tenantStore.createApiKey(tenant.id, 'publishable').key;
  const assertion = issueAssertion({
    privateKey: keyPair.privateKeyPem,
    tenant: tenant.id,
    subject: 'shared-user',
    profile: { role: 'admin' },
  });
  const session = await assertionExchange.exchange({ assertion });
  const headers = { authorization: `Bearer ${session.sessionToken}`, 'x-api-key': key };
  return { tenant, key, session, headers };
}
function draft(tenantId: string) {
  const session = conversationStore.create(tenantId, 'shared-user', 'leave-request');
  session.values = { ...values };
  session.status = 'confirming';
  return session;
}

afterEach(() => jest.restoreAllMocks());

it('SSO admin claim and user-audience admin token cannot enter platform admin APIs', async () => {
  const { headers } = await fixture();
  expect((await request(app).get('/api/admin/tenants').set(headers)).status).toBe(401);
  const fakeAdmin = signAccessToken({ sub: 'admin', role: 'admin', via: 'password' });
  expect((await request(app).get('/api/admin/tenants').auth(fakeAdmin, { type: 'bearer' })).status).toBe(401);
  const admin = await request(app).get('/api/admin/tenants').auth(signAdminToken(), { type: 'bearer' });
  expect(admin.status).toBe(200);
  // HyAgent 已不持有任何可偽造客戶身分的秘密：租戶上只剩公鑰
  expect(JSON.stringify(admin.body)).not.toContain('PRIVATE KEY');
  expect(admin.body.data.some((t: { activeKeyCount?: number }) => (t.activeKeyCount ?? 0) > 0)).toBe(true);
});

it('tenant create/list/update redact secrets while preserving configuration status', async () => {
  const headers = { 'x-admin-key': 'test-admin-key' };
  const created = await request(app).post('/api/admin/tenants').set(headers).send({ name: 'redaction' });
  expect(created.status).toBe(201);
  const id = created.body.data.tenant.id;
  // 新租戶還沒上傳公鑰 → 無法登入，後台要看得出來（規格 §11.1）
  expect(created.body.data.tenant).toMatchObject({ activeKeyCount: 0 });
  tenantStore.updateTenant(id, { llmConfig: { provider: 'anthropic', anthropicApiKey: 'secret-llm-test' } });
  const updated = await request(app).patch(`/api/admin/tenants/${id}`).set(headers).send({ name: 'new name' });
  expect(updated.status).toBe(200);
  const listed = await request(app).get('/api/admin/tenants').set(headers);
  for (const res of [updated, listed]) {
    expect(JSON.stringify(res.body)).not.toContain('secret-llm-test');
  }
});

it('binds conversations, reports, forms and tasks to the authenticated tenant', async () => {
  const a = await fixture(); const b = await fixture();
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
  const f = await fixture(false);
  const created = await request(app).post('/api/conversations').set(f.headers).send({});
  expect(created.status).toBe(201);
  expect(created.body.data.formId).toBe('');
  const id = created.body.data.id;
  expect((await request(app).patch(`/api/conversations/${id}/fields`).set(f.headers).send({ fields: values })).status).toBe(403);
  expect((await request(app).post(`/api/conversations/${id}/submit`).set(f.headers)).status).toBe(403);
  expect((await request(app).post('/api/conversations').set(f.headers).send({ formId: 'leave-request' })).status).toBe(403);
});

it('rechecks revoked form and service grants on existing sessions and agent tools', async () => {
  const f = await fixture(); const session = draft(f.tenant.id);
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
  const f = await fixture(); const session = draft(f.tenant.id);
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
  const f = await fixture(); const session = draft(f.tenant.id);
  const submit = jest.spyOn(toolRegistry.get('oa.submitForm')!, 'handler').mockRejectedValue(new Error('timeout after acceptance'));
  await expect(submitSession(session)).rejects.toThrow(/timeout/);
  session.status = 'confirming';
  const result = await formAgentService.handleTurn(session, '確認', {} as LLMProvider);
  expect(result.reply).toContain('已有送出紀錄');
  expect(submit).toHaveBeenCalledTimes(1);
});

it('persistence failure prevents any external OA side effect', async () => {
  const f = await fixture(); const session = draft(f.tenant.id);
  const submit = jest.spyOn(toolRegistry.get('oa.submitForm')!, 'handler');
  jest.spyOn(conversationStore, 'saveCritical').mockRejectedValue(new Error('disk unavailable'));
  await expect(submitSession(session)).rejects.toThrow(/disk unavailable/);
  expect(submit).not.toHaveBeenCalled();
});
