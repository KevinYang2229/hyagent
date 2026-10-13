/** 回覆紀錄：每輪 AI 回覆發 replyId，session 只留最近 20 則，trace 由服務提供。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import * as llmModule from '@/lib/llm';
import * as agent from '@/modules/conversation/conversation.agent';
import { conversationStore } from '@/modules/conversation/conversation.store';
import type { TurnResult } from '@/modules/conversation/conversation.types';
import { intentRouter } from '@/modules/conversation/intent-router';
import { findReply, MAX_REPLY_RECORDS, MAX_SNAPSHOT_CHARS, recordReply, traceChunks } from '@/modules/conversation/reply-record';
import { serviceRegistry } from '@/modules/conversation/service.registry';

afterEach(() => jest.restoreAllMocks());

describe('recordReply / findReply', () => {
  it('只保留最近 MAX_REPLY_RECORDS 則，最舊的被擠出', () => {
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const ids = Array.from({ length: MAX_REPLY_RECORDS + 2 }, (_, i) =>
      recordReply(session, { question: `q${i}`, answer: `a${i}`, serviceId: 'knowledge' }).id,
    );
    expect(session.replies).toHaveLength(MAX_REPLY_RECORDS);
    expect(findReply(session, ids[0])).toBeUndefined();
    expect(findReply(session, ids.at(-1)!)?.answer).toBe(`a${MAX_REPLY_RECORDS + 1}`);
  });

  it('question／answer 各自截到 MAX_SNAPSHOT_CHARS', () => {
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const r = recordReply(session, { question: 'q'.repeat(MAX_SNAPSHOT_CHARS + 50), answer: 'a'.repeat(MAX_SNAPSHOT_CHARS + 50), serviceId: 'knowledge' });
    expect(r.question).toHaveLength(MAX_SNAPSHOT_CHARS);
    expect(r.answer).toHaveLength(MAX_SNAPSHOT_CHARS);
  });

  it('traceChunks 標名次並把內容截成 300 字節錄', () => {
    const out = traceChunks([{ id: 'c1', title: 'T', url: 'https://x', score: 0.9, content: 'x'.repeat(400) }]);
    expect(out).toEqual([{ rank: 1, id: 'c1', title: 'T', url: 'https://x', score: 0.9, excerpt: 'x'.repeat(300) }]);
  });
});

describe('runTurn', () => {
  function stubTurn(reply: string) {
    jest.spyOn(llmModule, 'getLLMProvider').mockReturnValue({
      name: 'mock',
      createMessage: jest.fn().mockResolvedValue({ text: '[]', toolCalls: [], stopReason: 'end_turn', model: 'm', keySource: 'platform' }),
    } as never);
    jest.spyOn(intentRouter, 'route').mockResolvedValue({ serviceId: 'knowledge', viaLLM: false } as never);
    jest.spyOn(serviceRegistry, 'get').mockReturnValue({
      id: 'knowledge',
      sticky: false,
      handleTurn: jest.fn().mockResolvedValue({ reply, trace: { model: 'test-model' } }),
    } as never);
  }

  it('有回覆時記錄問答、服務與 trace，回傳 replyId', async () => {
    stubTurn('請假規定如下');
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '請假規定？');
    expect(turn.replyId).toBeDefined();
    expect(findReply(session, turn.replyId!)).toMatchObject({
      question: '請假規定？',
      answer: '請假規定如下',
      serviceId: 'knowledge',
      trace: { model: 'test-model' },
    });
  });

  it('服務沒有回報 trace（如表單）時，補上作答用的模型', async () => {
    const createMessage = jest.fn().mockResolvedValue({ text: '[]', toolCalls: [], stopReason: 'end_turn', model: 'form-model', keySource: 'platform' });
    jest.spyOn(llmModule, 'getLLMProvider').mockReturnValue({ name: 'mock', createMessage } as never);
    jest.spyOn(intentRouter, 'route').mockResolvedValue({ serviceId: 'form', viaLLM: false } as never);
    jest.spyOn(serviceRegistry, 'get').mockReturnValue({
      id: 'form',
      sticky: true,
      handleTurn: jest.fn(async (_s: unknown, _t: string, llm: { createMessage: typeof createMessage }) => {
        await llm.createMessage({});
        return { reply: '請問外出時間？' };
      }),
    } as never);
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '我要登記外出');
    expect(findReply(session, turn.replyId!)?.trace).toEqual({ model: 'form-model' });
  });

  it('服務自己回報的 trace 優先，不被作答模型覆寫', async () => {
    stubTurn('答');
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '問');
    expect(findReply(session, turn.replyId!)?.trace).toEqual({ model: 'test-model' });
  });

  it('沒有回覆文字時不記錄、不帶 replyId', async () => {
    stubTurn('');
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '嗨');
    expect(turn.replyId).toBeUndefined();
    expect(session.replies ?? []).toHaveLength(0);
  });
});

it('建立對話時帶第一則訊息，回應含 replyId', async () => {
  jest.spyOn(agent, 'runTurn').mockResolvedValue({
    reply: '好的', status: 'collecting', values: {}, suggestions: [], replyId: 'r-1',
  } as TurnResult);
  const login = await request(createApp()).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  const res = await request(createApp())
    .post('/api/conversations')
    .set('Authorization', `Bearer ${login.body.data.accessToken}`)
    .send({ message: '你好' });
  expect(res.status).toBe(201);
  expect(res.body.data.replyId).toBe('r-1');
});
