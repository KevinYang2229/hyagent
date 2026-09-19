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
// 帳密登入：resolveTenant 解析 API Key（未帶則預設租戶），token 綁該租戶
router.post('/login', loginRateLimit, resolveTenant, validate({ body: loginSchema }), asyncHandler(authController.login));
router.post('/refresh', refreshRateLimit, validate({ body: refreshSchema }), asyncHandler(authController.refresh));

// Identity Assertion → HyAgent Session（規格 §5.3、§7.1）。
// 仍掛 resolveTenant 是為了外觀設定與 CORS，**不**參與身分判定——租戶由 Assertion 的 iss 決定
// （決策 A）。API Key 未帶或屬於別的租戶都不影響換發結果。
router.post(
  '/sso/exchange',
  ssoRateLimit,
  resolveTenant,
  validate({ body: ssoExchangeSchema }),
  asyncHandler(authController.ssoExchange),
);

// 受保護端點
router.get('/me', requireAuth, asyncHandler(authController.me));
// 結束目前 Session（規格 §7.2）。帳密登入的 JWT 打這支是 no-op，回 204 不報錯。
router.post('/logout', requireAuth, asyncHandler(authController.logout));

export const authRouter = router;
