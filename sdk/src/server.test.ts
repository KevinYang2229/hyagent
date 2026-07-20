import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signUserToken,
  verifyUserToken,
  constructWebhookEvent,
  verifyWebhookSignature,
  type WebhookEvent,
} from './server';

const SECRET = 'test-tenant-sso-secret';

describe('signUserToken / verifyUserToken', () => {
  it('簽發後可用同密鑰驗回原 claims', () => {
    const token = signUserToken({ secret: SECRET, sub: 'E12345', name: '楊小明', role: 'manager' });
    const claims = verifyUserToken(token, SECRET);
    expect(claims.sub).toBe('E12345');
    expect(claims.name).toBe('楊小明');
    expect(claims.role).toBe('manager');
  });

  it('省略 name/role 時不帶該鍵', () => {
    const token = signUserToken({ secret: SECRET, sub: 'E1' });
    const claims = verifyUserToken(token, SECRET);
    expect(claims.sub).toBe('E1');
    expect('name' in claims).toBe(false);
    expect('role' in claims).toBe(false);
  });

  it('缺 secret / sub 立即拋錯（不簽出無效 token）', () => {
    expect(() => signUserToken({ secret: '', sub: 'E1' })).toThrow(/secret/);
    expect(() => signUserToken({ secret: SECRET, sub: '' })).toThrow(/sub/);
  });

  it('換密鑰驗章失敗', () => {
    const token = signUserToken({ secret: SECRET, sub: 'E1' });
    expect(() => verifyUserToken(token, 'wrong-secret')).toThrow();
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
