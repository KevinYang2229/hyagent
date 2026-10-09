import type { Request, Response } from 'express';
import { toErrorResponse } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { logger } from '@/lib/logger';
import { assertionExchange } from './assertion-exchange';
import { authService } from './auth.service';
import { issueGuestSession } from './guest-session';
import type { LoginInput, RefreshInput, SsoExchangeInput } from './auth.schema';

export const authController = {
  // 公開：帳密登入 → access/refresh + 使用者資料
  async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body as LoginInput;
    // 未帶 API Key 時 resolveTenant 會落到預設租戶；租戶決定認得哪些帳號，也決定 token 綁在誰身上
    const result = authService.login(username, password, req.tenant?.id ?? 'default');
    res.status(200).json({ data: result });
  },

  // 公開：以 refresh token 換發新 token（輪替）
  async refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = req.body as RefreshInput;
    const tokens = await authService.refresh(refreshToken);
    res.status(200).json({ data: tokens });
  },

  /**
   * 公開：Identity Assertion → HyAgent Session（規格 §5.3、§7.1）。
   *
   * 租戶由 Assertion 的 `iss` 決定，不是 API Key（決策 A）——所以這裡不看 req.tenant。
   * 錯誤一律走 §7.5 的回應格式（`{ error, message, requestId }`），不是本系統的 AppError 形狀：
   * 客戶端程式要以 `error` 代碼分流，而 §9 的細分代碼是整合期唯一的診斷依據。
   */
  async ssoExchange(req: Request, res: Response): Promise<void> {
    const { assertion, embedOrigin } = req.body as SsoExchangeInput;
    const origin = req.header('origin');
    try {
      const result = await assertionExchange.exchange({
        assertion,
        ...(origin ? { origin } : {}),
        ...(embedOrigin ? { embedOrigin } : {}),
      });
      // 稽核只留可關聯的識別，不留 sub 與 claims 值（規格 §11.1）
      logger.info({ tenantId: result.tenantId, kid: result.kid }, 'assertion exchanged for session');
      res.status(201).json({
        data: {
          sessionToken: result.sessionToken,
          expiresIn: result.expiresIn,
          user: result.user,
        },
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err, req.header('x-request-id') ?? undefined);
      // 失敗只記代碼與狀態：Assertion 原文、金鑰內容與 claims 值都不得進日誌（§11.1）
      if (status >= 500) logger.error({ err }, 'assertion exchange failed');
      else logger.info({ code: body.error, status }, 'assertion exchange rejected');
      res.status(status).json(body);
    }
  },

  /**
   * 公開：免登入訪客 Session。租戶由 resolveTenant 依 pk_ 解出（未帶則預設租戶），須開啟 guestAccess。
   * 回應形狀與 /sso/exchange 相同，客戶端可用同一套 Session 處理。
   */
  async guest(req: Request, res: Response): Promise<void> {
    const result = await issueGuestSession(req.tenant);
    logger.info({ tenantId: req.tenant?.id }, 'guest session issued');
    res.status(201).json({ data: result });
  },

  /** 公開（需帶 Session）：結束目前的 HyAgent Session（規格 §7.2、SDK 的 logout()）。 */
  async logout(req: Request, res: Response): Promise<void> {
    if (req.authSessionToken) await authSessionStore.revoke(req.authSessionToken);
    res.status(204).end();
  },

  // 受保護：回目前登入者資料（前端重整時還原登入狀態）
  async me(req: Request, res: Response): Promise<void> {
    const userId = req.user?.sub ?? '';
    res.status(200).json({ data: authService.me(userId, req.user!.tenantId!) });
  },
};
