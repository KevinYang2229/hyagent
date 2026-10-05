/** MCP 呼叫 JWT：ES256 可用 JWKS 驗章、claims 正確、scope 只帶本 server、未設金鑰即停用。 */
import { createPublicKey, verify } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { env } from '@/config/env';
import { assertMcpSigningKeyValid, configureMcpSigningKey, isMcpSigningEnabled, mcpJwks, signMcpToken } from '@/modules/mcp/mcp.identity';

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => configureMcpSigningKey(null));

describe('MCP 呼叫身分', () => {
  it('未設金鑰 → 停用、簽發丟錯、JWKS 空', () => {
    expect(isMcpSigningEnabled()).toBe(false);
    expect(() => signMcpToken('rooms', 'system')).toThrow('MCP_SIGNING_KEY');
    expect(mcpJwks().keys).toEqual([]);
  });

  it('非 EC P-256 金鑰 → 設定時丟錯', () => {
    expect(() => configureMcpSigningKey(generateHyAgentKeyPair('RS256').privateKeyPem)).toThrow('ES256');
  });

  it('簽發的 token 可用 JWKS 公鑰驗章，claims 正確', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const now = Date.parse('2026-10-03T00:00:00Z');
    const token = signMcpToken('rooms', { tenantId: 't1', userId: 'kevin', scopes: ['service:agent', 'mcp:rooms', 'mcp:rooms:admin', 'mcp:other'] }, now);
    const [h, p, s] = token.split('.');
    const header = decode(h);
    const payload = decode(p);
    const jwk = mcpJwks().keys[0] as { kid: string };
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: jwk.kid });
    expect(payload).toMatchObject({
      iss: 'hyagent',
      aud: 'rooms',
      sub: 'kevin',
      tenant: 't1',
      scopes: ['mcp:rooms', 'mcp:rooms:admin'],
      iat: now / 1000,
      exp: now / 1000 + 60,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    expect(verify('SHA256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('系統呼叫的 sub 為 hyagent-system、無租戶、無 scope', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const payload = decode(signMcpToken('rooms', 'system').split('.')[1]);
    expect(payload.sub).toBe('hyagent-system');
    expect(payload.tenant).toBeUndefined();
    expect(payload.scopes).toEqual([]);
  });

  it('每次簽發 jti 不同', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const a = decode(signMcpToken('rooms', 'system').split('.')[1]).jti;
    const b = decode(signMcpToken('rooms', 'system').split('.')[1]).jti;
    expect(a).not.toBe(b);
  });

  it('JWKS 端點：啟用時回公鑰、未啟用 404', async () => {
    const app = createApp();
    expect((await request(app).get('/.well-known/hyagent-mcp-jwks.json')).status).toBe(404);
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const res = await request(app).get('/.well-known/hyagent-mcp-jwks.json');
    expect(res.status).toBe(200);
    expect(res.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(res.body.keys[0].d).toBeUndefined();
  });

  describe('環境變數金鑰格式不對', () => {
    const original = env.MCP_SIGNING_KEY;
    beforeEach(() => {
      env.MCP_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';
      configureMcpSigningKey(null);
    });
    afterEach(() => {
      env.MCP_SIGNING_KEY = original;
      configureMcpSigningKey(null);
    });

    it('assertMcpSigningKeyValid 開機檢查丟錯，訊息指出 MCP_SIGNING_KEY 且不含金鑰內容', () => {
      expect(() => assertMcpSigningKeyValid()).toThrow('MCP_SIGNING_KEY');
      expect(() => assertMcpSigningKeyValid()).not.toThrow('not-a-real-key');
    });

    it('執行期 isMcpSigningEnabled 不丟錯、回 false；JWKS 空', () => {
      expect(() => isMcpSigningEnabled()).not.toThrow();
      expect(isMcpSigningEnabled()).toBe(false);
      expect(mcpJwks().keys).toEqual([]);
    });
  });

  it('assertMcpSigningKeyValid：未設定或合法金鑰都通過', () => {
    const original = env.MCP_SIGNING_KEY;
    try {
      env.MCP_SIGNING_KEY = '';
      expect(() => assertMcpSigningKeyValid()).not.toThrow();
      env.MCP_SIGNING_KEY = generateHyAgentKeyPair('ES256').privateKeyPem;
      expect(() => assertMcpSigningKeyValid()).not.toThrow();
    } finally {
      env.MCP_SIGNING_KEY = original;
    }
  });
});
