/** MCP 連線：listTools 快取、身分傳遞、結果正規化、逾時不視為斷線、斷線退避、驗證失敗狀態。 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { McpConnection, McpToolCallError, normalizeToolResult, MCP_RESULT_MAX_CHARS } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey, mcpJwks } from '@/modules/mcp/mcp.identity';
import type { McpServerConfig } from '@/modules/mcp/mcp.types';
import { startMcpFixture, type McpFixture } from './helpers/mcp-fixture';

function config(url: string, partial: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'rooms', name: '會議室', url, ownerTenantId: null, description: '', keywords: [],
    timeoutMs: 20000, enabled: true, toolOverrides: {}, auth: { mode: 'hyagent-jwt' },
    createdAt: new Date().toISOString(), ...partial,
  };
}

const caller = { tenantId: 't1', userId: 'kevin', scopes: ['mcp:rooms', 'service:agent'] };
let fixture: McpFixture;
let conn: McpConnection | undefined;

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  fixture = await startMcpFixture('rooms', { slowMs: 500 });
});

afterEach(async () => {
  await conn?.close();
  conn = undefined;
  await fixture.close();
  configureMcpSigningKey(null);
});

describe('McpConnection', () => {
  it('listTools：回工具與標註，狀態 ok，第二次走快取', async () => {
    conn = new McpConnection(config(fixture.url));
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['broken_tool', 'rooms_availability', 'rooms_book', 'slow_tool']);
    expect(tools.find((t) => t.name === 'rooms_availability')?.annotations?.readOnlyHint).toBe(true);
    expect(conn.status().state).toBe('ok');
    expect(conn.cachedTools()).toBe(tools);
    expect(await conn.listTools()).toBe(tools);
  });

  it('callTool：身分傳到 MCP server、回 structuredContent', async () => {
    conn = new McpConnection(config(fixture.url));
    const out = await conn.callTool('rooms_availability', { date: '2026-10-03', room: 'A' }, caller);
    expect(out).toEqual({ room: 'A', date: '2026-10-03', free: ['14:00-16:00'] });
    expect(fixture.calls[0].caller).toMatchObject({ tenantId: 't1', userId: 'kevin', scopes: ['mcp:rooms'], system: false });
  });

  it('工具回 isError → McpToolCallError，連線狀態仍 ok', async () => {
    conn = new McpConnection(config(fixture.url));
    await expect(conn.callTool('broken_tool', {}, caller)).rejects.toThrow('下游系統錯誤');
    expect(conn.status().state).toBe('ok');
  });

  it('逾時 → McpToolCallError，但不把 server 標成斷線', async () => {
    conn = new McpConnection(config(fixture.url, { timeoutMs: 100 }));
    await conn.listTools(); // 先建立正常連線，狀態才會是 ok
    await expect(conn.callTool('slow_tool', {}, caller)).rejects.toBeInstanceOf(McpToolCallError);
    expect(conn.status().state).toBe('ok');
  });

  it('server 關閉 → unreachable、設定 retryAt、退避期間快速失敗且不暴露工具', async () => {
    conn = new McpConnection(config(fixture.url));
    await conn.listTools();
    await fixture.close();
    await conn.close();
    await expect(conn.listTools({ force: true })).rejects.toBeTruthy();
    const st = conn.status();
    expect(st.state).toBe('unreachable');
    expect(st.retryAt).toBeTruthy();
    expect(conn.cachedTools()).toBeUndefined();
    await expect(conn.listTools()).rejects.toThrow('暫時無法連線');
    fixture = await startMcpFixture('rooms');
  });

  it('MCP 端只認得舊公鑰（後端已換鑰）→ auth_failed', async () => {
    await fixture.close();
    const staleJwks = mcpJwks(); // beforeEach 那把的公鑰
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem); // 後端換成新鑰
    fixture = await startMcpFixture('rooms', { jwks: () => staleJwks });
    conn = new McpConnection(config(fixture.url));
    await expect(conn.listTools()).rejects.toBeTruthy();
    expect(conn.status().state).toBe('auth_failed');
  });
});

describe('normalizeToolResult', () => {
  it('優先 structuredContent，否則串接 text', () => {
    expect(normalizeToolResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(normalizeToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  });

  it('超過上限截斷並註明', () => {
    const out = normalizeToolResult({ content: [{ type: 'text', text: 'x'.repeat(MCP_RESULT_MAX_CHARS + 10) }] }) as string;
    expect(out.startsWith('x'.repeat(MCP_RESULT_MAX_CHARS))).toBe(true);
    expect(out).toContain('已截斷');
  });
});
