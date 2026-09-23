/**
 * 租戶 Assertion 公鑰模型與逐租戶設定（規格 §2.4、§2.5、§7.3、§4.3、§7.1、§10.4）。
 *
 * 重點在**拒絕**那幾條路徑：規格 §7.3 要求這些不變條件由後端強制、不得僅在 UI 層，
 * 所以「UI 沒擋住時後端會不會擋」才是這裡要釘的東西。
 */
import { ERROR_CODES, HyAgentTokenError, computeKid, generateHyAgentKeyPair } from '@/lib/assertion';
import { tenantStore } from '@/modules/tenant/tenant.store';
import {
  DEFAULT_ASSERTION_LIFETIME_SECONDS,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_SESSION_EXPIRES_IN,
  MAX_ACTIVE_KEYS,
  parsePublicKey,
} from '@/modules/tenant/tenant-keys';

// RSA 金鑰產生很慢（2048 bits），整支測試共用同一批
const rsa = generateHyAgentKeyPair('RS256');
const ec = generateHyAgentKeyPair('ES256');
const rsa2 = generateHyAgentKeyPair('RS256');

function newTenant(): string {
  return tenantStore.createTenant(`t-${Math.random().toString(36).slice(2, 8)}`, []).id;
}

/** 取出丟出的錯誤碼；沒丟就讓測試明確失敗而不是回 undefined 讓斷言誤過 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof HyAgentTokenError) return err.code;
    throw err;
  }
  throw new Error('預期要丟出 HyAgentTokenError，但沒有');
}

describe('parsePublicKey（規格 §2.3、§2.4）', () => {
  it('SPKI PEM：算出的 kid 與規格的 RFC 7638 Thumbprint 一致', () => {
    const parsed = parsePublicKey(rsa.publicKeyPem);
    expect(parsed.kid).toBe(rsa.kid);
    expect(parsed.alg).toBe('RS256');
    expect(parsed.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('JWK 與 PEM 上傳同一把公鑰，算出的 kid 相同', () => {
    const { createPublicKey } = require('node:crypto') as typeof import('node:crypto');
    const jwk = createPublicKey(ec.publicKeyPem).export({ format: 'jwk' });
    expect(parsePublicKey(JSON.stringify(jwk)).kid).toBe(parsePublicKey(ec.publicKeyPem).kid);
  });

  it('ES256 走 EC P-256', () => {
    expect(parsePublicKey(ec.publicKeyPem).alg).toBe('ES256');
  });

  it('上傳私鑰會被拒絕——最容易發生也最該擋的貼錯', () => {
    expect(codeOf(() => parsePublicKey(rsa.privateKeyPem))).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it('RSA 未達 2048 bits 拒絕（規格 §2.1）', () => {
    const weak = generateHyAgentKeyPair('RS256', { modulusLength: 2048 });
    // 直接產 1024 會被 generateHyAgentKeyPair 自己擋下，改用 node:crypto 繞過產生器的檢查
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(codeOf(() => parsePublicKey(pem))).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(parsePublicKey(weak.publicKeyPem).alg).toBe('RS256'); // 2048 剛好通過
  });

  it('非金鑰的字串、空字串一律 INVALID_REQUEST', () => {
    expect(codeOf(() => parsePublicKey('not a key'))).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(codeOf(() => parsePublicKey('  '))).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(codeOf(() => parsePublicKey(null))).toBe(ERROR_CODES.INVALID_REQUEST);
  });
});

describe('公鑰上限與冪等（規格 §7.3）', () => {
  it('上傳後可列出，kid 由後端算出', () => {
    const id = newTenant();
    const added = tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem, label: '正式' });
    expect(added).toEqual({
      key: expect.objectContaining({ kid: rsa.kid, alg: 'RS256', status: 'active', label: '正式' }),
      created: true,
    });
    expect(tenantStore.listPublicKeys(id).map((k) => k.kid)).toEqual([rsa.kid]);
  });

  it('同一把公鑰重複上傳為冪等：不新增第二筆，回既有的 kid 與狀態', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    const again = tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem, label: '改個名' });

    expect(again?.created).toBe(false);
    expect(again?.key.kid).toBe(rsa.kid);
    expect(tenantStore.listPublicKeys(id)).toHaveLength(1);
  });

  it('重新上傳已撤銷的公鑰不會把它復活——否則撤銷等於形同虛設', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });
    tenantStore.setPublicKeyStatus(id, rsa.kid, 'revoked');

    const again = tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    expect(again).toEqual({ key: expect.objectContaining({ status: 'revoked' }), created: false });
  });

  it(`active 達 ${MAX_ACTIVE_KEYS} 把後再上傳 → KEY_LIMIT_EXCEEDED`, () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });

    expect(codeOf(() => tenantStore.addPublicKey(id, { publicKey: rsa2.publicKeyPem }))).toBe(
      ERROR_CODES.KEY_LIMIT_EXCEEDED,
    );
  });

  it('撤銷一把後額度釋出，可再上傳', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });
    tenantStore.setPublicKeyStatus(id, rsa.kid, 'revoked');

    expect(tenantStore.addPublicKey(id, { publicKey: rsa2.publicKeyPem })?.created).toBe(true);
  });
});

describe('公鑰狀態機（規格 §7.3、§2.6）', () => {
  it('停用最後一把 active → LAST_ACTIVE_KEY（租戶會立刻無法登入）', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });

    expect(codeOf(() => tenantStore.setPublicKeyStatus(id, rsa.kid, 'disabled'))).toBe(
      ERROR_CODES.LAST_ACTIVE_KEY,
    );
    expect(tenantStore.listPublicKeys(id)[0].status).toBe('active');
  });

  it('撤銷最後一把 active → 允許（私鑰外洩時安全優先於可用性）', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });

    const revoked = tenantStore.setPublicKeyStatus(id, rsa.kid, 'revoked');
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.statusChangedAt).toEqual(expect.any(String));
  });

  it('還有另一把 active 時可以停用', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });

    expect(tenantStore.setPublicKeyStatus(id, rsa.kid, 'disabled')?.status).toBe('disabled');
  });

  it('已撤銷的公鑰不可復原', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });
    tenantStore.setPublicKeyStatus(id, rsa.kid, 'revoked');

    expect(codeOf(() => tenantStore.setPublicKeyStatus(id, rsa.kid, 'active'))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('查無 kid → INVALID_REQUEST', () => {
    const id = newTenant();
    expect(codeOf(() => tenantStore.setPublicKeyStatus(id, 'no-such-kid', 'revoked'))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('停用後重新啟用，仍受 2 把上限約束', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    tenantStore.addPublicKey(id, { publicKey: ec.publicKeyPem });
    tenantStore.setPublicKeyStatus(id, rsa.kid, 'disabled');
    tenantStore.addPublicKey(id, { publicKey: rsa2.publicKeyPem });

    expect(codeOf(() => tenantStore.setPublicKeyStatus(id, rsa.kid, 'active'))).toBe(
      ERROR_CODES.KEY_LIMIT_EXCEEDED,
    );
  });

  it('公鑰不進落地加密範圍——它本來就可公開，加密只會製造受保護的錯覺', () => {
    const id = newTenant();
    tenantStore.addPublicKey(id, { publicKey: rsa.publicKeyPem });
    const { sealTenant } = require('@/modules/tenant/tenant.store') as typeof import('@/modules/tenant/tenant.store');
    const sealed = sealTenant(tenantStore.getTenant(id)!);
    expect(sealed.publicKeys?.[0].publicKey).toBe(rsa.publicKeyPem);
    expect(computeKid(sealed.publicKeys![0].publicKey)).toBe(rsa.kid);
  });
});

describe('逐租戶設定（規格 §4.3、§7.1、§10.4）', () => {
  it('未設定時回規格預設值', () => {
    expect(tenantStore.getAssertionSettings(newTenant())).toEqual({
      clockSkewSeconds: DEFAULT_CLOCK_SKEW_SECONDS,
      assertionLifetimeSeconds: DEFAULT_ASSERTION_LIFETIME_SECONDS,
      sessionExpiresIn: DEFAULT_SESSION_EXPIRES_IN,
    });
  });

  it('skew 超出 0～30 → INVALID_REQUEST', () => {
    const id = newTenant();
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { clockSkewSeconds: 31 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { clockSkewSeconds: -1 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('skew 超過有效期 ¼ → 拒絕（預設 60 秒有效期，上限即 15）', () => {
    const id = newTenant();
    expect(tenantStore.updateAssertionSettings(id, { clockSkewSeconds: 15 })?.clockSkewSeconds).toBe(15);
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { clockSkewSeconds: 16 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('有效期拉長後 skew 上限跟著放寬，30 秒才用得上', () => {
    const id = newTenant();
    tenantStore.updateAssertionSettings(id, { assertionLifetimeSeconds: 120 });
    expect(tenantStore.updateAssertionSettings(id, { clockSkewSeconds: 30 })?.clockSkewSeconds).toBe(30);
  });

  it('把有效期改短到會讓現行 skew 踩線時，一樣要擋——交叉條件不能只驗被改的那一邊', () => {
    const id = newTenant();
    tenantStore.updateAssertionSettings(id, { assertionLifetimeSeconds: 120, clockSkewSeconds: 30 });
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { assertionLifetimeSeconds: 60 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('sessionExpiresIn 限 300～28800（規格 §7.1）', () => {
    const id = newTenant();
    expect(tenantStore.updateAssertionSettings(id, { sessionExpiresIn: 300 })?.sessionExpiresIn).toBe(300);
    expect(tenantStore.updateAssertionSettings(id, { sessionExpiresIn: 28_800 })?.sessionExpiresIn).toBe(28_800);
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { sessionExpiresIn: 299 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
    expect(codeOf(() => tenantStore.updateAssertionSettings(id, { sessionExpiresIn: 28_801 }))).toBe(
      ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('被拒的更新不留下半套設定', () => {
    const id = newTenant();
    try {
      tenantStore.updateAssertionSettings(id, { sessionExpiresIn: 7200, clockSkewSeconds: 99 });
    } catch {
      /* 預期會丟 */
    }
    expect(tenantStore.getAssertionSettings(id)?.sessionExpiresIn).toBe(DEFAULT_SESSION_EXPIRES_IN);
  });
});
