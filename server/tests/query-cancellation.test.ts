import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { querySignal, runHttpQuery, stopQuery, throwIfQueryCancelled, withQuerySignal } from '@/lib/query-cancellation';
import { runToolLoop } from '@/modules/conversation/tool-loop';
import type { Session } from '@/modules/conversation/conversation.types';

function httpFixture(id: string, tenantId = 't', userId = 'u') {
  const req = Object.assign(new EventEmitter(), { tenant: { id: tenantId }, user: { sub: userId }, header: (name: string) => name === 'x-query-id' ? id : undefined }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response;
  return { req, res };
}

it('停止只影響同租戶與同使用者，並處理停止先到的競態', async () => {
  const id = randomUUID();
  const { req, res } = httpFixture(id);
  await runHttpQuery(req, res, async () => {
    const signal = querySignal()!;
    stopQuery('other', 'u', id);
    stopQuery('t', 'other', id);
    expect(signal.aborted).toBe(false);
    stopQuery('t', 'u', id);
    expect(signal.aborted).toBe(true);
    throwIfQueryCancelled();
  });
  expect(res.status).toHaveBeenCalledWith(499);
  const nextId = randomUUID();
  stopQuery('t', 'u', nextId);
  const next = httpFixture(nextId);
  const work = jest.fn();
  await runHttpQuery(next.req, next.res, work);
  expect(work).not.toHaveBeenCalled();
});

it('HTTP 非正常斷線會取消，但正常完成不會取消後續背景工作', async () => {
  for (const complete of [true, false]) {
    const { req, res } = httpFixture(randomUUID());
    await runHttpQuery(req, res, async () => {
      Object.assign(res, { writableEnded: complete });
      res.emit('close');
      expect(querySignal()?.aborted).toBe(!complete);
    });
    expect(res.listenerCount('close')).toBe(0);
  }
});

it('模型回傳後已停止，不執行任何新工具或額外模型呼叫', async () => {
  const controller = new AbortController();
  const session = { id: randomUUID(), tenantId: 'default', userId: 'u', messages: [] } as unknown as Session;
  const dispatchTool = jest.fn();
  const createMessage = jest.fn(async () => {
    controller.abort();
    return { text: '', toolCalls: [{ id: 'call', name: 'write', input: {} }], stopReason: 'tool_use' as const, model: 'fake', keySource: 'platform' as const };
  });
  await expect(withQuerySignal(controller.signal, () => runToolLoop({ name: 'fake', createMessage }, session, { system: '', tools: [], dispatchTool }))).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
  expect(dispatchTool).not.toHaveBeenCalled();
  expect(createMessage).toHaveBeenCalledTimes(1);
});
