import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { recordReply } from '@/modules/conversation/reply-record';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { feedbackStore } from '@/modules/feedback/feedback.store';

const app = createApp();

async function tokenFor(username: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

async function setup() {
  const token = await tokenFor('kevin');
  const start = await request(app).post('/api/conversations').set('Authorization', `Bearer ${token}`).send({});
  const sessionId = start.body.data.id as string;
  const session = conversationStore.get(sessionId, 'default', 'kevin');
  const reply = recordReply(session, { question: '特休幾天？', answer: '7 天', serviceId: 'knowledge' });
  conversationStore.save(session);
  const url = `/api/conversations/${sessionId}/replies/${reply.id}/feedback`;
  return { token, sessionId, reply, url };
}

afterEach(() => feedbackStore.clear());

it('倒讚附原因與說明 → 寫入快照；回應不含快照', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`)
    .send({ rating: 'down', reason: 'wrong', comment: '  應該是 10 天  ' });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ rating: 'down', reason: 'wrong', comment: '應該是 10 天' });
  const [f] = feedbackStore.list('default', {}, { limit: 10 }).items;
  expect(f).toMatchObject({ userId: 'kevin', question: '特休幾天？', answer: '7 天', rating: 'down' });
});

it('按讚帶原因 → 422', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'up', reason: 'wrong' });
  expect(res.status).toBe(422);
});

it('說明超過 500 字 → 422', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'down', comment: 'x'.repeat(501) });
  expect(res.status).toBe(422);
});

it('replyId 不在對話中（含已被擠出最近 20 則）→ 404', async () => {
  const { token, sessionId } = await setup();
  const res = await request(app)
    .put(`/api/conversations/${sessionId}/replies/00000000-0000-4000-8000-000000000000/feedback`)
    .set('Authorization', `Bearer ${token}`).send({ rating: 'up' });
  expect(res.status).toBe(404);
  expect(res.body.error.message).toContain('這則回覆已無法評價');
});

it('他人的對話不能評價（與既有對話 API 一致回 403）', async () => {
  const { url } = await setup();
  const other = await tokenFor('hyweb');
  const res = await request(app).put(url).set('Authorization', `Bearer ${other}`).send({ rating: 'up' });
  expect(res.status).toBe(403);
  expect(feedbackStore.list('default', {}, { limit: 10 }).items).toEqual([]);
});

it('撤回：204，重複撤回也 204', async () => {
  const { token, url } = await setup();
  await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'up' });
  expect((await request(app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(204);
  expect((await request(app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(204);
  expect(feedbackStore.list('default', {}, { limit: 10 }).items).toEqual([]);
});

it('未登入 → 401', async () => {
  const { url } = await setup();
  expect((await request(app).put(url).send({ rating: 'up' })).status).toBe(401);
});

it('租戶月配額用盡：評價仍 200（不掛配額），對話訊息 429', async () => {
  const { token, sessionId, url } = await setup();
  try {
    tenantStore.updateTenant('default', { quotaMonthlyLlmTokens: 10 });
    usageStore.recordLLMUsage('default', { usage: { inputTokens: 8, outputTokens: 4 }, model: 'claude-sonnet-4-5', keySource: 'platform' });
    const fb = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'up' });
    expect(fb.status).toBe(200);
    const msg = await request(app).post(`/api/conversations/${sessionId}/messages`).set('Authorization', `Bearer ${token}`).send({ message: 'hi' });
    expect(msg.status).toBe(429);
  } finally {
    tenantStore.updateTenant('default', { quotaMonthlyLlmTokens: 0 });
  }
});
