import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createDbIntelligenceApp } from '../src/app';
import { MemoryAuditSink } from '../src/audit';
import { MemoryCatalogStore } from '../src/catalog/store';
import type { QueryExecutor } from '../src/query/executor';
import { DbIntelligenceService, directoryResolver } from '../src/service';
import { demoCatalog, demoConfig, now } from './fixtures';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(sub: string, tenant: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'hyagent', aud: 'db-intelligence', sub, tenant, scopes: [], iat, exp: iat + 60, jti: randomUUID() })}`;
  return `${input}.${sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

let server: Server;
let url: string;
const executor: QueryExecutor = { execute: async () => { throw new Error('不應執行'); } };

beforeAll(async () => {
  const catalogs = new MemoryCatalogStore();
  await catalogs.save(demoCatalog());
  const app = createDbIntelligenceApp({
    verifier: createHyAgentVerifier({ jwksUrl: 'http://x', audience: 'db-intelligence', fetchJwks: async () => ({ keys: [jwk] }) }),
    service: new DbIntelligenceService({
      dataSources: () => demoConfig.dataSources,
      catalogs,
      policies: () => demoConfig.policies,
      principals: directoryResolver(demoConfig.principals),
      executor,
      audit: new MemoryAuditSink(),
      now,
    }),
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
});

async function rpc(method: string, params: unknown, auth?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, body: JSON.parse(data ? data.slice(6) : text) };
}

describe('MCP HTTP app', () => {
  it('沒有 HyAgent JWT → 401', async () => {
    expect((await rpc('tools/list', {})).status).toBe(401);
  });

  it('tools/list：四個唯讀工具，附 JSON Schema', async () => {
    const { body } = await rpc('tools/list', {}, `Bearer ${token('alice', 'demo')}`);
    const tools = body.result.tools as { name: string; annotations: unknown; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(['search_schema', 'get_dataset_details', 'execute_safe_query', 'get_query_result']);
    expect(tools.every((t) => (t.annotations as { readOnlyHint: boolean }).readOnlyHint && t.inputSchema.type === 'object')).toBe(true);
  });

  it('tools/call：身分取自 JWT，alice 看不到薪資資料集', async () => {
    const { body } = await rpc('tools/call', { name: 'search_schema', arguments: { question: '薪資' } }, `Bearer ${token('alice', 'demo')}`);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.datasets.map((d: { dataset: string }) => d.dataset)).not.toContain('employee_salary');
  });

  it('tools/call：拒絕以規格書錯誤格式回傳', async () => {
    const { body } = await rpc(
      'tools/call',
      { name: 'execute_safe_query', arguments: { query_plan: { version: '1.0', data_source_id: 'ds_project_01', dataset: 'employee_salary', select: [{ field: 'salary' }] } } },
      `Bearer ${token('alice', 'demo')}`,
    );
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe('QUERY_POLICY_DENIED');
  });
});
