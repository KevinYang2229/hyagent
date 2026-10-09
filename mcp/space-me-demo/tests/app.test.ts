import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createSpaceMeDemoApp } from '../src';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(audience = 'space-me-demo', system = false) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'test' })}.${b64({ iss: 'hyagent', aud: audience, sub: system ? 'hyagent-system' : 'u1', tenant: 't1', scopes: [], iat, exp: iat + 60, jti: randomUUID() })}`;
  return `${payload}.${sign('SHA256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
let httpServer: Server;
let url: string;
beforeEach(async () => {
  const verifier = createHyAgentVerifier({ jwksUrl: 'http://test.invalid', audience: 'space-me-demo', rejectReplay: true, fetchJwks: async () => ({ keys: [jwk] }) });
  const app = createSpaceMeDemoApp({ verifier, now: () => new Date('2026-10-10T10:00:00+08:00') });
  httpServer = await new Promise<Server>((resolve, reject) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.once('error', reject); });
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterEach(async () => { if (!httpServer) return; httpServer.closeAllConnections(); await new Promise<void>((resolve) => httpServer.close(() => resolve())); });
async function post(method: string, params: unknown, auth = `Bearer ${token()}`) {
  return fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function rpc(method: string, params: unknown, auth?: string) {
  const response = await post(method, params, auth);
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}

describe('SpaceMe Streamable HTTP MCP', () => {
  it('健康檢查正常；無 token、錯誤 audience 與重播 JWT 都拒絕', async () => {
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    expect((await post('tools/list', {}, '')).status).toBe(401);
    expect((await post('tools/list', {}, `Bearer ${token('other')}`)).status).toBe(401);
    const auth = `Bearer ${token()}`;
    await rpc('tools/list', {}, auth);
    expect((await post('tools/list', {}, auth)).status).toBe(401);
  });

  it('可初始化、列出四個唯讀工具，並在無狀態請求取得表格結果', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('space-me-demo');
    const listed = await rpc('tools/list', {}, `Bearer ${token('space-me-demo', true)}`);
    expect(listed.result.tools).toHaveLength(4);
    for (const tool of listed.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      const called = await rpc('tools/call', { name: tool.name, arguments: {} });
      expect(called.result.isError).not.toBe(true);
      expect(called.result.structuredContent).toMatchObject({ source: 'demo', isDemo: true, timeZone: 'Asia/Taipei' });
      expect(called.result._meta['hyagent/display']).toMatchObject({ type: 'table', rows: 'items' });
    }
  });

  it('HTTP 工具呼叫也驗證參數與使用者身分', async () => {
    const invalid = await rpc('tools/call', { name: 'spaceme_space_status', arguments: { status: 'bogus' } });
    expect(invalid.result.isError).toBe(true);
    const tenantOverride = await rpc('tools/call', { name: 'spaceme_realtime_overview', arguments: { tenantId: 'other' } });
    expect(tenantOverride.result.isError).toBe(true);
    const system = await rpc('tools/call', { name: 'spaceme_environment', arguments: {} }, `Bearer ${token('space-me-demo', true)}`);
    expect(system.result.isError).toBe(true);
  });
});
