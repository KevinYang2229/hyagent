/**
 * 帳密登入開關（AUTH_PASSWORD_LOGIN）。
 *
 * 前一批安全修正把帳密登入寫死成「production 一律禁用」，但 SSO 需要宿主後端簽票；
 * 宿主端還沒接好時整套面板會完全無法登入。改成顯式開關後，這裡守住兩個方向：
 * 開啟時 production 也能登入、關閉時連先前簽發的 token 都不再被接受。
 */
import request from 'supertest';
import { createApp } from '@/app';
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

  it('帶租戶金鑰登入時 token 綁該租戶，受保護端點不會被判成租戶不符', async () => {
    const tenant = tenantStore.createTenant('password-login-tenant');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, {
      userDirectory: [{ id: 'staff-009', name: '陳大文', department: '資訊部' }],
    });
    const app = createApp();

    const login = await request(app)
      .post('/api/auth/login')
      .set('x-api-key', apiKey.key)
      .send({ username: 'staff-009', password: env.AUTH_DEV_PASSWORD })
      .expect(200);
    expect(login.body.data.user).toMatchObject({ id: 'staff-009', name: '陳大文' });
    expect(verifyAccessToken(login.body.data.accessToken).tenantId).toBe(tenant.id);
    await request(app).get('/api/forms').set('x-api-key', apiKey.key)
      .set('authorization', `Bearer ${login.body.data.accessToken}`).expect(200);
    const refreshed = await request(app).post('/api/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken }).expect(200);
    expect(verifyAccessToken(refreshed.body.data.accessToken).tenantId).toBe(tenant.id);
    await request(app).get('/api/forms').set('x-api-key', apiKey.key)
      .set('authorization', `Bearer ${refreshed.body.data.accessToken}`).expect(200);
    // A valid token still cannot be used with another tenant's routing context.
    await request(app).get('/api/forms')
      .set('authorization', `Bearer ${refreshed.body.data.accessToken}`).expect(401);


    // 同一把金鑰打受保護端點：token 綁 default 的話這裡會是 401 Token tenant mismatch
    await request(app)
      .get('/api/auth/me')
      .set('x-api-key', apiKey.key)
      .set('authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200);
  });

  it('租戶沒設人員目錄就沒有任何帳號可登入', async () => {
    const tenant = tenantStore.createTenant('password-login-no-directory');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    const app = createApp();

    await request(app)
      .post('/api/auth/login')
      .set('x-api-key', apiKey.key)
      .send({ username: 'staff-001', password: env.AUTH_DEV_PASSWORD })
      .expect(401);
  });

  it('帳號被移出租戶目錄後，先前簽發的 token 立即失效', async () => {
    const tokens = authService.login('staff-001', env.AUTH_DEV_PASSWORD);
    tenantStore.updateTenant('default', { userDirectory: [] });
    await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
  });

  it('off：即使非 production 也擋下登入，並讓先前簽發的 token 失效', async () => {
    const tokens = authService.login('staff-001', env.AUTH_DEV_PASSWORD);
    await withEnv({ AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'development' }, async () => {
      expect(() => authService.login('staff-001', env.AUTH_DEV_PASSWORD)).toThrow(/SSO/);
      await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
    });
  });
});
