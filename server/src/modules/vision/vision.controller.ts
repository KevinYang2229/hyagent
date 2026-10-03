import type { Request, Response } from 'express';
import { z } from 'zod';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { AppError } from '@/utils/app-error';
import { analyzeCoupon, analyzeShelf } from './vision.service';
import type { VisionMediaType } from './vision.types';

export const analyzeBodySchema = z.object({ mode: z.enum(['shelf', 'coupon']) });

export const visionController = {
  async analyze(req: Request, res: Response): Promise<void> {
    const tenantId = req.tenant?.id ?? 'default';
    const userId = req.user?.sub ?? '';
    if (!resolveScopes({ tenantId, userId }).includes('service:agent')) {
      throw AppError.forbidden('沒有使用影像辨識的權限');
    }
    const file = req.file;
    if (!file) throw AppError.unprocessable('請附上圖片（欄位 image）');
    const { mode } = req.body as z.infer<typeof analyzeBodySchema>;
    const image = { mediaType: file.mimetype as VisionMediaType, data: file.buffer };
    const data = mode === 'shelf' ? await analyzeShelf({ tenantId, userId }, image) : await analyzeCoupon({ tenantId, userId }, image);
    res.status(200).json({ data });
  },
};
