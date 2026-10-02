/**
 * 驗證 HyAgent 呼叫 MCP server 時帶的 ES256 JWT。
 * 規則與 HyAgent 端 mcp.identity 一致：iss=hyagent、aud=本 server 的 serverId、效期 ≤ 300 秒。
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

export interface HyAgentCaller {
  tenantId: string;
  userId: string;
  scopes: string[];
  jti: string;
  /** HyAgent 的系統呼叫（如 listTools），不代表任何使用者 */
  system: boolean;
}

export class HyAgentAuthError extends Error {
  constructor(readonly reason: string) {
    super(`HyAgent 呼叫驗證失敗：${reason}`);
    this.name = 'HyAgentAuthError';
  }
}

export interface JwksDocument {
  keys: Array<Record<string, unknown>>;
}

export interface VerifierOptions {
  /** HyAgent 後端的 /.well-known/hyagent-mcp-jwks.json */
  jwksUrl: string;
  /** 本 MCP server 在 HyAgent 登記的 serverId */
  audience: string;
  issuer?: string;
  clockSkewSeconds?: number;
  fetchJwks?: (url: string) => Promise<JwksDocument>;
  /** 拒絕重複的 jti（單一程序內有效） */
  rejectReplay?: boolean;
  now?: () => number;
}

export interface HyAgentVerifier {
  verify(token: string): Promise<HyAgentCaller>;
}

const MAX_LIFETIME_SECONDS = 300;
const JWKS_REFETCH_MIN_INTERVAL_MS = 30_000;
const SYSTEM_SUBJECT = 'hyagent-system';

async function defaultFetchJwks(url: string): Promise<JwksDocument> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS 取得失敗：HTTP ${res.status}`);
  return (await res.json()) as JwksDocument;
}

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

export function createHyAgentVerifier(opts: VerifierOptions): HyAgentVerifier {
  const issuer = opts.issuer ?? 'hyagent';
  const skew = opts.clockSkewSeconds ?? 15;
  const now = opts.now ?? Date.now;
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  let keys = new Map<string, KeyObject>();
  let lastFetch = Number.NEGATIVE_INFINITY;
  const seenJti = new Map<string, number>();

  async function refresh(): Promise<void> {
    const doc = await fetchJwks(opts.jwksUrl);
    const next = new Map<string, KeyObject>();
    for (const jwk of doc.keys) {
      if (typeof jwk.kid === 'string' && jwk.kty === 'EC' && jwk.crv === 'P-256') {
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
      }
    }
    keys = next;
    lastFetch = now();
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    let key = keys.get(kid);
    // 未知 kid 可能是 HyAgent 剛換鑰：限頻重抓一次
    if (!key && now() - lastFetch >= JWKS_REFETCH_MIN_INTERVAL_MS) {
      await refresh();
      key = keys.get(kid);
    }
    if (!key) throw new HyAgentAuthError('unknown_kid');
    return key;
  }

  return {
    async verify(token: string): Promise<HyAgentCaller> {
      const parts = token.split('.');
      if (parts.length !== 3) throw new HyAgentAuthError('malformed');
      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = decodePart(parts[0]);
        payload = decodePart(parts[1]);
      } catch {
        throw new HyAgentAuthError('malformed');
      }
      if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new HyAgentAuthError('bad_header');

      const key = await keyFor(header.kid);
      const ok = verifySignature(
        'SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      );
      if (!ok) throw new HyAgentAuthError('bad_signature');

      if (payload.iss !== issuer) throw new HyAgentAuthError('bad_issuer');
      if (payload.aud !== opts.audience) throw new HyAgentAuthError('bad_audience');
      const { iat, exp, sub, jti } = payload;
      if (typeof iat !== 'number' || typeof exp !== 'number' || typeof sub !== 'string' || typeof jti !== 'string') {
        throw new HyAgentAuthError('bad_claims');
      }
      if (exp - iat > MAX_LIFETIME_SECONDS) throw new HyAgentAuthError('lifetime_too_long');
      const nowSec = Math.floor(now() / 1000);
      if (nowSec > exp + skew) throw new HyAgentAuthError('expired');
      if (iat > nowSec + skew) throw new HyAgentAuthError('not_yet_valid');

      if (opts.rejectReplay) {
        for (const [seen, until] of seenJti) if (until < now()) seenJti.delete(seen);
        if (seenJti.has(jti)) throw new HyAgentAuthError('replayed');
        seenJti.set(jti, (exp + skew) * 1000);
      }

      const system = sub === SYSTEM_SUBJECT;
      return {
        tenantId: typeof payload.tenant === 'string' ? payload.tenant : '',
        userId: system ? '' : sub,
        scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((s): s is string => typeof s === 'string') : [],
        jti,
        system,
      };
    },
  };
}
