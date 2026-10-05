/** Agent 回覆帶表格：LLM 只拿到資料（含附註），表格進 blocks；壞的顯示提示不影響回覆。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { registerTool, toolOutput } from '@/modules/tools';
import { TABLE_SHOWN_NOTE } from '@/modules/display/display-block';
import { tenantStore } from '@/modules/tenant/tenant.store';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform', ...partial };
}
function scripted(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

const items = [{ name: '鮭魚御飯糰', stock: 6 }, { name: '鮪魚御飯糰', stock: 12 }];
const goodDisplay = { type: 'table', title: '庫存', rows: 'items', columns: [{ key: 'name', label: '商品' }, { key: 'stock', label: '庫存', unit: '個' }] };

registerTool({
  id: 'test.stockTable',
  description: '查庫存（測試）',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => toolOutput({ items }, goodDisplay),
});
registerTool({
  id: 'test.badDisplay',
  description: '壞的顯示提示（測試）',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => toolOutput({ items }, { type: 'chart' }),
});

function session(tenantId: string): Session {
  return {
    id: 's-blocks', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting',
    activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: '查庫存' }] }],
    createdAt: new Date().toISOString(),
  };
}

function toolResult(s: Session): Record<string, unknown> {
  const b = s.messages.flatMap((m) => m.content).find((x) => x.type === 'tool_result') as { content: string };
  return JSON.parse(b.content) as Record<string, unknown>;
}

describe('Agent 表格區塊', () => {
  it('顯示提示合法 → blocks 有表格；LLM 拿到資料與附註、看不到顯示提示', async () => {
    const t = tenantStore.createTenant('agent-blocks-ok');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
    const s = session(t.id);
    const out = await agentAgentService.handleTurn(s, '查庫存', scripted([
      res({ toolCalls: [{ id: 't1', name: 'test_stockTable', input: {} }], stopReason: 'tool_use' }),
      res({ text: '鮭魚御飯糰庫存偏低。' }),
    ]));
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks![0]).toMatchObject({ type: 'table', title: '庫存', rows: [{ name: '鮭魚御飯糰', stock: 6 }, { name: '鮪魚御飯糰', stock: 12 }] });
    const tr = toolResult(s);
    expect(tr.result).toEqual({ items });
    expect(tr.note).toBe(TABLE_SHOWN_NOTE);
    expect(JSON.stringify(tr)).not.toContain('columns');
  });

  it('顯示提示不合法 → 沒有 blocks、沒有附註，回覆照常', async () => {
    const t = tenantStore.createTenant('agent-blocks-bad');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
    const s = session(t.id);
    const out = await agentAgentService.handleTurn(s, '查庫存', scripted([
      res({ toolCalls: [{ id: 't1', name: 'test_badDisplay', input: {} }], stopReason: 'tool_use' }),
      res({ text: '好的。' }),
    ]));
    expect(out.blocks).toBeUndefined();
    expect(out.reply).toBe('好的。');
    expect(toolResult(s).note).toBeUndefined();
    expect(toolResult(s).result).toEqual({ items });
  });
});
