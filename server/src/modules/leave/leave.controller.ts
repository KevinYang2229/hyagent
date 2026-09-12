import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { leaveService } from './leave.service';

// 與 conversation.controller 一致：未掛 JWT 時取 x-user-id header
function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

export const leaveController = {
  /** 各假別剩餘時數 */
  async balances(req: Request, res: Response): Promise<void> {
    if (req.user?.via !== 'password' || req.tenant?.id !== 'default') {
      throw AppError.forbidden('此假別查詢僅供內部帳號使用');
    }
    const userId = resolveUserId(req);
    const data = await leaveService.getBalances(userId);
    res.status(200).json({ data });
  },
};
