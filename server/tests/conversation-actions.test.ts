/** 確認卡片端點：確認才執行、一次性、過期/不符 409、權限撤銷 403、取消不執行。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { createPendingAction } from '@/modules/conversation/pending-action';
import { makeToolContext, registerTool, toolRegistry } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const calls: unknown[] = [];

registerTool({
  id: 'test.actionWrite',
  description: '測試寫入',
  confirmTitle: '測試動作',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', title: '備註' } },
    required: ['note'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  agentExposed: true,
  effect: 'write',
  handler: async (input) => {
    calls.push(input);
    return { done: true };
  },
});

async function loginToken(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

async function seedPending(token: string, now = Date.now()): Promise<{ convId: string; actionId: string }> {
  const start = await request(app).post('/api/conversations').set('Authorization', `Bearer ${token}`).send({});
  expect(start.status).toBe(201);
  const convId = start.body.data.id as string;
  const session = conversationStore.get(convId, 'default', 'kevin');
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: '要執行嗎？' }] });
  const tool = toolRegistry.resolve('test.actionWrite', makeToolContext({ tenantId: 'default', userId: 'kevin' }));
  session.pendingAction = createPendingAction(tool, { note: 'hello' }, now);
  conversationStore.save(session);
  return { convId, actionId: session.pendingAction.id };
}

function confirm(token: string, convId: string, actionId: string) {
  return request(app).post(`/api/conversations/${convId}/actions/${actionId}/confirm`).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  calls.length = 0;
  tenantStore.updateTenant('default', { grantedScopes: ['email:write'] });
});

describe('確認卡片端點', () => {
  it('確認 → 執行一次、回覆已完成、清除待確認動作', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain('已完成「測試動作」');
    expect(res.body.data.actionOk).toBe(true);
    expect(calls).toEqual([{ note: 'hello' }]);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('同時送出兩次確認 → 只執行一次，另一次 409', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const [a, b] = await Promise.all([confirm(token, convId, actionId), confirm(token, convId, actionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
  });

  it('actionId 不符 → 409 ACTION_NOT_FOUND、不執行', async () => {
    const token = await loginToken();
    const { convId } = await seedPending(token);
    const res = await confirm(token, convId, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('已過期 → 409 ACTION_EXPIRED、不執行、清除', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token, Date.now() - 11 * 60 * 1000);
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTION_EXPIRED');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('確認前權限被撤銷 → 403、不執行', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    tenantStore.updateTenant('default', { grantedScopes: [] });
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('取消 → 200、不執行、清除', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const res = await request(app)
      .post(`/api/conversations/${convId}/actions/${actionId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain('已取消「測試動作」');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('未帶 token → 401', async () => {
    const res = await request(app).post('/api/conversations/00000000-0000-4000-8000-000000000000/actions/00000000-0000-4000-8000-000000000000/confirm');
    expect(res.status).toBe(401);
  });
});
