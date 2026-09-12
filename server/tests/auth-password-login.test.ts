/**
 * 帳密登入開關（AUTH_PASSWORD_LOGIN）。
 *
 * 前一批安全修正把帳密登入寫死成「production 一律禁用」，但 SSO 需要宿主後端簽票；
 * 宿主端還沒接好時整套面板會完全無法登入。改成顯式開關後，這裡守住兩個方向：
 * 開啟時 production 也能登入、關閉時連先前簽發的 token 都不再被接受。
 */
import { env, isPasswordLoginEnabled } from '@/config/env';
import { authService } from '@/modules/auth/auth.service';
import { validateIdentity } from '@/modules/auth/credential-version';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { verifyAccessToken } from '@/utils/jwt';

/** 暫時改寫 env，跑完一定還原（測試間共用同一份 env 物件） */
async function withEnv(
  patch: Partial<Pick<typeof env, 'NODE_ENV' | 'AUTH_PASSWORD_LOGIN'>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = { NODE_ENV: env.NODE_ENV, AUTH_PASSWORD_LOGIN: env.AUTH_PASSWORD_LOGIN };
  Object.assign(env, patch);
  try {
    await fn();
  } finally {
    Object.assign(env, previous);
  }
}

describe('AUTH_PASSWORD_LOGIN', () => {
  // 設定過人員目錄的 default 租戶：帳密登入認得的帳號一律以此為準（內建開發名錄不再參與）
  beforeEach(() => {
    tenantStore.updateTenant('default', {
      userDirectory: [{ id: 'staff-001', name: '王小明', department: '業務部' }],
    });
  });

  it('auto（預設）：production 關、其他環境開', async () => {
    await withEnv({ AUTH_PASSWORD_LOGIN: 'auto', NODE_ENV: 'production' }, async () => {
      expect(isPasswordLoginEnabled()).toBe(false);
    });
    await withEnv({ AUTH_PASSWORD_LOGIN: 'auto', NODE_ENV: 'development' }, async () => {
      expect(isPasswordLoginEnabled()).toBe(true);
    });
  });

  it('on：production 以租戶人員目錄的帳號登入，簽出的 token 也通過身分驗證', async () => {
    await withEnv({ AUTH_PASSWORD_LOGIN: 'on', NODE_ENV: 'production' }, async () => {
      const tokens = authService.login('staff-001', env.AUTH_DEV_PASSWORD);
      expect(tokens.user).toMatchObject({ id: 'staff-001', name: '王小明' });
      await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).resolves.toBeUndefined();
      await expect(authService.refresh(tokens.refreshToken)).resolves.toBeDefined();
    });
  });

  it('on 時密碼仍要對，錯的照樣擋', async () => {
    await withEnv({ AUTH_PASSWORD_LOGIN: 'on', NODE_ENV: 'production' }, async () => {
      expect(() => authService.login('staff-001', 'wrong-password')).toThrow(/帳號或密碼/);
    });
  });

  it('on 也不會讓內建的開發帳號在 production 登入（目錄沒有就是沒有）', async () => {
    await withEnv({ AUTH_PASSWORD_LOGIN: 'on', NODE_ENV: 'production' }, async () => {
      expect(() => authService.login('kevin', env.AUTH_DEV_PASSWORD)).toThrow(/帳號或密碼/);
    });
  });

  it('off：即使非 production 也擋下登入，並讓先前簽發的 token 失效', async () => {
    const tokens = authService.login('staff-001', env.AUTH_DEV_PASSWORD);
    await withEnv({ AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'development' }, async () => {
      expect(() => authService.login('staff-001', env.AUTH_DEV_PASSWORD)).toThrow(/SSO/);
      await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
    });
  });
});
