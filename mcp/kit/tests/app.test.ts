import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHyAgentVerifier, createMcpHttpApp } from '../src';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'ES256', use: 'sig' };

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

function goodToken(): string {
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'hyagent', aud: 'rooms', sub: 'kevin', tenant: 't1', scopes: [], iat, exp: iat + 60, jti: randomUUID() })}`;
  return `${input}.${sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

const verifier = createHyAgentVerifier({ jwksUrl: 'http://x', audience: 'rooms', fetchJwks: async () => ({ keys: [jwk] }) });
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(register: Parameters<typeof createMcpHttpApp>[0]['register']): Promise<string> {
  const app = createMcpHttpApp({ name: 't', version: '0', verifier, register });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function post(url: string, auth: string | undefined, body: unknown = INIT) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe('createMcpHttpApp', () => {
  it('未帶 Authorization / Basic / 壞 token → 401，工具 handler 不執行', async () => {
    let ran = false;
    const url = await start((s) => {
      ran = true;
      s.registerTool('x', { inputSchema: { a: z.string().describe('a') } }, async () => ({ content: [] }));
    });
    expect((await post(url, undefined)).status).toBe(401);
    expect((await post(url, 'Basic x')).status).toBe(401);
    expect((await post(url, 'Bearer a.b.c')).status).toBe(401);
    expect(ran).toBe(false);
  });

  it('合法 token + initialize → 200', async () => {
    const url = await start(() => undefined);
    const res = await post(url, `Bearer ${goodToken()}`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('register 丟錯 → 500 JSON-RPC 錯誤，server 仍可服務下一個請求', async () => {
    let boom = true;
    const url = await start(() => {
      if (boom) throw new Error('secret detail');
    });
    const res = await post(url, `Bearer ${goodToken()}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    expect(text).not.toContain('secret');
    boom = false;
    const next = await post(url, `Bearer ${goodToken()}`);
    expect(next.status).toBe(200);
    await next.text();
  });
});
