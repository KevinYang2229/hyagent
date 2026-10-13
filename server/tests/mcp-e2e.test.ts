/**
 * 端到端：假 LLM 依劇本呼叫 MCP 工具，走真正的 agent、registry、MCP 連線、JWT 與 kit 驗章。
 *  - 讀取：直接執行，MCP 端收到正確身分。
 *  - 寫入：只建確認卡片，MCP 端沒有任何寫入；確認後才寫入，身分正確。
 *  - MCP server 掛掉：這一輪照常完成，LLM 收到錯誤字串。
 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { runConfirmedAction } from '@/modules/conversation/pending-action.service';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { startMcpFixture, type McpFixture } from './helpers/mcp-fixture';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...partial };
}
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

let fixture: McpFixture;
let tenantId: string;

function session(): Session {
  return {
    id: 's-mcp', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting',
    activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    createdAt: new Date().toISOString(),
  };
}

function toolResults(s: Session): string[] {
  return s.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b as { content: string }).content);
}

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  fixture = await startMcpFixture('rooms-e2e');
  const t = tenantStore.createTenant(`mcp-e2e-${Date.now()}`);
  tenantId = t.id;
  tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });
  scopePolicy.setPolicy(tenantId, { groups: {}, accounts: { kevin: ['mcp:rooms-e2e'] } });
  mcpStore.create({ id: 'rooms-e2e', name: '會議室', url: fixture.url, ownerTenantId: tenantId, description: '查詢與預約會議室', toolOverrides: { rooms_availability: { approvedReadOnly: true } } });
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await fixture.close();
  mcpStore.clear();
  scopePolicy.clear();
  configureMcpSigningKey(null);
});

describe('MCP 端到端', () => {
  it('讀取：直接執行，MCP 端收到使用者身分', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_availability', input: { date: '2026-10-04', room: 'A' } }], stopReason: 'tool_use' }),
      res({ text: 'A 會議室 14:00-16:00 有空。' }),
    ]);
    const s = session();
    const out = await agentAgentService.handleTurn(s, '明天 A 會議室有空嗎', llm);

    expect(out.reply).toContain('14:00-16:00');
    expect(out.pendingAction).toBeUndefined();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].caller).toMatchObject({ tenantId, userId: 'kevin', scopes: ['mcp:rooms-e2e'] });
    expect(toolResults(s)[0]).toContain('"free":["14:00-16:00"]');
  });

  it('寫入：先只建卡片；確認後才寫入，身分正確', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_book', input: { room: 'A', date: '2026-10-04' } }], stopReason: 'tool_use' }),
      res({ text: '將為你預約 A 會議室，請確認。' }),
    ]);
    const s = session();
    const out = await agentAgentService.handleTurn(s, '幫我訂明天的 A 會議室', llm);

    expect(fixture.bookings).toHaveLength(0);
    const results = toolResults(s);
    expect(results).toHaveLength(1);
    const feedback = JSON.parse(results[0]);
    expect(feedback.ok).toBe(true);
    expect(feedback.proposed).toBe(true);
    expect(feedback.card.title).toBe('預約會議室');
    expect(out.pendingAction?.summary).toEqual({
      title: '預約會議室',
      fields: [{ label: '會議室', value: 'A' }, { label: '日期', value: '2026-10-04' }],
    });

    const action = s.pendingAction!;
    s.pendingAction = undefined;
    const outcome = await runConfirmedAction(s, action);
    expect(outcome.ok).toBe(true);
    expect(fixture.bookings).toHaveLength(1);
    expect(fixture.bookings[0].caller).toMatchObject({ tenantId, userId: 'kevin' });
  });

  it('MCP server 掛掉：這一輪照常完成，LLM 收到錯誤', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_availability', input: { date: '2026-10-04', room: 'A' } }], stopReason: 'tool_use' }),
      res({ text: '會議室系統暫時無法使用。' }),
    ]);
    const s = session();
    // 先讓連線快取工具，再關掉 server
    await agentAgentService.handleTurn(session(), 'warm up', scriptedLLM([res({ text: 'ok' })]));
    await fixture.close();
    await mcpConnections.peek('rooms-e2e')?.close();

    const out = await agentAgentService.handleTurn(s, '明天 A 會議室有空嗎', llm);
    expect(out.reply).toBe('會議室系統暫時無法使用。');
    expect(JSON.parse(toolResults(s)[0]).ok).toBe(false);
    fixture = await startMcpFixture('rooms-e2e');
  });
});
