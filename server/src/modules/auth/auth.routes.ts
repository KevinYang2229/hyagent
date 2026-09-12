import { loginRateLimit, ssoRateLimit, refreshRateLimit } from '@/middlewares/auth-rate-limit';
import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { requireAuth } from '@/middlewares/require-auth';
import { resolveTenant } from '@/middlewares/resolve-tenant';
import { asyncHandler } from '@/utils/async-handler';
import { authController } from './auth.controller';
import { loginSchema, refreshSchema, ssoExchangeSchema } from './auth.schema';

const router = Router();

// 公開端點
router.post('/login', loginRateLimit, validate({ body: loginSchema }), asyncHandler(authController.login));
router.post('/refresh', refreshRateLimit, validate({ body: refreshSchema }), asyncHandler(authController.refresh));

// SSO handoff：需帶 API Key（resolveTenant 解析租戶）→ 驗宿主 user token → 換發本系統 token
router.post(
  '/sso/exchange',
  ssoRateLimit,
  resolveTenant,
  validate({ body: ssoExchangeSchema }),
  asyncHandler(authController.ssoExchange),
);

// 受保護端點
router.get('/me', requireAuth, asyncHandler(authController.me));

export const authRouter = router;
