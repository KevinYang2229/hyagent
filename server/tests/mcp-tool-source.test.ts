/** MCP 工具來源：讀寫判定、命名、覆寫、租戶隔離、scope 目錄、agent 意圖。 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { assertGrantableScopes, tenantGrantableScopes } from '@/modules/authz/scope-catalog';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { mcpConnections, type McpConnection, type McpRemoteTool } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { describeServerTools, effectForTool, mcpToolSource, toToolDef } from '@/modules/mcp/mcp.tool-source';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { toolRegistry } from '@/modules/tools';

const read: McpRemoteTool = { name: 'rooms_availability', title: '查空檔', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { date: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const write: McpRemoteTool = { name: 'rooms_book', title: '預約會議室', inputSchema: { type: 'object', properties: { room: { type: 'string' } } } };

function stubConnection(tools: McpRemoteTool[]): McpConnection {
  return {
    cachedTools: () => tools,
    status: () => ({ state: 'ok', toolsFetchedAt: 'fixed' }),
    listTools: async () => tools,
    callTool: jest.fn(async () => ({ ok: true })),
  } as unknown as McpConnection;
}

beforeEach(() => configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem));
afterEach(() => {
  scopePolicy.clear();
  mcpStore.clear();
  configureMcpSigningKey(null);
  jest.restoreAllMocks();
});

describe('讀寫判定與轉換', () => {
  it('readOnlyHint=true → read；未標 → write；requireConfirm 覆寫 → write', () => {
    expect(effectForTool(read)).toBe('read');
    expect(effectForTool(write)).toBe('write');
    expect(effectForTool(read, { requireConfirm: true })).toBe('write');
  });

  it('toToolDef：id、scope、標題、移除 $schema；停用回 undefined', () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp', toolOverrides: { rooms_book: { cardTitle: '確認預約' } } });
    const conn = stubConnection([]);
    const def = toToolDef(config, write, conn)!;
    expect(def).toMatchObject({ id: 'mcp.rooms.rooms_book', scopes: ['mcp:rooms'], effect: 'write', agentExposed: true, confirmTitle: '確認預約', audit: true });
    expect(toToolDef(config, read, conn)!.inputSchema.$schema).toBeUndefined();
    const disabled = mcpStore.update('rooms', { toolOverrides: { rooms_book: { disabled: true } } });
    expect(toToolDef(disabled, write, conn)).toBeUndefined();
  });

  it('工具名不合法或過長 → 不暴露，describeServerTools 標 name_invalid', () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const bad: McpRemoteTool = { name: 'has space', inputSchema: { type: 'object' } };
    const long: McpRemoteTool = { name: 'x'.repeat(60), inputSchema: { type: 'object' } };
    expect(toToolDef(config, bad, stubConnection([]))).toBeUndefined();
    expect(toToolDef(config, long, stubConnection([]))).toBeUndefined();
    const rows = describeServerTools(config, [read, bad]);
    expect(rows[0]).toMatchObject({ name: 'rooms_availability', llmName: 'mcp_rooms_rooms_availability', effect: 'read', disabled: false });
    expect(rows[1].problem).toBe('name_invalid');
  });

  it('handler 帶呼叫者身分呼叫 connection', async () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const conn = stubConnection([]);
    await toToolDef(config, read, conn)!.handler({ date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
    expect(conn.callTool).toHaveBeenCalledWith('rooms_availability', { date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
  });
});

describe('租戶隔離', () => {
  it('專屬 server 只對擁有租戶且有 scope 者出現', () => {
    mcpStore.create({ id: 'only-a', name: 'A 專屬', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    const ids = (tenantId: string, scopes: string[]) => mcpToolSource.toolsFor({ tenantId, userId: 'u', scopes }).map((t) => t.id);
    expect(ids('tenant-a', ['mcp:only-a'])).toEqual(['mcp.only-a.rooms_availability']);
    expect(ids('tenant-a', [])).toEqual([]);
    expect(ids('tenant-b', ['mcp:only-a'])).toEqual([]);
  });

  it('scope 目錄：專屬 server 只列給擁有租戶；他租戶授予直接拒絕', () => {
    const a = tenantStore.createTenant('mcp-scope-a');
    const b = tenantStore.createTenant('mcp-scope-b');
    mcpStore.create({ id: 'only-a', name: 'A 專屬', url: 'http://a/mcp', ownerTenantId: a.id });
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    expect(tenantGrantableScopes(a.id).map((s) => s.id)).toEqual(expect.arrayContaining(['mcp:only-a', 'mcp:shared']));
    expect(tenantGrantableScopes(b.id).map((s) => s.id)).not.toContain('mcp:only-a');
    expect(() => assertGrantableScopes(['mcp:only-a'], a.id)).not.toThrow();
    expect(() => assertGrantableScopes(['mcp:only-a'], b.id)).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => assertGrantableScopes(['mcp:none'], a.id)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('未設簽章金鑰 → 沒有任何 MCP 工具', () => {
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    configureMcpSigningKey(null);
    expect(mcpToolSource.toolsFor({ tenantId: 't', userId: 'u', scopes: ['mcp:shared'] })).toEqual([]);
  });
});

describe('registry 整合與 agent 意圖', () => {
  it('來源已註冊：availableFor 看得到 MCP 工具', () => {
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    const names = toolRegistry.availableFor({ tenantId: 't', userId: 'u', scopes: ['mcp:shared'] }).map((t) => t.name);
    expect(names).toContain('mcp.shared.rooms_availability');
  });

  it('agent intents 帶入使用者有權限的 MCP server 描述與關鍵字', () => {
    const t = tenantStore.createTenant('mcp-intents');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
    scopePolicy.setPolicy(t.id, { groups: {}, accounts: { kevin: ['mcp:rooms'] } });
    mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://r/mcp', description: '查詢與預約會議室', keywords: ['會議室', '預約'] });
    mcpStore.create({ id: 'erp', name: 'ERP', url: 'http://e/mcp', description: '查庫存', keywords: ['庫存'] });
    const session = { tenantId: t.id, userId: 'kevin' } as Session;
    const intents = agentAgentService.intents(session);
    expect(intents).toContainEqual({ id: 'agent.mcp.rooms', keywords: ['會議室', '預約'], description: '查詢與預約會議室' });
    expect(intents.map((i) => i.id)).not.toContain('agent.mcp.erp');
  });
});
