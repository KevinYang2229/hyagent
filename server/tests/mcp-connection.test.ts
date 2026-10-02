/** MCP 連線：listTools 快取、身分傳遞、結果正規化、逾時不視為斷線、斷線退避、驗證失敗狀態。 */
import net from 'node:net';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { McpConnection, McpToolCallError, isAuthFailure, isConnectionFailure, normalizeToolResult, MCP_RESULT_MAX_CHARS } from '@/modules/mcp/mcp.connection';
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

describe('McpConnection 身分與錯誤分類', () => {
  it('同一條連線同時兩位呼叫者：各自的身分各自送達', async () => {
    conn = new McpConnection(config(fixture.url));
    const c1 = { tenantId: 't1', userId: 'alice', scopes: ['mcp:rooms'] };
    const c2 = { tenantId: 't2', userId: 'bob', scopes: ['mcp:rooms'] };
    await Promise.all([
      conn.callTool('rooms_availability', { date: 'd1', room: 'A' }, c1),
      conn.callTool('rooms_availability', { date: 'd2', room: 'B' }, c2),
    ]);
    const byRoom = (room: string) => fixture.calls.find((c) => (c.args as { room: string }).room === room)!;
    expect(byRoom('A').caller).toMatchObject({ tenantId: 't1', userId: 'alice', system: false });
    expect(byRoom('B').caller).toMatchObject({ tenantId: 't2', userId: 'bob', system: false });
  });

  it('listTools 以系統身分送出，工具呼叫不是系統身分', async () => {
    conn = new McpConnection(config(fixture.url));
    await conn.listTools();
    expect(fixture.requests.some((r) => r.system)).toBe(true);
    await conn.callTool('rooms_availability', { date: 'd', room: 'A' }, caller);
    expect(fixture.calls.every((c) => !c.caller.system)).toBe(true);
    expect(fixture.calls).toHaveLength(1);
  });

  it('工具層 McpError（參數不合）不把 server 標成斷線，後續呼叫仍成功', async () => {
    conn = new McpConnection(config(fixture.url));
    await expect(conn.callTool('rooms_availability', { date: 'd' }, caller)).rejects.toBeInstanceOf(McpToolCallError);
    expect(conn.status().state).toBe('ok');
    expect(conn.status().retryAt).toBeUndefined();
    await expect(conn.callTool('rooms_availability', { date: 'd', room: 'A' }, caller)).resolves.toMatchObject({ room: 'A' });
  });

  it('連線階段逾時（對方收了連線卻不回應）→ unreachable 並設定 retryAt', async () => {
    const sockets: net.Socket[] = [];
    const black = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => black.listen(0, '127.0.0.1', r));
    const { port } = black.address() as net.AddressInfo;
    conn = new McpConnection(config(`http://127.0.0.1:${port}/mcp`), Date.now, 200);
    await expect(conn.callTool('rooms_availability', { date: 'd', room: 'A' }, caller)).rejects.toBeInstanceOf(McpToolCallError);
    expect(conn.status().state).toBe('unreachable');
    expect(conn.status().retryAt).toBeTruthy();
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => black.close(r));
  });

  it('錯誤分類：只看結構，工具文字裡的 403 不會變 auth_failed', () => {
    const { McpError, ErrorCode } = jest.requireActual('@modelcontextprotocol/sdk/types.js');
    const { StreamableHTTPError } = jest.requireActual('@modelcontextprotocol/sdk/client/streamableHttp.js');
    expect(isConnectionFailure(new McpError(ErrorCode.InvalidParams, 'bad'))).toBe(false);
    expect(isConnectionFailure(new McpError(ErrorCode.ConnectionClosed, 'closed'))).toBe(true);
    expect(isConnectionFailure(new StreamableHTTPError(503, 'down'))).toBe(true);
    expect(isConnectionFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isAuthFailure(new StreamableHTTPError(401, 'x'))).toBe(true);
    expect(isAuthFailure(new McpError(ErrorCode.InvalidParams, 'room 403 not found'))).toBe(false);
    expect(isAuthFailure(new Error('room 403'))).toBe(false);
  });
});

describe('normalizeToolResult', () => {
  it('超大 structuredContent 轉為截斷字串', () => {
    const out = normalizeToolResult({ structuredContent: { big: 'y'.repeat(MCP_RESULT_MAX_CHARS) } });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('已截斷');
  });

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
