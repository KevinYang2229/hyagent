import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHyAgentVerifier, HyAgentAuthError } from '../src';

const NOW = Date.parse('2026-10-03T00:00:00Z');

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' } };
}

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

function token(privateKey: KeyObject, kid: string, claims: Record<string, unknown> = {}): string {
  const iat = Math.floor(NOW / 1000);
  const payload = { iss: 'hyagent', aud: 'rooms', sub: 'kevin', tenant: 't1', scopes: ['mcp:rooms'], iat, exp: iat + 60, jti: randomUUID(), ...claims };
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid })}.${b64(payload)}`;
  const sig = sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

function verifierFor(keys: Record<string, unknown>[], extra: Partial<Parameters<typeof createHyAgentVerifier>[0]> = {}) {
  let fetches = 0;
  const v = createHyAgentVerifier({
    jwksUrl: 'http://hyagent/.well-known/hyagent-mcp-jwks.json',
    audience: 'rooms',
    fetchJwks: async () => {
      fetches += 1;
      return { keys };
    },
    now: () => NOW,
    ...extra,
  });
  return { v, fetches: () => fetches };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof HyAgentAuthError ? err.reason : `other:${(err as Error).message}`;
  }
}

describe('createHyAgentVerifier', () => {
  const k = keypair('k1');

  it('合法 token → 回呼叫者', async () => {
    const { v } = verifierFor([k.jwk]);
    await expect(v.verify(token(k.privateKey, 'k1'))).resolves.toMatchObject({
      tenantId: 't1',
      userId: 'kevin',
      scopes: ['mcp:rooms'],
      system: false,
    });
  });

  it('系統呼叫 → system=true、userId 空', async () => {
    const { v } = verifierFor([k.jwk]);
    const caller = await v.verify(token(k.privateKey, 'k1', { sub: 'hyagent-system', tenant: undefined, scopes: [] }));
    expect(caller).toMatchObject({ system: true, userId: '', tenantId: '' });
  });

  it.each([
    ['bad_audience', { aud: 'other' }],
    ['bad_issuer', { iss: 'evil' }],
    ['expired', { iat: Math.floor(NOW / 1000) - 200, exp: Math.floor(NOW / 1000) - 100 }],
    ['not_yet_valid', { iat: Math.floor(NOW / 1000) + 100, exp: Math.floor(NOW / 1000) + 160 }],
    ['lifetime_too_long', { exp: Math.floor(NOW / 1000) + 3600 }],
  ])('%s', async (expected, claims) => {
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(k.privateKey, 'k1', claims)))).toBe(expected);
  });

  it('簽章被竄改 → bad_signature', async () => {
    const { v } = verifierFor([k.jwk]);
    const t = token(k.privateKey, 'k1');
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64({ iss: 'hyagent', aud: 'rooms', sub: 'admin', iat: 0, exp: 60, jti: 'x' })}.${s}`;
    expect(await reason(v.verify(forged))).toBe('bad_signature');
  });

  it('別把金鑰簽的 → bad_signature', async () => {
    const other = keypair('k1');
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(other.privateKey, 'k1')))).toBe('bad_signature');
  });

  it('未知 kid → 重抓 JWKS 一次後仍無 → unknown_kid', async () => {
    const { v, fetches } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(k.privateKey, 'nope')))).toBe('unknown_kid');
    expect(fetches()).toBe(1);
  });

  it('格式錯誤 → malformed', async () => {
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify('abc'))).toBe('malformed');
    expect(await reason(v.verify('a.b.c'))).toBe('malformed');
  });

  it('rejectReplay：同一 jti 第二次 → replayed', async () => {
    const { v } = verifierFor([k.jwk], { rejectReplay: true });
    const t = token(k.privateKey, 'k1');
    await v.verify(t);
    expect(await reason(v.verify(t))).toBe('replayed');
  });

  it('JWKS 快取：連續驗證只抓一次', async () => {
    const { v, fetches } = verifierFor([k.jwk]);
    await v.verify(token(k.privateKey, 'k1'));
    await v.verify(token(k.privateKey, 'k1'));
    expect(fetches()).toBe(1);
  });
});
