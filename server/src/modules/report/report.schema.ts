import { z } from 'zod';
import { REPORT_FORMATS } from './report.render';

export const reportIdParamSchema = z.object({ id: z.string().min(1) });

/**
 * format 白名單直接由 renderer 登錄表推導——不另外手寫一份格式清單，
 * 多一份就多一個新增格式時會漏改的地方。
 */
export const downloadQuerySchema = z.object({
  format: z.enum(REPORT_FORMATS as [string, ...string[]]).optional(),
});
