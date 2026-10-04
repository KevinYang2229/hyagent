/** 建立對話時順帶的第一則訊息：回應要帶回完整回合（表格、確認卡片），不可只挑 reply。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import * as agent from '@/modules/conversation/conversation.agent';
import type { TurnResult } from '@/modules/conversation/conversation.types';

const app = createApp();

async function loginToken(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

afterEach(() => jest.restoreAllMocks());

it('第一則訊息的 blocks 與 pendingAction 會出現在建立對話的回應中', async () => {
  const turn = {
    reply: '查到了',
    status: 'collecting',
    values: {},
    submission: null,
    suggestions: ['下一步'],
    blocks: [{ type: 'table', columns: [{ key: 'name', label: '商品' }], rows: [{ name: '鮭魚御飯糰' }] }],
    pendingAction: { id: 'a1', toolId: 't', title: '補貨', summary: {}, expiresAt: '2099-01-01T00:00:00.000Z' },
  } as unknown as TurnResult;
  jest.spyOn(agent, 'runTurn').mockResolvedValue(turn);

  const token = await loginToken();
  const res = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${token}`)
    .send({ message: '幫我查御飯糰的庫存' });

  expect(res.status).toBe(201);
  expect(res.body.data.reply).toBe('查到了');
  expect(res.body.data.blocks).toEqual(turn.blocks);
  expect(res.body.data.pendingAction).toEqual(turn.pendingAction);
});

it('沒有第一則訊息時不帶 blocks / pendingAction', async () => {
  const token = await loginToken();
  const res = await request(app).post('/api/conversations').set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(201);
  expect(res.body.data.reply).toBeNull();
  expect(res.body.data).not.toHaveProperty('blocks');
  expect(res.body.data).not.toHaveProperty('pendingAction');
});
