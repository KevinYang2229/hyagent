/** 確認帶修改（唯讀不變、422 保留動作、一次性）與不經 AI 的提議端點。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { registerTool } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const calls: unknown[] = [];

registerTool({
  id: 'test.replenish',
  description: '建立補貨單（測試）',
  confirmTitle: '確認建立補貨單',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true, 'x-hidden': true },
            name: { type: 'string', title: '商品名稱', readOnly: true },
            quantity: { type: 'integer', title: '補貨數量', minimum: 1, maximum: 200 },
          },
          required: ['productId', 'name', 'quantity'],
          additionalProperties: false,
        },
      },
      arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
    },
    required: ['items', 'arrivalDate'],
    additionalProperties: false,
  },
  scopes: [],
  agentExposed: true,
  effect: 'write',
  handler: async (input) => {
    calls.push(input);
    return { orderId: 'R-1' };
  },
});
registerTool({
  id: 'test.readonlyTool',
  description: '唯讀（測試）',
  inputSchema: { type: 'object', properties: {} },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => ({}),
});

const input = {
  items: [
    { productId: 'P1', name: '鮭魚御飯糰', quantity: 24 },
    { productId: 'P2', name: '三明治', quantity: 20 },
  ],
  arrivalDate: '2026-10-05',
};

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

async function startConv(t: string): Promise<string> {
  const res = await request(app).post('/api/conversations').set('Authorization', `Bearer ${t}`).send({});
  return res.body.data.id as string;
}

function propose(t: string, convId: string, body: string | object) {
  return request(app).post(`/api/conversations/${convId}/actions/propose`).set('Authorization', `Bearer ${t}`).send(body);
}

function confirm(t: string, convId: string, actionId: string, body: string | object = {}) {
  return request(app).post(`/api/conversations/${convId}/actions/${actionId}/confirm`).set('Authorization', `Bearer ${t}`).send(body);
}

beforeEach(() => {
  calls.length = 0;
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

describe('propose', () => {
  it('寫入工具 → 回傳含 form 的待確認動作，不執行', async () => {
    const t = await token();
    const conv = await startConv(t);
    const res = await propose(t, conv, { toolId: 'test.replenish', input });
    expect(res.status).toBe(200);
    expect(res.body.data.pendingAction.form.title).toBe('確認建立補貨單');
    expect(calls).toHaveLength(0);
  });

  it('非寫入工具 → 422 NOT_A_WRITE_TOOL；未知工具 → 404 TOOL_NOT_FOUND；輸入不合法 → 422', async () => {
    const t = await token();
    const conv = await startConv(t);
    expect((await propose(t, conv, { toolId: 'test.readonlyTool', input: {} })).body.error.code).toBe('NOT_A_WRITE_TOOL');
    const unknown = await propose(t, conv, { toolId: 'test.nope', input: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('TOOL_NOT_FOUND');
    expect((await propose(t, conv, { toolId: 'test.replenish', input: { items: [] } })).status).toBe(422);
  });
});

describe('confirm 帶修改', () => {
  it('改數量並刪一列 → 以修改後參數執行，逐字稿記下差異', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const edited = { items: [{ productId: 'P1', name: '鮭魚御飯糰', quantity: 30 }], arrivalDate: '2026-10-06' };
    const res = await confirm(t, conv, actionId, { input: edited });
    expect(res.status).toBe(200);
    expect(res.body.data.actionOk).toBe(true);
    expect(calls).toEqual([edited]);
    const transcript = JSON.stringify(conversationStore.get(conv, 'default', 'kevin').messages);
    expect(transcript).toContain('鮭魚御飯糰 補貨數量 24→30');
    expect(transcript).toContain('移除 三明治');
  });

  it('改唯讀欄位 → 422 ACTION_INPUT_INVALID，動作保留，可改正後再送', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const bad = { ...input, items: [{ productId: 'P1', name: '被改名', quantity: 24 }] };
    const res = await confirm(t, conv, actionId, { input: bad });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ACTION_INPUT_INVALID');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(conv, 'default', 'kevin').pendingAction?.id).toBe(actionId);
    expect((await confirm(t, conv, actionId, { input })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('數量超出上限（Ajv）→ 422，動作保留', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const res = await confirm(t, conv, actionId, { input: { ...input, items: [{ ...input.items[0], quantity: 999 }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ACTION_INPUT_INVALID');
    expect(conversationStore.get(conv, 'default', 'kevin').pendingAction?.id).toBe(actionId);
  });

  it('兩個帶修改的確認同時送達 → 只執行一次，另一個 409', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const [a, b] = await Promise.all([confirm(t, conv, actionId, { input }), confirm(t, conv, actionId, { input })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
  });

  it('body 有未知鍵 → 422（schema 嚴格）', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    expect((await confirm(t, conv, actionId, { inputs: input })).status).toBe(422);
  });
});
