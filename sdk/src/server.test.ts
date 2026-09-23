import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  computeKid,
  generateKeyPair,
  issueAssertion,
  constructWebhookEvent,
  verifyWebhookSignature,
  type WebhookEvent,
} from './server';

/** RSA 產生很慢，整支測試共用 */
const rsa = generateKeyPair('RS256');
const ec = generateKeyPair('ES256');

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
  };
}

describe('generateKeyPair / computeKid（規格 §2.3、§2.4）', () => {
  it('產出 SPKI 公鑰與 PKCS#8 私鑰，kid 為公鑰的 RFC 7638 Thumbprint', () => {
    expect(rsa.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(rsa.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(computeKid(rsa.publicKeyPem)).toBe(rsa.kid);
    // 私鑰算出的 kid 與公鑰相同——kid 是公鑰的指紋
    expect(computeKid(rsa.privateKeyPem)).toBe(rsa.kid);
  });

  it('RSA 未達 2048 bits 拒絕產生（規格 §2.1）', () => {
    expect(() => generateKeyPair('RS256', { modulusLength: 1024 })).toThrow(/2048/);
  });
});

describe('issueAssertion（規格 §4）', () => {
  it('核心 claims 由簽發器決定，kid 進 header', () => {
    const token = issueAssertion({
      privateKey: rsa.privateKeyPem,
      tenant: 'hyoa',
      subject: 507,
      profile: { name: '羅玉瑩', roles: ['staff'] },
    });
    const { header, payload } = decode(token);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: rsa.kid });
    expect(payload).toMatchObject({ iss: 'hyoa', sub: '507', aud: 'hyagent', name: '羅玉瑩' });
    expect(payload.exp as number).toBe((payload.iat as number) + 60);
  });

  it('每次簽發的 jti 都不同——一次性兌換券的前提（規格 §8.5）', () => {
    const opts = { privateKey: ec.privateKeyPem, tenant: 't', subject: 'u' };
    expect(decode(issueAssertion(opts)).payload.jti).not.toBe(decode(issueAssertion(opts)).payload.jti);
  });

  it('ES256 簽章為 64 bytes 的 R‖S 串接，不是 DER（規格 §2.1 的陷阱）', () => {
    const token = issueAssertion({ privateKey: ec.privateKeyPem, tenant: 't', subject: 'u' });
    const signature = Buffer.from(token.split('.')[2], 'base64url');
    expect(signature).toHaveLength(64);
    expect(signature[0]).not.toBe(0x30); // DER SEQUENCE 的開頭
  });

  it('profile 不得覆寫核心 claims', () => {
    expect(() =>
      issueAssertion({ privateKey: ec.privateKeyPem, tenant: 't', subject: 'u', profile: { sub: 'other' } }),
    ).toThrow(/核心 claims/);
  });

  it('有效期超過 300 秒拒絕（規格 §4.3）', () => {
    expect(() =>
      issueAssertion({ privateKey: ec.privateKeyPem, tenant: 't', subject: 'u', lifetimeSeconds: 301 }),
    ).toThrow(/300/);
  });

  it('缺 tenant / subject 立即拋錯，不簽出無效 token', () => {
    expect(() => issueAssertion({ privateKey: ec.privateKeyPem, tenant: '', subject: 'u' })).toThrow(/tenant/);
    expect(() => issueAssertion({ privateKey: ec.privateKeyPem, tenant: 't', subject: '' })).toThrow(/subject/);
  });

  it('自訂 claims 塞爆 4096 bytes 時在簽發端就擋下（規格 §4.2.4）', () => {
    expect(() =>
      issueAssertion({
        privateKey: ec.privateKeyPem,
        tenant: 't',
        subject: 'u',
        profile: { blob: 'x'.repeat(5000) },
      }),
    ).toThrow(/4096/);
  });
});

// ─────────── webhook 驗簽（整合方接收端的安全邊界）───────────

const WHSEC = 'whsec_test';

function makeEvent(): WebhookEvent {
  return {
    id: 'evt_1',
    type: 'form.submitted',
    tenantId: 't1',
    createdAt: '2026-07-20T00:00:00.000Z',
    data: {
      conversationId: 'c1',
      formId: 'leaveRequest',
      userId: 'E1',
      values: { reason: '家裡有事' },
      submission: { oaRequestId: 'STUB-1', status: 'submitted', submittedAt: '2026-07-20T00:00:00.000Z' },
    },
  };
}

/** 以與實作相同的演算法造出合法簽章：sha256=HMAC(secret, `${ts}.${payload}`) */
function sign(payload: string, ts: string, secret = WHSEC): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
}

describe('constructWebhookEvent', () => {
  it('合法簽章 + 新鮮 timestamp → 解析回事件', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now());
    const evt = constructWebhookEvent({ payload, signature: sign(payload, ts), timestamp: ts, secret: WHSEC });
    expect(evt.type).toBe('form.submitted');
    expect(evt.data.submission.oaRequestId).toBe('STUB-1');
  });

  it('內容遭竄改（payload 改動）→ 驗章失敗', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now());
    const goodSig = sign(payload, ts);
    const tampered = payload.replace('家裡有事', '竄改內容');
    expect(() =>
      constructWebhookEvent({ payload: tampered, signature: goodSig, timestamp: ts, secret: WHSEC }),
    ).toThrow(/簽章/);
  });

  it('錯誤密鑰 → 驗章失敗', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now());
    expect(() =>
      constructWebhookEvent({ payload, signature: sign(payload, ts, 'whsec_other'), timestamp: ts, secret: WHSEC }),
    ).toThrow(/簽章/);
  });

  it('缺 signature 或 timestamp → 拋錯', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now());
    expect(() =>
      constructWebhookEvent({ payload, signature: undefined, timestamp: ts, secret: WHSEC }),
    ).toThrow();
    expect(() =>
      constructWebhookEvent({ payload, signature: sign(payload, ts), timestamp: undefined, secret: WHSEC }),
    ).toThrow();
  });

  it('過舊 timestamp（超出容許）→ 視為重放而拒絕', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now() - 10 * 60 * 1000); // 10 分鐘前，預設容許 300s
    expect(() =>
      constructWebhookEvent({ payload, signature: sign(payload, ts), timestamp: ts, secret: WHSEC }),
    ).toThrow(/重放|範圍/);
  });

  it('toleranceSec=0 關閉時間檢查，舊 timestamp 仍通過', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now() - 10 * 60 * 1000);
    const evt = constructWebhookEvent({
      payload,
      signature: sign(payload, ts),
      timestamp: ts,
      secret: WHSEC,
      toleranceSec: 0,
    });
    expect(evt.id).toBe('evt_1');
  });
});

describe('verifyWebhookSignature（boolean 版）', () => {
  it('合法回 true、竄改回 false（不丟錯）', () => {
    const payload = JSON.stringify(makeEvent());
    const ts = String(Date.now());
    expect(verifyWebhookSignature({ payload, signature: sign(payload, ts), timestamp: ts, secret: WHSEC })).toBe(true);
    expect(
      verifyWebhookSignature({ payload: payload + ' ', signature: sign(payload, ts), timestamp: ts, secret: WHSEC }),
    ).toBe(false);
  });
});
