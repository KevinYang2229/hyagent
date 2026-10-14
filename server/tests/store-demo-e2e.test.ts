/**
 * 端到端：真實的門市 Demo MCP 服務（JWT 驗章）＋ agent ＋ 確認流程 ＋ 影像辨識（假 LLM）。
 */
const llmCreate = jest.fn();
jest.mock('@/lib/llm', () => {
  const actual = jest.requireActual('@/lib/llm');
  return { ...actual, getLLMProvider: () => ({ name: 'fake', createMessage: llmCreate }) };
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp, type StoreState } from '@hyagent/store-demo';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { conversationService } from '@/modules/conversation/conversation.service';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { mcpToolFingerprint } from '@/modules/mcp/mcp.fingerprint';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey, mcpJwks } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { analyzeShelf } from '@/modules/vision/vision.service';
import { tenantStore } from '@/modules/tenant/tenant.store';

const usage = { inputTokens: 1, outputTokens: 1 };
const res = (p: Record<string, unknown>) => ({ text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform', ...p });

let http: Server;
let store: StoreState;
let tenantId: string;

beforeEach(async () => {
  llmCreate.mockReset();
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  const verifier = createHyAgentVerifier({ jwksUrl: 'http://unused', audience: 'store-demo', fetchJwks: async () => mcpJwks() as never, rejectReplay: true });
  const created = createStoreDemoApp({ verifier, publicBaseUrl: 'http://localhost' });
  store = created.store;
  http = await new Promise((r) => { const s = created.app.listen(0, '127.0.0.1', () => r(s)); });
  const { port } = http.address() as AddressInfo;
  const t = tenantStore.createTenant(`store-e2e-${Date.now()}`);
  tenantId = t.id;
  tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });
  scopePolicy.setPolicy(tenantId, { groups: {}, accounts: { kevin: ['mcp:store-demo'] } });
  mcpStore.create({ id: 'store-demo', name: '門市', url: `http://127.0.0.1:${port}/mcp`, ownerTenantId: tenantId, description: '門市庫存與補貨',
    toolOverrides: Object.fromEntries(
      ['product_lookup', 'inventory_query', 'promotion_list', 'coupon_check', 'store_today_summary', 'replenishment_list'].map((n) => [n, { approvedReadOnly: true }]),
    ),
  });
  const config = mcpStore.get('store-demo')!;
  const tools = await mcpConnections.get(config).listTools();
  mcpStore.update(config.id, { toolOverrides: Object.fromEntries(
    Object.keys(config.toolOverrides).map((name) => [name, { approvedReadOnly: true, approvedFingerprint: mcpToolFingerprint(config.url, tools.find((t) => t.name === name)!) }]),
  ) });
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); });
  mcpStore.clear();
  scopePolicy.clear();
  configureMcpSigningKey(null);
});

it('問庫存 → 回覆帶表格（資料來自門市服務）', async () => {
  llmCreate
    .mockResolvedValueOnce(res({ toolCalls: [{ id: 't1', name: 'mcp_store-demo_inventory_query', input: { keyword: '御飯糰' } }], stopReason: 'tool_use' }))
    .mockResolvedValueOnce(res({ text: '鮭魚與明太子御飯糰庫存偏低。' }));
  const s = { id: 's1', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting', activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: '查御飯糰庫存' }] }], createdAt: new Date().toISOString() } as unknown as Session;
  const out = await agentAgentService.handleTurn(s, '查御飯糰庫存', { name: 'fake', createMessage: llmCreate });
  expect(out.blocks?.[0]).toMatchObject({ type: 'table', title: '商品庫存' });
  expect(out.blocks?.[0].rows[0]).toMatchObject({ name: '鮭魚御飯糰', stock: 6, suggested: 24, status: '庫存偏低' });
});

it('貨架辨識 → 提議補貨單 → 改數量、刪一列後確認 → 門市服務收到修改後的補貨單', async () => {
  llmCreate.mockResolvedValueOnce(res({
    toolCalls: [{ id: 'r1', name: 'report_shelf', input: { items: [
      { name: '鮭魚御飯糰', status: 'out_of_stock', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } },
      { name: '火腿蛋三明治', status: 'out_of_stock', box: { x: 0.3, y: 0.1, w: 0.1, h: 0.1 } },
      { name: '和風雞肉沙拉', status: 'ok', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ] } }],
    stopReason: 'tool_use',
  }));
  const shelf = await analyzeShelf({ tenantId, userId: 'kevin' }, { mediaType: 'image/png', data: Buffer.from('x') });
  expect(shelf.counts).toEqual({ outOfStock: 2, expiring: 1, misplaced: 0 });
  expect(shelf.replenishment!.input.items).toHaveLength(2);

  const conv = conversationStore.create(tenantId, 'kevin', '');
  conversationStore.save(conv);
  const { pendingAction } = await conversationService.proposeAction(tenantId, 'kevin', conv.id, shelf.replenishment!.toolId, shelf.replenishment!.input);
  expect(pendingAction.form?.fields[0]).toMatchObject({ kind: 'table', selectable: true });

  const items = shelf.replenishment!.input.items as Record<string, unknown>[];
  const edited = { ...shelf.replenishment!.input, items: [{ ...items[0], quantity: 30 }] };
  const done = await conversationService.confirmAction(tenantId, 'kevin', conv.id, pendingAction.id, edited);
  expect(done.actionOk).toBe(true);
  expect(store.replenishments).toHaveLength(1);
  expect(store.replenishments[0]).toMatchObject({ by: 'kevin', tenantId });
  expect(store.replenishments[0].items).toEqual([expect.objectContaining({ productId: 'P001', quantity: 30 })]);
});
