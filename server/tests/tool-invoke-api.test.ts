/** 直接呼叫唯讀工具：只放行 agent 可用的唯讀工具；表格提示轉成 block；MCP 錯誤 503。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { McpToolCallError } from '@/modules/mcp/mcp.connection';
import { registerTool, toolOutput } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const calls: unknown[] = [];

registerTool({
  id: 'test.invokeTable', description: 'x', scopes: [], agentExposed: true, effect: 'read',
  inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } },
  handler: async (input) => {
    calls.push(input);
    return toolOutput({ items: [{ name: '鮭魚御飯糰', stock: 6 }] }, { type: 'table', title: '庫存', rows: 'items', columns: [{ key: 'name', label: '商品' }, { key: 'stock', label: '庫存' }] });
  },
});
registerTool({
  id: 'test.invokePlain', description: 'x', scopes: [], agentExposed: true, effect: 'read',
  inputSchema: { type: 'object' },
  handler: async () => ({ ok: 1 }),
});
registerTool({
  id: 'test.invokeWrite', description: 'x', scopes: [], agentExposed: true, effect: 'write',
  inputSchema: { type: 'object' },
  handler: async () => { calls.push('write'); return {}; },
});
registerTool({
  id: 'test.invokeUnmarked', description: 'x', scopes: [], agentExposed: true,
  inputSchema: { type: 'object' },
  handler: async () => { calls.push('unmarked'); return {}; },
});
registerTool({
  id: 'test.invokeHidden', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object' },
  handler: async () => ({}),
});
registerTool({
  id: 'test.invokeScoped', description: 'x', scopes: ['erp:read'], agentExposed: true, effect: 'read',
  inputSchema: { type: 'object' },
  handler: async () => ({}),
});
registerTool({
  id: 'test.invokeSchema', description: 'x', scopes: [], agentExposed: true, effect: 'read',
  inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  handler: async () => ({}),
});
registerTool({
  id: 'test.invokeDown', description: 'x', scopes: [], agentExposed: true, effect: 'read',
  inputSchema: { type: 'object' },
  handler: async () => { throw new McpToolCallError('門市 Demo 暫時無法使用：connect ECONNREFUSED'); },
});

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

function invoke(t: string, toolId: string, body: unknown = { input: {} }) {
  return request(app).post(`/api/tools/${encodeURIComponent(toolId)}/invoke`).set('Authorization', `Bearer ${t}`).send(body as object);
}

beforeEach(() => {
  calls.length = 0;
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

describe('POST /api/tools/:toolId/invoke', () => {
  it('唯讀工具：回傳資料與表格 block，輸入原樣傳給工具', async () => {
    const res = await invoke(await token(), 'test.invokeTable', { input: { keyword: '御飯糰' } });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ keyword: '御飯糰' }]);
    expect(res.body.data.result).toEqual({ items: [{ name: '鮭魚御飯糰', stock: 6 }] });
    expect(res.body.data.block).toMatchObject({ type: 'table', title: '庫存', rows: [{ name: '鮭魚御飯糰', stock: 6 }] });
  });

  it('沒有表格提示 → 沒有 block；省略 input 視為 {}', async () => {
    const res = await invoke(await token(), 'test.invokePlain', {});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ result: { ok: 1 } });
  });

  it.each(['test.invokeWrite', 'test.invokeUnmarked'])('寫入或未標示的工具 %s → 422 NOT_A_READ_TOOL，不執行', async (id) => {
    const res = await invoke(await token(), id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_A_READ_TOOL');
    expect(calls).toEqual([]);
  });

  it.each(['test.invokeHidden', 'test.nope'])('未開放給 agent 或不存在 %s → 404 TOOL_NOT_FOUND', async (id) => {
    const res = await invoke(await token(), id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('缺少工具所需權限 → 403', async () => {
    const res = await invoke(await token(), 'test.invokeScoped');
    expect(res.status).toBe(403);
  });

  it('輸入不符 schema → 422', async () => {
    const res = await invoke(await token(), 'test.invokeSchema', { input: {} });
    expect(res.status).toBe(422);
  });

  it('MCP 呼叫失敗 → 503 TOOL_UNAVAILABLE', async () => {
    const res = await invoke(await token(), 'test.invokeDown');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TOOL_UNAVAILABLE');
  });

  it('沒有 service:agent → 403；沒登入 → 401', async () => {
    tenantStore.updateTenant('default', { grantedScopes: [] });
    expect((await invoke(await token(), 'test.invokePlain')).status).toBe(403);
    expect((await request(app).post('/api/tools/test.invokePlain/invoke').send({})).status).toBe(401);
  });

  it('body 有多餘欄位 → 422', async () => {
    const res = await invoke(await token(), 'test.invokePlain', { input: {}, extra: 1 });
    expect(res.status).toBe(422);
  });
});
