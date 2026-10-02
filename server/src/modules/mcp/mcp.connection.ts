/**
 * MCP 連線：每個 server 一條，延遲建立、跨租戶共用（身分在請求上、不在連線上）。
 *
 * 身分：用 AsyncLocalStorage 把當次呼叫者帶進 transport 的自訂 fetch，每個 HTTP 請求
 * 都以當下呼叫者簽一張新的 JWT（listTools 等系統呼叫用 'system'）。
 * 故障：連線層錯誤標 unreachable／auth_failed 並指數退避，退避期間該 server 的工具不暴露；
 * 單一工具逾時或回 isError 不影響 server 狀態。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@/lib/logger';
import { signMcpToken, type McpCaller } from './mcp.identity';
import type { McpServerConfig } from './mcp.types';

export const MCP_TOOLS_TTL_MS = 10 * 60 * 1000;
export const MCP_LIST_TIMEOUT_MS = 10_000;
export const MCP_RESULT_MAX_CHARS = 16_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type McpConnectionState = 'idle' | 'ok' | 'unreachable' | 'auth_failed';

export interface McpServerStatus {
  state: McpConnectionState;
  lastError?: string;
  lastOkAt?: string;
  toolsFetchedAt?: string;
  retryAt?: string;
}

export class McpToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolCallError';
  }
}

const callerStore = new AsyncLocalStorage<McpCaller | 'system'>();

function truncateText(s: string): string {
  return s.length > MCP_RESULT_MAX_CHARS ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…（結果過長，已截斷）` : s;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: unknown })?.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export function normalizeToolResult(res: { structuredContent?: unknown; content?: unknown }): unknown {
  if (res.structuredContent !== undefined) {
    const s = JSON.stringify(res.structuredContent);
    return s.length > MCP_RESULT_MAX_CHARS ? truncateText(s) : res.structuredContent;
  }
  return truncateText(textOf(res.content));
}

function isTimeout(err: unknown): boolean {
  return (err as { code?: unknown }).code === ErrorCode.RequestTimeout;
}

function isAuthFailure(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  const e = err as Error;
  return code === 401 || code === 403 || e?.name === 'UnauthorizedError' || /\b(401|403)\b/.test(String(e?.message));
}

export class McpConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: McpRemoteTool[] | undefined;
  private toolsAt = 0;
  private failures = 0;
  private st: McpServerStatus = { state: 'idle' };

  constructor(
    public config: McpServerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  status(): McpServerStatus {
    return { ...this.st };
  }

  /** 只有連線正常時回快取；斷線或退避中回 undefined（工具暫不暴露）。 */
  cachedTools(): McpRemoteTool[] | undefined {
    return this.st.state === 'ok' ? this.tools : undefined;
  }

  async listTools(opts: { force?: boolean } = {}): Promise<McpRemoteTool[]> {
    if (!opts.force) {
      if (this.tools && this.st.state === 'ok' && this.now() - this.toolsAt < MCP_TOOLS_TTL_MS) return this.tools;
      this.assertNotBackingOff();
    }
    try {
      const client = await this.ensureClient();
      const res = await callerStore.run('system', () => client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS }));
      this.tools = res.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations,
      }));
      this.toolsAt = this.now();
      this.markOk();
      this.st.toolsFetchedAt = new Date(this.toolsAt).toISOString();
      return this.tools;
    } catch (err) {
      await this.markFailed(err);
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, caller: McpCaller): Promise<unknown> {
    this.assertNotBackingOff();
    let res: { isError?: boolean; structuredContent?: unknown; content?: unknown };
    try {
      const client = await this.ensureClient();
      // SDK 回傳型別含舊版相容的 { toolResult } 分支，這裡只取現行欄位
      res = (await callerStore.run(caller, () =>
        client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs }),
      )) as typeof res;
      this.markOk();
    } catch (err) {
      if (isTimeout(err)) throw new McpToolCallError(`${this.config.name} 回應逾時，請稍後再試`);
      await this.markFailed(err);
      throw new McpToolCallError(`${this.config.name} 暫時無法使用：${(err as Error).message}`);
    }
    if (res.isError) throw new McpToolCallError(textOf(res.content) || `${this.config.name} 回傳錯誤`);
    return normalizeToolResult(res);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }

  private assertNotBackingOff(): void {
    if (this.st.retryAt && this.now() < Date.parse(this.st.retryAt)) {
      throw new McpToolCallError(`${this.config.name} 暫時無法連線`);
    }
  }

  private readonly signedFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${signMcpToken(this.config.id, callerStore.getStore() ?? 'system')}`);
    return fetch(url, { ...init, headers });
  };

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: 'hyagent', version: '1.2.0' });
        const transport = new StreamableHTTPClientTransport(new URL(this.config.url), { fetch: this.signedFetch });
        await callerStore.run('system', () => client.connect(transport, { timeout: MCP_LIST_TIMEOUT_MS }));
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private markOk(): void {
    this.failures = 0;
    this.st = { ...this.st, state: 'ok', lastOkAt: new Date(this.now()).toISOString(), lastError: undefined, retryAt: undefined };
  }

  private async markFailed(err: unknown): Promise<void> {
    this.failures += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.st = {
      ...this.st,
      state: isAuthFailure(err) ? 'auth_failed' : 'unreachable',
      lastError: (err as Error).message,
      retryAt: new Date(this.now() + delay).toISOString(),
    };
    logger.warn({ err, serverId: this.config.id, state: this.st.state }, 'mcp server call failed');
    await this.close();
  }
}

const pool = new Map<string, McpConnection>();

export const mcpConnections = {
  /** 取得連線；URL 或逾時變更時重建，其餘欄位（名稱、覆寫）就地更新。 */
  get(config: McpServerConfig): McpConnection {
    const cur = pool.get(config.id);
    if (cur && cur.config.url === config.url && cur.config.timeoutMs === config.timeoutMs) {
      cur.config = config;
      return cur;
    }
    if (cur) void cur.close();
    const next = new McpConnection(config);
    pool.set(config.id, next);
    return next;
  },
  peek(id: string): McpConnection | undefined {
    return pool.get(id);
  },
  async drop(id: string): Promise<void> {
    const c = pool.get(id);
    pool.delete(id);
    await c?.close();
  },
  async closeAll(): Promise<void> {
    await Promise.all([...pool.keys()].map((id) => this.drop(id)));
  },
};
