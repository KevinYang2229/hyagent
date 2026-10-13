/** 後台回饋：清單、統計、處理狀態。PATCH 由 admin router 的 adminAuditTrail 自動寫稽核。 */
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import {
  adminFeedbackListQuerySchema,
  adminFeedbackStatsQuerySchema,
  patchFeedbackSchema,
} from './feedback.schema';
import { feedbackStore } from './feedback.store';

function tenantIdOf(req: Request): string {
  const id = String(req.params.id);
  if (!tenantStore.getTenant(id)) throw AppError.notFound('Tenant not found');
  return id;
}

export const feedbackAdminController = {
  async list(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { before, limit, ...filter } = adminFeedbackListQuerySchema.parse(req.query);
    res.status(200).json({ data: feedbackStore.list(tenantId, filter, { before, limit }) });
  },

  async stats(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { days } = adminFeedbackStatsQuerySchema.parse(req.query);
    res.status(200).json({ data: feedbackStore.stats(tenantId, days) });
  },

  async update(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { status, resolutionNote } = patchFeedbackSchema.parse(req.body);
    const updated = feedbackStore.setStatus(tenantId, String(req.params.feedbackId), status, resolutionNote);
    if (!updated) throw AppError.notFound('回饋不存在');
    res.status(200).json({ data: updated });
  },
};
