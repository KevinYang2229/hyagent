import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { querySignal, throwIfQueryCancelled } from '@/lib/query-cancellation';
import { conversationService } from '@/modules/conversation/conversation.service';

const app = createApp();
afterEach(() => jest.restoreAllMocks());

it('停止端點需登入，且能中止已在執行中的 HTTP 查詢', async () => {
  const id = randomUUID();
  expect((await request(app).post(`/api/conversations/queries/${id}/stop`)).status).toBe(401);
  const login = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  const authorization = `Bearer ${login.body.data.accessToken}`;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  jest.spyOn(conversationService, 'start').mockImplementation(async () => {
    const signal = querySignal()!;
    ready();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    throwIfQueryCancelled();
    throw new Error('must be cancelled');
  });
  const running = request(app).post('/api/conversations').set('Authorization', authorization).set('x-query-id', id).send({ message: '查詢測試' }).then((res) => res);
  await started;
  const stopped = await request(app).post(`/api/conversations/queries/${id}/stop`).set('Authorization', authorization);
  expect(stopped.status).toBe(204);
  expect((await running).body.error.code).toBe('QUERY_CANCELLED');
  expect((await request(app).post('/api/conversations/queries/invalid/stop').set('Authorization', authorization)).status).toBe(400);
});
