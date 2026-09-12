import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { authService } from './auth.service';
import type { LoginInput, RefreshInput, SsoExchangeInput } from './auth.schema';

export const authController = {
  // 公開：帳密登入 → access/refresh + 使用者資料
  async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body as LoginInput;
    const result = authService.login(username, password);
    res.status(200).json({ data: result });
  },

  // 公開：以 refresh token 換發新 token（輪替）
  async refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = req.body as RefreshInput;
    const tokens = await authService.refresh(refreshToken);
    res.status(200).json({ data: tokens });
  },

  // 公開（需帶 API Key 解析租戶）：SSO handoff，宿主簽發的 user token → 換發本系統 token
  async ssoExchange(req: Request, res: Response): Promise<void> {
    const tenant = req.tenant;
    if (!tenant) throw AppError.unauthorized('缺少 API Key，無法解析租戶');
    const { userToken } = req.body as SsoExchangeInput;
    const tokens = authService.ssoExchange(tenant, userToken);
    res.status(200).json({ data: tokens });
  },

  // 受保護：回目前登入者資料（前端重整時還原登入狀態）
  async me(req: Request, res: Response): Promise<void> {
    const userId = req.user?.sub ?? '';
    res.status(200).json({ data: authService.me(userId, req.user!.tenantId!) });
  },
};
