/**
 * Identity Assertion → HyAgent Session 的換發（規格 §5.3、§7.1、§8；取代改造前的 auth-sso）。
 *
 * 驗證器本身的 22 項規則已由 assertion-verifier.test.ts 覆蓋；這裡釘的是**接線**：
 * 租戶由誰決定、公鑰撤銷有沒有即時生效、Origin 有沒有真的擋、Session 有沒有帶 kid。
 */
import { env } from '@/config/env';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { assertionExchange } from '@/modules/auth/assertion-exchange';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { issueAssertion } from './helpers/assertion-signer';

const keyPair = generateHyAgentKeyPair('RS256');
const otherPair = generateHyAgentKeyPair('ES256');

function fixture(origins: string[] = ['*']) {
  const tenant = tenantStore.createTenant('assertion fixture', origins);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  const sign = (over: Partial<Parameters<typeof issueAssertion>[0]> = {}) =>
    issueAssertion({
      privateKey: keyPair.privateKeyPem,
      tenant: tenant.id,
      subject: 'external-user',
      ...over,
    });
  return { tenant, sign };
}

/** 取出 HyAgentTokenError 的代碼；沒丟就讓測試明確失敗 */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  throw new Error('預期要被拒絕，但通過了');
}

describe('成功換發', () => {
  it('回不透明 sessionToken 與使用者資料，Session 帶著驗章用的 kid（規格 §2.6）', async () => {
    const { tenant, sign } = fixture();
    const result = await assertionExchange.exchange({
      assertion: sign({ profile: { name: '羅玉瑩' } }),
      origin: 'https://any.example.com',
    });

    expect(result.sessionToken).toMatch(/^hyas_/);
    expect(result.user).toEqual({ sub: 'external-user', name: '羅玉瑩' });
    expect(result.kid).toBe(keyPair.kid);

    const session = await authSessionStore.get(result.sessionToken);
    expect(session).toMatchObject({ tenantId: tenant.id, kid: keyPair.kid });
  });

  it('expiresIn 取該租戶的設定（規格 §7.1）', async () => {
    const { tenant, sign } = fixture();
    tenantStore.updateAssertionSettings(tenant.id, { sessionExpiresIn: 900 });
    await expect(assertionExchange.exchange({ assertion: sign() })).resolves.toMatchObject({
      expiresIn: 900,
    });
  });

  it('未知 claims 不影響驗證（規格 §11.1 向前相容）', async () => {
    const { sign } = fixture();
    const assertion = sign({ profile: { 'x-future-field': { anything: [1, 2] } } });
    await expect(assertionExchange.exchange({ assertion })).resolves.toBeDefined();
  });
});

describe('租戶由 iss 決定，不是 API Key（決策 A）', () => {
  it('iss 指向不存在的租戶 → TENANT_NOT_FOUND', async () => {
    const { sign } = fixture();
    const assertion = sign({ tenant: 'no-such-tenant' });
    expect(await codeOf(() => assertionExchange.exchange({ assertion }))).toBe('TENANT_NOT_FOUND');
  });

  it('A 租戶的公鑰配 B 租戶的 iss → UNKNOWN_KID（跨租戶混淆擋在這裡）', async () => {
    const a = fixture();
    const b = fixture();
    // 用 A 的私鑰簽，但宣稱自己是 B——B 沒有這把 kid
    const assertion = issueAssertion({
      privateKey: keyPair.privateKeyPem,
      tenant: b.tenant.id,
      subject: 'x',
      kid: 'not-registered-on-b',
    });
    expect(await codeOf(() => assertionExchange.exchange({ assertion }))).toBe('UNKNOWN_KID');
    expect(a.tenant.id).not.toBe(b.tenant.id);
  });
});

describe('公鑰狀態即時生效（規格 §2.6）', () => {
  it('撤銷後以該 kid 簽的 Assertion 立刻被拒', async () => {
    const { tenant, sign } = fixture();
    tenantStore.addPublicKey(tenant.id, { publicKey: otherPair.publicKeyPem });
    tenantStore.revokePublicKey(tenant.id, keyPair.kid, 'compromised');

    expect(await codeOf(() => assertionExchange.exchange({ assertion: sign() }))).toBe('KEY_REVOKED');
  });

  it('輪替汰換的舊公鑰同樣不可用——撤銷原因只供稽核，不影響驗證', async () => {
    const { tenant, sign } = fixture();
    tenantStore.addPublicKey(tenant.id, { publicKey: otherPair.publicKeyPem });
    tenantStore.revokePublicKey(tenant.id, keyPair.kid, 'rotated');

    expect(await codeOf(() => assertionExchange.exchange({ assertion: sign() }))).toBe('KEY_REVOKED');
  });

  it('租戶沒有任何公鑰 → UNKNOWN_KID', async () => {
    const tenant = tenantStore.createTenant('no keys', ['*']);
    const assertion = issueAssertion({
      privateKey: keyPair.privateKeyPem,
      tenant: tenant.id,
      subject: 'x',
    });
    expect(await codeOf(() => assertionExchange.exchange({ assertion }))).toBe('UNKNOWN_KID');
  });
});

/**
 * 規格 §8.6 步驟 21。這一節釘的是「拿哪個值去比對白名單」——換發有兩種呼叫端，
 * 能信任的訊號不同，接錯邊這項檢查就等於沒做。
 */
describe('Origin 白名單（規格 §8.6 步驟 21）', () => {
  const PANEL = 'https://panel.hyagent.test';
  const original = env.CORS_ORIGIN;

  // 預設 '*' 時無從分辨誰是自己人；這裡列舉具體網域，模擬正式環境設定
  beforeEach(() => {
    env.CORS_ORIGIN = PANEL;
  });
  afterEach(() => {
    env.CORS_ORIGIN = original;
  });

  describe('headless SDK：跑在客戶自己的頁面，Origin 由瀏覽器設定', () => {
    it('白名單內的 Origin 通過', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      await expect(
        assertionExchange.exchange({ assertion: sign(), origin: 'https://allowed.example.com' }),
      ).resolves.toBeDefined();
    });

    it('白名單外的 Origin 被拒', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      expect(
        await codeOf(() =>
          assertionExchange.exchange({ assertion: sign(), origin: 'https://evil.example.com' }),
        ),
      ).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('body 的 embedOrigin **不能**覆蓋瀏覽器設的 Origin——否則這道檢查一行就繞過去了', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      expect(
        await codeOf(() =>
          assertionExchange.exchange({
            assertion: sign(),
            origin: 'https://evil.example.com',
            embedOrigin: 'https://allowed.example.com',
          }),
        ),
      ).toBe('ORIGIN_NOT_ALLOWED');
    });
  });

  describe('Widget 面板：請求來自 HyAgent 自己的 iframe', () => {
    it('比對面板回報的 referrer，而不是 Origin header', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      await expect(
        assertionExchange.exchange({
          assertion: sign(),
          origin: PANEL, // 面板自己的網域，對所有租戶都一樣，沒有鑑別力
          embedOrigin: 'https://allowed.example.com',
        }),
      ).resolves.toBeDefined();
    });

    it('嵌入者不在白名單 → 拒絕', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      expect(
        await codeOf(() =>
          assertionExchange.exchange({
            assertion: sign(),
            origin: PANEL,
            embedOrigin: 'https://evil.example.com',
          }),
        ),
      ).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('讀不到 referrer 時 fail closed——嵌入方刻意隱藏來源不該換到放行', async () => {
      const { sign } = fixture(['https://allowed.example.com']);
      expect(
        await codeOf(() =>
          assertionExchange.exchange({ assertion: sign(), origin: PANEL, embedOrigin: null }),
        ),
      ).toBe('ORIGIN_NOT_ALLOWED');
    });
  });

  it('租戶限定來源但兩個訊號都沒有 → 拒絕', async () => {
    const { sign } = fixture(['https://allowed.example.com']);
    expect(await codeOf(() => assertionExchange.exchange({ assertion: sign() }))).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
  });

  it("租戶設 ['*'] 時一律放行（預設租戶的向後相容行為）", async () => {
    const { sign } = fixture(['*']);
    await expect(assertionExchange.exchange({ assertion: sign(), origin: PANEL })).resolves.toBeDefined();
  });
});

describe('一次性（規格 §8.5）', () => {
  it('同一張 Assertion 換第二次 → TOKEN_REPLAYED', async () => {
    const { sign } = fixture();
    const assertion = sign();
    await expect(assertionExchange.exchange({ assertion })).resolves.toBeDefined();
    expect(await codeOf(() => assertionExchange.exchange({ assertion }))).toBe('TOKEN_REPLAYED');
  });

  it('來源不合法時該 jti 也已消耗——被側錄的票拿去他站會當場報廢', async () => {
    const { sign } = fixture(['https://allowed.example.com']);
    const assertion = sign();
    expect(
      await codeOf(() => assertionExchange.exchange({ assertion, origin: 'https://evil.example.com' })),
    ).toBe('ORIGIN_NOT_ALLOWED');
    expect(
      await codeOf(() =>
        assertionExchange.exchange({ assertion, origin: 'https://allowed.example.com' }),
      ),
    ).toBe('TOKEN_REPLAYED');
  });
});

describe('步驟 0 的順序（規格 §8.0）', () => {
  it('超過 4096 bytes 的輸入在解碼前就被拒，且不是 MALFORMED_TOKEN', async () => {
    const huge = 'x'.repeat(5000);
    expect(await codeOf(() => assertionExchange.exchange({ assertion: huge }))).toBe(
      'ASSERTION_TOO_LARGE',
    );
  });
});

describe('逐租戶 clock skew（規格 §10.4）', () => {
  it('exp 已過但在容忍內 → 通過', async () => {
    const { tenant, sign } = fixture();
    tenantStore.updateAssertionSettings(tenant.id, { clockSkewSeconds: 15 });
    const now = Math.floor(Date.now() / 1000);
    const assertion = sign({ now: now - 70 }); // 60 秒有效期 → 已過期 10 秒
    await expect(
      assertionExchange.exchange({ assertion, clockTimestamp: now }),
    ).resolves.toBeDefined();
  });

  it('容忍值設 0 時同一張就過期', async () => {
    const { tenant, sign } = fixture();
    tenantStore.updateAssertionSettings(tenant.id, { clockSkewSeconds: 0 });
    const now = Math.floor(Date.now() / 1000);
    const assertion = sign({ now: now - 70 });
    expect(
      await codeOf(() => assertionExchange.exchange({ assertion, clockTimestamp: now })),
    ).toBe('TOKEN_EXPIRED');
  });
});
