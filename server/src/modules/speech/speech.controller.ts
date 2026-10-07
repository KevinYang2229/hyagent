import type { NextFunction, Request, Response } from 'express';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { AppError } from '@/utils/app-error';
import { transcribe } from './speech.service';

/** 權限檢查要放在 multer 之前：沒有 service:agent 就不先收（緩衝）整段錄音。 */
export function requireSpeechScope(req: Request, _res: Response, next: NextFunction): void {
  const tenantId = req.tenant?.id ?? 'default';
  const userId = req.user?.sub ?? '';
  if (!resolveScopes({ tenantId, userId }).includes('service:agent')) {
    next(AppError.forbidden('沒有使用語音對話的權限'));
    return;
  }
  next();
}

export const speechController = {
  async transcribe(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) throw AppError.unprocessable('請附上錄音（欄位 audio）');
    const text = await transcribe({ data: file.buffer, mediaType: file.mimetype });
    res.status(200).json({ data: { text } });
  },
};
