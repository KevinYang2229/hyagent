/**
 * SSO handoff 單元測試：宿主以租戶 ssoSecret 簽的 userToken → 換發本系統 token。
 *
 * 這是 authService.ssoExchange 現行契約的可執行版本（先前完全沒有測試）。
 * docs/HANDOFF-SSO.md §4 列出的四項補強（鎖 algorithms / 驗 iss+aud / 強制 exp /
 * refresh 撤銷）每做一項，都應在本檔補對應的 case。
 */
import jwt from 'jsonwebtoken';
import { authService } from '@/modules/auth/auth.service';
import type { Tenant } from '@/modules/tenant/tenant.types';
import { verifyAccessToken, verifyRefreshToken } from '@/utils/jwt';

const SSO_SECRET = 'test-tenant-sso-secret-1234567890';

function makeTenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant-sso-test',
    name: 'SSO 測試租戶',
    allowedOrigins: ['http://localhost:4000'],
    ssoSecret: SSO_SECRET,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** 模擬宿主後端簽發的終端使用者 token */
function signUserToken(
  claims: Record<string, unknown>,
  opts: { secret?: string; expiresIn?: string | null } = {},
): string {
  const { secret = SSO_SECRET, expiresIn = '5m' } = opts;
  return expiresIn === null
    ? jwt.sign(claims, secret)
    : jwt.sign(claims, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

describe('authService.ssoExchange —— 拒絕路徑', () => {
  it('租戶未設 ssoSecret → 403「此租戶未啟用 SSO」', () => {
    const tenant = makeTenant({ ssoSecret: undefined });
    expect(() => authService.ssoExchange(tenant, signUserToken({ sub: 'HYW018' }))).toThrow(
      /未啟用 SSO/,
    );
  });

  it('用錯的密鑰簽的 token → 401', () => {
    expect(() =>
      authService.ssoExchange(makeTenant(), signUserToken({ sub: 'HYW018' }, { secret: '另一把密鑰' })),
    ).toThrow(/無效或已過期/);
  });

  it('已過期的 token → 401', () => {
    const expired = jwt.sign({ sub: 'HYW018' }, SSO_SECRET, { expiresIn: -60 });
    expect(() => authService.ssoExchange(makeTenant(), expired)).toThrow(/無效或已過期/);
  });

  it('不是 JWT 的字串 → 401', () => {
    expect(() => authService.ssoExchange(makeTenant(), 'not-a-jwt')).toThrow(/無效或已過期/);
  });

  it('缺 sub → 401「SSO token 缺少 sub」', () => {
    expect(() => authService.ssoExchange(makeTenant(), signUserToken({ name: '林佩蓉' }))).toThrow(
      /缺少 sub/,
    );
  });

  it('sub 為空白字串 → 401（trim 後視為未提供）', () => {
    expect(() => authService.ssoExchange(makeTenant(), signUserToken({ sub: '   ' }))).toThrow(
      /缺少 sub/,
    );
  });
});

describe('authService.ssoExchange —— 成功換發', () => {
  it('回傳 access/refresh，payload 帶 via=sso 與 tenantId', () => {
    const tenant = makeTenant();
    const tokens = authService.ssoExchange(
      tenant,
      signUserToken({ sub: 'HYW018', name: '林佩蓉' }),
    );

    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');

    const payload = verifyAccessToken(tokens.accessToken);
    expect(payload).toMatchObject({
      sub: 'HYW018',
      via: 'sso',
      tenantId: tenant.id,
      name: '林佩蓉',
      role: 'employee', // 宿主未指定 role 時的預設
    });
  });

  it('宿主指定的 role 會被沿用', () => {
    const tokens = authService.ssoExchange(makeTenant(), signUserToken({ sub: 'HYW042', role: 'manager' }));
    expect(verifyAccessToken(tokens.accessToken).role).toBe('manager');
  });

  it('數字型 sub 轉成字串', () => {
    const tokens = authService.ssoExchange(makeTenant(), signUserToken({ sub: 12345 }));
    expect(verifyAccessToken(tokens.accessToken).sub).toBe('12345');
  });

  it('sub 以外的自訂 claims 一律忽略（只讀 sub / name / role）', () => {
    const tokens = authService.ssoExchange(
      makeTenant(),
      signUserToken({ sub: 'HYW018', department: '行銷部', isAdmin: true }),
    );
    const payload = verifyAccessToken(tokens.accessToken) as unknown as Record<string, unknown>;
    expect(payload.department).toBeUndefined();
    expect(payload.isAdmin).toBeUndefined();
  });

  it('SSO 使用者不必存在於內部 mock 名錄（宿主的訪客也能換發）', () => {
    const tokens = authService.ssoExchange(makeTenant(), signUserToken({ sub: '完全沒見過的人' }));
    expect(verifyAccessToken(tokens.accessToken).sub).toBe('完全沒見過的人');
  });

  it('宿主未設 exp 時仍會換發 —— 現行行為，見 HANDOFF-SSO §4.2', () => {
    const noExp = signUserToken({ sub: 'HYW018' }, { expiresIn: null });
    expect(() => authService.ssoExchange(makeTenant(), noExp)).not.toThrow();
  });
});

describe('authService.refresh —— SSO 使用者', () => {
  it('輪替後保留 via=sso / tenantId / name', () => {
    const tenant = makeTenant();
    const first = authService.ssoExchange(tenant, signUserToken({ sub: 'HYW018', name: '林佩蓉' }));
    const next = authService.refresh(first.refreshToken);

    expect(verifyAccessToken(next.accessToken)).toMatchObject({
      sub: 'HYW018',
      via: 'sso',
      tenantId: tenant.id,
      name: '林佩蓉',
    });
    expect(verifyRefreshToken(next.refreshToken).via).toBe('sso');
  });

  it('SSO 使用者的輪替不查內部名錄 —— 現行行為，見 HANDOFF-SSO §4.4', () => {
    const first = authService.ssoExchange(makeTenant(), signUserToken({ sub: '不在名錄的人' }));
    expect(() => authService.refresh(first.refreshToken)).not.toThrow();
  });
});
