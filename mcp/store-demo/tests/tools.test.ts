import { describe, expect, it } from 'vitest';
import { callStoreTool, createStoreState } from '../src';

const NOW = new Date('2026-10-03T10:00:00+08:00');
const ctx = (extra: Partial<Parameters<typeof callStoreTool>[2]> = {}) => ({
  now: () => NOW,
  publicBaseUrl: 'https://store.example.com',
  imageIds: new Set(['P001']),
  caller: { tenantId: 't1', userId: 'kevin', scopes: [], jti: 'j', system: false },
  state: createStoreState(),
  ...extra,
});

describe('product_lookup', () => {
  it('名稱、別名與相近名稱都能比對；比不到不給 productId', () => {
    const r = callStoreTool('product_lookup', { names: ['鮭魚御飯糰', '火腿蛋三明治', '鮪魚飯團', '外星人'] }, ctx());
    const m = (r.structuredContent as { matches: { query: string; productId?: string; score: number }[] }).matches;
    expect(m[0]).toMatchObject({ productId: 'P001', score: 1 });
    expect(m[1]).toMatchObject({ productId: 'P005' });
    expect(m[2].productId).toBe('P002');
    expect(m[3].productId).toBeUndefined();
  });
});

describe('inventory_query', () => {
  it('依關鍵字查；建議補貨＝安全庫存－庫存；即期以到期日 ≤ 明天判斷；有圖片才帶網址；附表格提示', () => {
    const r = callStoreTool('inventory_query', { keyword: '御飯糰' }, ctx());
    const items = (r.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items.map((i) => i.productId)).toEqual(['P001', 'P002', 'P003', 'P004']);
    expect(items[0]).toMatchObject({ name: '鮭魚御飯糰', stock: 6, suggested: 24, status: '庫存偏低', expiryDate: '2026-10-05', expiring: false, image: 'https://store.example.com/assets/P001.png' });
    expect(items[1]).toMatchObject({ suggested: 0, status: '正常' });
    expect(items[1]).not.toHaveProperty('image');
    expect(r.display).toMatchObject({ type: 'table', rows: 'items' });
  });

  it('依 productIds 查；沙拉（到期日明天）為即期', () => {
    const r = callStoreTool('inventory_query', { productIds: ['P007'] }, ctx());
    const item = (r.structuredContent as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ productId: 'P007', expiryDate: '2026-10-04', expiring: true });
  });
});

describe('replenishment_create', () => {
  it('建立補貨單並記錄呼叫者', () => {
    const state = createStoreState();
    const r = callStoreTool('replenishment_create', {
      items: [{ productId: 'P001', name: '鮭魚御飯糰', stock: 6, quantity: 24 }],
      arrivalDate: '2026-10-04',
    }, ctx({ state }));
    expect(r.isError).toBeFalsy();
    expect(state.replenishments).toHaveLength(1);
    expect(state.replenishments[0]).toMatchObject({ by: 'kevin', tenantId: 't1', arrivalDate: '2026-10-04' });
    expect((r.structuredContent as { orderId: string }).orderId).toMatch(/^R-/);
  });

  it('拒絕系統呼叫與不存在的商品', () => {
    const sys = callStoreTool('replenishment_create', { items: [{ productId: 'P001', name: 'x', stock: 1, quantity: 1 }], arrivalDate: '2026-10-04' },
      ctx({ caller: { tenantId: '', userId: '', scopes: [], jti: 'j', system: true } }));
    expect(sys.isError).toBe(true);
    const bad = callStoreTool('replenishment_create', { items: [{ productId: 'P999', name: 'x', stock: 1, quantity: 1 }], arrivalDate: '2026-10-04' }, ctx());
    expect(bad.isError).toBe(true);
  });

  it('隱藏的 productId 必須與顯示的名稱、庫存一致', () => {
    const call = (name: string, stock: number) =>
      callStoreTool('replenishment_create', { items: [{ productId: 'P001', name, stock, quantity: 5 }], arrivalDate: '2026-10-04' }, ctx());
    const badName = call('三明治', 6);
    expect(badName.isError).toBe(true);
    expect(badName.text).toBe('品項資料不一致：P001');
    expect(call('鮭魚御飯糰', 99).isError).toBe(true);
    expect(call('鮭魚御飯糰', 6).isError).toBeFalsy();
  });

  it('帶圖片時必須是門市的商品圖網址；不帶也可以', () => {
    const call = (image?: string) =>
      callStoreTool('replenishment_create', {
        items: [{ productId: 'P001', ...(image !== undefined ? { image } : {}), name: '鮭魚御飯糰', stock: 6, quantity: 5 }],
        arrivalDate: '2026-10-04',
      }, ctx());
    expect(call('https://store.example.com/assets/P001.png').isError).toBeFalsy();
    expect(call().isError).toBeFalsy();
    const bad = call('https://evil.example.com/x.png');
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe('品項資料不一致：P001');
  });

  it('輸入不符 schema（數量超過上限）→ isError', () => {
    const r = callStoreTool('replenishment_create', { items: [{ productId: 'P001', name: 'x', stock: 1, quantity: 999 }], arrivalDate: '2026-10-04' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('promotion_list 與 coupon_check', () => {
  it('只列出進行中的活動', () => {
    const r = callStoreTool('promotion_list', {}, ctx());
    const ids = (r.structuredContent as { promotions: { id: string }[] }).promotions.map((p) => p.id);
    expect(ids).toEqual(['PR01', 'PR02', 'PR03', 'PR04']);
    expect(r.display).toMatchObject({ type: 'table', rows: 'promotions' });
  });

  it.each([
    ['COFFEE50', true, '可使用'],
    ['coffee50', true, '可使用'],
    ['SALAD20', false, '已過期'],
    ['BENTO15', false, '已使用'],
    ['MILK5', false, '尚未開始'],
    ['NOPE', false, '查無此券'],
  ])('%s → valid=%s（%s）', (code, valid, reason) => {
    const r = callStoreTool('coupon_check', { code }, ctx());
    expect(r.structuredContent).toMatchObject({ valid, reason });
  });
});
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp } from '../src';

describe('MCP 協定', () => {
  it('tools/list 回原始 schema（含 readOnly）；tools/call 回 structuredContent 與顯示提示', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'ES256', use: 'sig' };
    const verifier = createHyAgentVerifier({ jwksUrl: 'http://x', audience: 'store-demo', fetchJwks: async () => ({ keys: [jwk] }) });
    const { app } = createStoreDemoApp({ verifier, publicBaseUrl: 'http://localhost', now: () => NOW });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const token = () => {
      const iat = Math.floor(Date.now() / 1000);
      const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'hyagent', aud: 'store-demo', sub: 'kevin', tenant: 't1', scopes: [], iat, exp: iat + 60, jti: randomUUID() })}`;
      return `${input}.${sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line ? line.slice(5) : text) as { result: Record<string, unknown> };
    };
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      const list = await rpc('tools/list', {});
      const tools = list.result.tools as { name: string; inputSchema: Record<string, unknown> }[];
      const rep = tools.find((t) => t.name === 'replenishment_create')!;
      expect(JSON.stringify(rep.inputSchema)).toContain('"readOnly":true');
      const call = await rpc('tools/call', { name: 'inventory_query', arguments: { keyword: '御飯糰' } });
      expect((call.result.structuredContent as { items: unknown[] }).items).toHaveLength(4);
      expect((call.result._meta as Record<string, { type: string }>)['hyagent/display'].type).toBe('table');
    } finally {
      server.close();
    }
  });
});
