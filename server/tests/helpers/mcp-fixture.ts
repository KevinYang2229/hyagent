/**
 * 測試用 MCP server：以 @hyagent/mcp-kit 組成，用後端自己的 JWKS 驗章（不走網路抓 JWKS）。
 * 記錄每次呼叫的工具、參數與呼叫者，供斷言「身分有傳到」「寫入只在確認後發生」。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { callerFrom, createHyAgentVerifier, createMcpHttpApp, type HyAgentCaller } from '@hyagent/mcp-kit';
import { mcpJwks } from '@/modules/mcp/mcp.identity';

export interface McpFixture {
  url: string;
  calls: { tool: string; args: unknown; caller: HyAgentCaller }[];
  bookings: { room: string; caller: HyAgentCaller }[];
  close(): Promise<void>;
}

export async function startMcpFixture(
  serverId: string,
  opts: { slowMs?: number; jwks?: () => { keys: Record<string, unknown>[] } } = {},
): Promise<McpFixture> {
  const calls: McpFixture['calls'] = [];
  const bookings: McpFixture['bookings'] = [];
  const verifier = createHyAgentVerifier({
    jwksUrl: 'http://unused.invalid/jwks',
    audience: serverId,
    fetchJwks: async () => (opts.jwks ?? mcpJwks)(),
    rejectReplay: true,
  });
  const app = createMcpHttpApp({
    name: `fixture-${serverId}`,
    version: '0.0.1',
    verifier,
    register(server) {
      server.registerTool(
        'rooms_availability',
        {
          title: '查詢會議室空檔',
          description: '查詢某會議室某日是否有空',
          inputSchema: { date: z.string().describe('日期'), room: z.string().describe('會議室') },
          annotations: { readOnlyHint: true },
        },
        async (args, extra) => {
          calls.push({ tool: 'rooms_availability', args, caller: callerFrom(extra) });
          const data = { room: args.room, date: args.date, free: ['14:00-16:00'] };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        },
      );
      server.registerTool(
        'rooms_book',
        {
          title: '預約會議室',
          description: '預約會議室',
          inputSchema: { room: z.string().describe('會議室'), date: z.string().describe('日期') },
        },
        async (args, extra) => {
          const caller = callerFrom(extra);
          calls.push({ tool: 'rooms_book', args, caller });
          bookings.push({ room: args.room, caller });
          const data = { bookingId: `B-${bookings.length}` };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        },
      );
      server.registerTool(
        'slow_tool',
        { description: '很慢的工具', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, opts.slowMs ?? 0));
          return { content: [{ type: 'text', text: 'done' }] };
        },
      );
      server.registerTool(
        'broken_tool',
        { description: '一定失敗', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => ({ isError: true, content: [{ type: 'text', text: '下游系統錯誤' }] }),
      );
    },
  });
  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    bookings,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
