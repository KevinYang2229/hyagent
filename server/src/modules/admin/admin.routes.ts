import { userAdminRouter } from '@/modules/user/user.admin';
import { adminLoginRateLimit } from '@/middlewares/auth-rate-limit';
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { validate } from '@/middlewares/validate';
import { requireAdmin } from '@/middlewares/require-admin';
import { adminAuditTrail } from '@/modules/audit/admin-audit';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';
import { formAdminController } from '@/modules/form/form.admin.controller';
import {
  definitionBodySchema,
  tenantFormParamSchema,
} from '@/modules/form/form.admin.schema';
import { feedbackAdminController } from '@/modules/feedback/feedback.admin.controller';
import {
  adminFeedbackListQuerySchema,
  adminFeedbackParamSchema,
  adminFeedbackStatsQuerySchema,
  patchFeedbackSchema,
} from '@/modules/feedback/feedback.schema';
import { knowledgeAdminController } from '@/modules/knowledge/knowledge.admin.controller';
import {
  fileParamSchema,
  fileVisibilitySchema,
  ingestSchema,
  jobParamSchema,
  labelCreateSchema,
  labelParamSchema,
  labelUpdateSchema,
  queryTestSchema,
  sourceSchema,
  suggestionManualSchema,
  customSuggestionSchema,
  customSuggestionParamSchema,
  suggestionRefreshSchema,
} from '@/modules/knowledge/knowledge.admin.schema';
import { putLlmConfigSchema } from '@/modules/tenant/llm-config.schema';
import { mcpAdminController } from '@/modules/mcp/mcp.admin.controller';
import { createMcpServerSchema, mcpServerParamSchema, patchMcpServerSchema } from '@/modules/mcp/mcp.admin.schema';
import { adminController } from './admin.controller';
import { adminAuthController } from './admin.auth.controller';
import {
  adminLoginSchema,
  createKeySchema,
  addPublicKeySchema,
  createTenantSchema,
  listSessionsQuerySchema,
  patchAssertionSettingsSchema,
  revokeSessionsSchema,
  sessionParamSchema,
  revokePublicKeySchema,
  tenantKeyParamSchema,
  adminReportQuerySchema,
  auditPageQuerySchema,
  createWebhookSchema,
  patchTenantSchema,
  putPolicySchema,
  tenantParamSchema,
  toggleWebhookSchema,
  webhookParamSchema,
} from './admin.schema';

const router = Router();

/**
 * 知識庫檔案上傳限制：memoryStorage、單檔 10MB。
 * 格式白名單交由 knowledge/doc-parse 的 SUPPORTED_EXTENSIONS 依副檔名＋magic bytes 把關（400），
 * 這裡只把關檔案大小/數量，multer 的 MulterError 轉成統一 AppError（超限 413、其他 400）。
 */
const KNOWLEDGE_FILE_MAX_MB = 10;
const knowledgeFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: KNOWLEDGE_FILE_MAX_MB * 1024 * 1024, files: 1 },
});

function uploadKnowledgeFile(req: Request, res: Response, next: NextFunction): void {
  knowledgeFileUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT'
          ? AppError.payloadTooLarge(`檔案超過上限 ${KNOWLEDGE_FILE_MAX_MB}MB`)
          : AppError.badRequest(`上傳失敗：${err.message}`),
      );
      return;
    }
    next(err);
  });
}

// 公開：後台登入（在 requireAdmin 之前註冊，故不受其保護）
router.post('/auth/login', adminLoginRateLimit, validate({ body: adminLoginSchema }), asyncHandler(adminAuthController.login));

// 以下全部管理端點都需 x-admin-key 或 admin JWT
router.use(requireAdmin);
// 設定變更稽核：在所有管理端點之前掛上，新增端點不會漏記（見 audit/admin-audit.ts）
router.use(adminAuditTrail);
router.use('/tenants/:id/users', userAdminRouter);

// 平台層稽核（建立／刪除租戶、MCP 服務等）；租戶層稽核見 /tenants/:id/audit
router.get('/audit', validate({ query: auditPageQuerySchema }), asyncHandler(adminController.getPlatformAudit));

// Skill Library（唯讀）：平台所有 skill 的正式描述 + 各租戶啟用狀態
router.get('/skills', asyncHandler(adminController.listSkills));

// MCP 服務（平台層）：登記、修改、刪除、重新整理工具清單
router.get('/mcp-servers', asyncHandler(mcpAdminController.list));
router.post('/mcp-servers', validate({ body: createMcpServerSchema }), asyncHandler(mcpAdminController.create));
router.patch(
  '/mcp-servers/:serverId',
  validate({ params: mcpServerParamSchema, body: patchMcpServerSchema }),
  asyncHandler(mcpAdminController.update),
);
router.delete('/mcp-servers/:serverId', validate({ params: mcpServerParamSchema }), asyncHandler(mcpAdminController.remove));
router.post('/mcp-servers/:serverId/refresh', validate({ params: mcpServerParamSchema }), asyncHandler(mcpAdminController.refresh));

router.post('/tenants', validate({ body: createTenantSchema }), asyncHandler(adminController.createTenant));
router.get('/tenants', asyncHandler(adminController.listTenants));

router.patch(
  '/tenants/:id',
  validate({ params: tenantParamSchema, body: patchTenantSchema }),
  asyncHandler(adminController.updateTenant),
);

router.delete(
  '/tenants/:id',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.deleteTenant),
);

// ── Assertion 公鑰與逐租戶設定（規格 §7.3、§7.4；僅後台，不對外開放等效 API）──
router.get(
  '/tenants/:id/assertion-keys',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.listPublicKeys),
);
router.post(
  '/tenants/:id/assertion-keys',
  validate({ params: tenantParamSchema, body: addPublicKeySchema }),
  asyncHandler(adminController.addPublicKey),
);
router.post(
  '/tenants/:id/assertion-keys/:kid/revoke',
  validate({ params: tenantKeyParamSchema, body: revokePublicKeySchema }),
  asyncHandler(adminController.revokePublicKey),
);
router.patch(
  '/tenants/:id/assertion-settings',
  validate({ params: tenantParamSchema, body: patchAssertionSettingsSchema }),
  asyncHandler(adminController.updateAssertionSettings),
);
router.get(
  '/tenants/:id/sessions',
  validate({ params: tenantParamSchema, query: listSessionsQuerySchema }),
  asyncHandler(adminController.listSessions),
);
router.post(
  '/tenants/:id/sessions/revoke',
  validate({ params: tenantParamSchema, body: revokeSessionsSchema }),
  asyncHandler(adminController.revokeSessionsBySub),
);
// 字面路徑排在 :sessionId 之前。這兩支方法不同（POST / DELETE）本來就不會互相吃掉，
// 維持這個順序是為了日後有人補上 POST /sessions/:sessionId 時不必重新想一次。
router.delete(
  '/tenants/:id/sessions/:sessionId',
  validate({ params: sessionParamSchema }),
  asyncHandler(adminController.revokeSession),
);

router.post(
  '/tenants/:id/keys',
  validate({ params: tenantParamSchema, body: createKeySchema }),
  asyncHandler(adminController.createKey),
);

router.post(
  '/tenants/:id/webhooks',
  validate({ params: tenantParamSchema, body: createWebhookSchema }),
  asyncHandler(adminController.createWebhook),
);
router.get(
  '/tenants/:id/webhooks',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.listWebhooks),
);
router.delete(
  '/tenants/:id/webhooks/:webhookId',
  validate({ params: webhookParamSchema }),
  asyncHandler(adminController.deleteWebhook),
);
router.patch(
  '/tenants/:id/webhooks/:webhookId',
  validate({ params: webhookParamSchema, body: toggleWebhookSchema }),
  asyncHandler(adminController.setWebhookEnabled),
);

router.get(
  '/tenants/:id/usage',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getUsage),
);

router.get(
  '/tenants/:id/audit',
  validate({ params: tenantParamSchema, query: auditPageQuerySchema }),
  asyncHandler(adminController.getAudit),
);

// AI 回覆回饋：統計、清單（游標分頁）、處理狀態
router.get(
  '/tenants/:id/feedback/stats',
  validate({ params: tenantParamSchema, query: adminFeedbackStatsQuerySchema }),
  asyncHandler(feedbackAdminController.stats),
);
router.get(
  '/tenants/:id/feedback',
  validate({ params: tenantParamSchema, query: adminFeedbackListQuerySchema }),
  asyncHandler(feedbackAdminController.list),
);
router.patch(
  '/tenants/:id/feedback/:feedbackId',
  validate({ params: adminFeedbackParamSchema, body: patchFeedbackSchema }),
  asyncHandler(feedbackAdminController.update),
);

// AI 模型設定（BYO key）：admin 代租戶讀寫，與 sk_ 自助端點共用 llmConfigService
router.get(
  '/tenants/:id/llm-config',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getLlmConfig),
);
router.put(
  '/tenants/:id/llm-config',
  validate({ params: tenantParamSchema, body: putLlmConfigSchema }),
  asyncHandler(adminController.putLlmConfig),
);

// 報告：清單查詢（時間區間 + 關鍵字）與下載（不做建立者比對，改以稽核留軌跡）
router.get(
  '/tenants/:id/reports',
  validate({ params: tenantParamSchema, query: adminReportQuerySchema }),
  asyncHandler(adminController.listReports),
);
router.get(
  '/tenants/:id/reports/:reportId/download',
  validate({ params: tenantParamSchema.extend({ reportId: z.string().min(1) }) }),
  asyncHandler(adminController.downloadReport),
);

// 權限：scopes 目錄 + 每租戶政策 GET/PUT
router.get('/scopes', asyncHandler(adminController.listScopes));

router.get(
  '/tenants/:id/policy',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getPolicy),
);
router.put(
  '/tenants/:id/policy',
  validate({ params: tenantParamSchema, body: putPolicySchema }),
  asyncHandler(adminController.setPolicy),
);

// ---- Form Designer：租戶表單 CRUD + 匯出 ----
router.get(
  '/tenants/:id/forms',
  validate({ params: tenantParamSchema }),
  asyncHandler(formAdminController.list),
);
router.post(
  '/tenants/:id/forms',
  validate({ params: tenantParamSchema, body: definitionBodySchema }),
  asyncHandler(formAdminController.create),
);
router.get(
  '/tenants/:id/forms/:formId',
  validate({ params: tenantFormParamSchema }),
  asyncHandler(formAdminController.get),
);
router.put(
  '/tenants/:id/forms/:formId',
  validate({ params: tenantFormParamSchema, body: definitionBodySchema }),
  asyncHandler(formAdminController.update),
);
router.delete(
  '/tenants/:id/forms/:formId',
  validate({ params: tenantFormParamSchema }),
  asyncHandler(formAdminController.remove),
);
router.get(
  '/tenants/:id/forms/:formId/export',
  validate({ params: tenantFormParamSchema }),
  asyncHandler(formAdminController.export),
);

// ---- 知識庫 RAG：每租戶來源設定 / 觸發解析 / 進度 / 測試查詢 / 清除 ----
router.get(
  '/tenants/:id/knowledge',
  validate({ params: tenantParamSchema }),
  asyncHandler(knowledgeAdminController.get),
);
router.put(
  '/tenants/:id/knowledge/source',
  validate({ params: tenantParamSchema, body: sourceSchema }),
  asyncHandler(knowledgeAdminController.saveSource),
);
router.post(
  '/tenants/:id/knowledge/ingest',
  validate({ params: tenantParamSchema, body: ingestSchema }),
  asyncHandler(knowledgeAdminController.ingest),
);
router.get(
  '/tenants/:id/knowledge/jobs/:jobId',
  validate({ params: jobParamSchema }),
  asyncHandler(knowledgeAdminController.job),
);
router.post(
  '/tenants/:id/knowledge/query-test',
  validate({ params: tenantParamSchema, body: queryTestSchema }),
  asyncHandler(knowledgeAdminController.queryTest),
);
router.delete(
  '/tenants/:id/knowledge',
  validate({ params: tenantParamSchema }),
  asyncHandler(knowledgeAdminController.remove),
);
router.post(
  '/tenants/:id/knowledge/suggestion',
  validate({ params: tenantParamSchema, body: suggestionRefreshSchema }),
  asyncHandler(knowledgeAdminController.refreshSuggestion),
);
router.put(
  '/tenants/:id/knowledge/suggestion',
  validate({ params: tenantParamSchema, body: suggestionManualSchema }),
  asyncHandler(knowledgeAdminController.setSuggestionManual),
);
router.post(
  '/tenants/:id/knowledge/custom-suggestions',
  validate({ params: tenantParamSchema, body: customSuggestionSchema }),
  asyncHandler(knowledgeAdminController.createCustomSuggestion),
);
router.put(
  '/tenants/:id/knowledge/custom-suggestions/:promptId',
  validate({ params: customSuggestionParamSchema, body: customSuggestionSchema }),
  asyncHandler(knowledgeAdminController.updateCustomSuggestion),
);
router.delete(
  '/tenants/:id/knowledge/custom-suggestions/:promptId',
  validate({ params: customSuggestionParamSchema }),
  asyncHandler(knowledgeAdminController.deleteCustomSuggestion),
);
router.post(
  '/tenants/:id/knowledge/files',
  validate({ params: tenantParamSchema }),
  uploadKnowledgeFile,
  asyncHandler(knowledgeAdminController.uploadFile),
);
router.delete(
  '/tenants/:id/knowledge/files/:fileId',
  validate({ params: fileParamSchema }),
  asyncHandler(knowledgeAdminController.deleteFile),
);

// ---- 知識庫可見性標籤：CRUD + 檔案標註 ----
router.get(
  '/tenants/:id/knowledge/labels',
  validate({ params: tenantParamSchema }),
  asyncHandler(knowledgeAdminController.listLabels),
);
router.post(
  '/tenants/:id/knowledge/labels',
  validate({ params: tenantParamSchema, body: labelCreateSchema }),
  asyncHandler(knowledgeAdminController.createLabel),
);
router.patch(
  '/tenants/:id/knowledge/labels/:labelId',
  validate({ params: labelParamSchema, body: labelUpdateSchema }),
  asyncHandler(knowledgeAdminController.updateLabel),
);
router.delete(
  '/tenants/:id/knowledge/labels/:labelId',
  validate({ params: labelParamSchema }),
  asyncHandler(knowledgeAdminController.deleteLabel),
);
router.patch(
  '/tenants/:id/knowledge/files/:fileId/visibility',
  validate({ params: fileParamSchema, body: fileVisibilitySchema }),
  asyncHandler(knowledgeAdminController.setFileVisibilityHandler),
);
router.get(
  '/tenants/:id/knowledge/acl-report',
  validate({ params: tenantParamSchema }),
  asyncHandler(knowledgeAdminController.aclReport),
);

export const adminRouter = router;
