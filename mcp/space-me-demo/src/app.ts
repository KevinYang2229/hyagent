import { callerFrom, createMcpHttpApp, type HyAgentVerifier } from '@hyagent/mcp-kit';
import { createDemoSource, type RealtimeSource } from './data';
import { callRealtimeTool, DESCRIPTIONS, INPUTS, TITLES, type ToolName } from './tools';

export interface SpaceMeDemoOptions {
  verifier: HyAgentVerifier;
  source?: RealtimeSource;
  now?: () => Date;
}
export function createSpaceMeDemoApp(options: SpaceMeDemoOptions) {
  const source = options.source ?? createDemoSource();
  const now = options.now ?? (() => new Date());
  return createMcpHttpApp({
    name: 'space-me-demo', version: '0.1.0', verifier: options.verifier,
    register(server) {
      for (const name of Object.keys(INPUTS) as ToolName[]) {
        server.registerTool(name, {
          title: TITLES[name], description: DESCRIPTIONS[name], inputSchema: INPUTS[name],
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: options.source !== undefined },
        }, async (args: Record<string, unknown>, extra: Parameters<typeof callerFrom>[0]) => callRealtimeTool(name, args, { source, now: now(), caller: callerFrom(extra) }));
      }
    },
  });
}
