import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { authService } from '@/modules/auth/auth.service';
import { validateIdentity } from '@/modules/auth/credential-version';
import { verifyAccessToken } from '@/utils/jwt';

// Use small quotas, retaining the actual IP limiter and production route wiring.
jest.mock('@/middlewares/auth-rate-limit', () => {
  const { makeAuthRateLimit } = jest.requireActual('@/middlewares/auth-rate-limit');
  return { makeAuthRateLimit, loginRateLimit: makeAuthRateLimit(2), adminLoginRateLimit: makeAuthRateLimit(2), ssoRateLimit: makeAuthRateLimit(2), refreshRateLimit: makeAuthRateLimit(2) };
});

it('login, admin, SSO and refresh routes limit requests even with changing identities', async () => {
  const app = createApp();
  for (const path of ['/api/auth/login', '/api/admin/auth/login', '/api/auth/sso/exchange', '/api/auth/refresh']) {
    const responses = [];
    for (let i = 0; i < 3; i++) responses.push(await request(app).post(path).set('x-user-id', `user-${i}`).send({ username: `user-${i}`, password: 'wrong', userToken: 'bad', refreshToken: 'bad' }));
    expect(responses[0].status).not.toBe(429);
    expect(responses[1].status).not.toBe(429);
    expect(responses[2].status).toBe(429);
    expect(responses[2].headers['retry-after']).toBeDefined();
  }
});

it('production disables development login and previously issued password tokens', async () => {
  const tokens = authService.login('kevin', env.AUTH_DEV_PASSWORD);
  const previous = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    expect(() => authService.login('kevin', env.AUTH_DEV_PASSWORD)).toThrow(/SSO/);
    await expect(validateIdentity(verifyAccessToken(tokens.accessToken))).rejects.toThrow();
    await expect(authService.refresh(tokens.refreshToken)).rejects.toThrow();
  } finally { env.NODE_ENV = previous; }
});
