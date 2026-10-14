import { createHash } from 'node:crypto';
import type { McpRemoteTool } from './mcp.connection';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Bind approval to endpoint and the complete tool definition, including annotations. */
export function mcpToolFingerprint(url: string, tool: McpRemoteTool): string {
  return createHash('sha256').update(canonical({ url, tool })).digest('hex');
}
