/**
 * 影像辨識 API：假 LLM 回固定的回報工具呼叫；門市工具以同 id 的靜態測試工具代替 MCP。
 */
const llmCreate = jest.fn();
jest.mock('@/lib/llm', () => {
  const actual = jest.requireActual('@/lib/llm');
  return { ...actual, getLLMProvider: () => ({ name: 'fake', createMessage: llmCreate }) };
});

import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { registerTool, toolOutput } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const usage = { inputTokens: 1, outputTokens: 1 };

const products: Record<string, { productId: string; name: string; stock: number; suggested: number; expiryDate: string; expiring: boolean }> = {
  鮭魚御飯糰: { productId: 'P001', name: '鮭魚御飯糰', stock: 0, suggested: 30, expiryDate: '2026-10-05', expiring: false },
  沙拉: { productId: 'P007', name: '沙拉－和風雞肉', stock: 5, suggested: 18, expiryDate: '2026-10-04', expiring: true },
};

registerTool({
  id: 'mcp.store-demo.product_lookup', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } },
  handler: async (input) => ({
    matches: (input as { names: string[] }).names.map((q) => (products[q] ? { query: q, productId: products[q].productId, name: products[q].name, score: 1 } : { query: q, score: 0.1 })),
  }),
});
registerTool({
  id: 'mcp.store-demo.inventory_query', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { productIds: { type: 'array', items: { type: 'string' } } } },
  handler: async (input) => toolOutput({
    items: Object.values(products).filter((p) => (input as { productIds: string[] }).productIds.includes(p.productId)),
  }, { type: 'table', rows: 'items', columns: [{ key: 'name', label: '商品' }] }),
});
registerTool({
  id: 'mcp.store-demo.coupon_check', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  handler: async (input) => toolOutput(
    { code: (input as { code: string }).code, valid: true, reason: '可使用', rows: [{ title: '咖啡折 5 元', reason: '可使用' }] },
    { type: 'table', rows: 'rows', columns: [{ key: 'title', label: '優惠券' }, { key: 'reason', label: '狀態' }] },
  ),
});

function reportCall(name: string, input: Record<string, unknown>) {
  return { text: '', toolCalls: [{ id: 'r1', name, input }], stopReason: 'tool_use', usage, model: 'm', keySource: 'platform' };
}

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

function analyze(t: string, mode: string, file: Buffer = PNG, mime = 'image/png') {
  return request(app)
    .post('/api/vision/analyze')
    .set('Authorization', `Bearer ${t}`)
    .field('mode', mode)
    .attach('image', file, { filename: 'shelf.png', contentType: mime });
}

beforeEach(() => {
  llmCreate.mockReset();
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

describe('POST /api/vision/analyze — shelf', () => {
  it('辨識 → 補齊商品與庫存 → 即期判斷 → 補貨提議；座標夾回 0–1', async () => {
    llmCreate.mockResolvedValue(reportCall('report_shelf', {
      items: [
        { name: '鮭魚御飯糰', status: 'out_of_stock', box: { x: 0.1, y: 0.2, w: 0.15, h: 0.1 } },
        { name: '沙拉', status: 'ok', box: { x: -0.2, y: 0.9, w: 0.5, h: 0.4 } },
        { name: '神秘商品', status: 'misplaced', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
      ],
    }));
    const t = await token();
    const res = await analyze(t, 'shelf');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.mode).toBe('shelf');
    expect(d.findings[0]).toMatchObject({ name: '鮭魚御飯糰', productId: 'P001', status: 'out_of_stock', stock: 0, suggestedQty: 30 });
    expect(d.findings[1]).toMatchObject({ productId: 'P007', status: 'expiring', expiryDate: '2026-10-04' });
    // x=-0.2 超出左緣：夾到 0，可見寬度扣掉超出的 0.2 → 0.3；y=0.9 時高度最多到底 → 0.1
    expect(d.findings[1].box).toEqual({ x: 0, y: 0.9, w: 0.3, h: 0.1 });
    expect(d.findings[2]).toMatchObject({ name: '神秘商品', status: 'misplaced' });
    expect(d.findings[2]).not.toHaveProperty('productId');
    expect(d.counts).toEqual({ outOfStock: 1, expiring: 1, misplaced: 1 });
    expect(d.replenishment.toolId).toBe('mcp.store-demo.replenishment_create');
    expect(d.replenishment.input.items).toEqual([{ productId: 'P001', name: '鮭魚御飯糰', stock: 0, quantity: 30 }]);
    expect(d.replenishment.input.arrivalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sent = llmCreate.mock.calls[0][0];
    expect(sent.toolChoice).toEqual({ name: 'report_shelf' });
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
  });

  it('LLM 沒有呼叫回報工具 → 502 VISION_FAILED', async () => {
    llmCreate.mockResolvedValue({ text: '我看不清楚', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform' });
    const res = await analyze(await token(), 'shelf');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('VISION_FAILED');
  });

  it('回報格式不對 → 502 VISION_FAILED', async () => {
    llmCreate.mockResolvedValue(reportCall('report_shelf', { items: 'oops' }));
    const res = await analyze(await token(), 'shelf');
    expect(res.status).toBe(502);
  });
});

describe('POST /api/vision/analyze — coupon', () => {
  it('讀到券號 → 查券並回表格區塊', async () => {
    llmCreate.mockResolvedValue(reportCall('report_coupon', { code: ' coffee 50 ', title: '咖啡折 5 元' }));
    const res = await analyze(await token(), 'coupon');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'coupon', extracted: { code: 'COFFEE50', title: '咖啡折 5 元' }, result: { valid: true } });
    expect(res.body.data.block.type).toBe('table');
  });

  it('讀不到券號 → 提示改用掃條碼或手動輸入', async () => {
    llmCreate.mockResolvedValue(reportCall('report_coupon', {}));
    const res = await analyze(await token(), 'coupon');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('讀不到券號，請掃條碼或手動輸入');
    expect(res.body.data.result).toBeUndefined();
  });
});

describe('POST /api/vision/analyze — 輸入與權限', () => {
  it('非圖片 → 422；mode 不合法 → 422；沒附圖 → 422', async () => {
    const t = await token();
    expect((await analyze(t, 'shelf', Buffer.from('%PDF'), 'application/pdf')).status).toBe(422);
    expect((await analyze(t, 'menu')).status).toBe(422);
    expect((await request(app).post('/api/vision/analyze').set('Authorization', `Bearer ${t}`).field('mode', 'shelf')).status).toBe(422);
  });

  it('沒有 service:agent → 403；未登入 → 401', async () => {
    tenantStore.updateTenant('default', { grantedScopes: [] });
    expect((await analyze(await token(), 'shelf')).status).toBe(403);
    expect((await request(app).post('/api/vision/analyze').field('mode', 'shelf')).status).toBe(401);
  });
});
