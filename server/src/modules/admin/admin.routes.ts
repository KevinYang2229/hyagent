import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { validate } from '@/middlewares/validate';
import { requireAdmin } from '@/middlewares/require-admin';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';
import { formAdminController } from '@/modules/form/form.admin.controller';
import {
  definitionBodySchema,
  tenantFormParamSchema,
} from '@/modules/form/form.admin.schema';
import { knowledgeAdminController } from '@/modules/knowledge/knowledge.admin.controller';
import {
  fileParamSchema,
  ingestSchema,
  jobParamSchema,
  queryTestSchema,
  sourceSchema,
  suggestionManualSchema,
  suggestionRefreshSchema,
} from '@/modules/knowledge/knowledge.admin.schema';
import { putLlmConfigSchema } from '@/modules/tenant/llm-config.schema';
import { adminController } from './admin.controller';
import { adminAuthController } from './admin.auth.controller';
import {
  adminLoginSchema,
  createKeySchema,
  createTenantSchema,
  adminReportQuerySchema,
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
router.post('/auth/login', validate({ body: adminLoginSchema }), asyncHandler(adminAuthController.login));

// 以下全部管理端點都需 x-admin-key 或 admin JWT
router.use(requireAdmin);

// Skill Library（唯讀）：平台所有 skill 的正式描述 + 各租戶啟用狀態
router.get('/skills', asyncHandler(adminController.listSkills));

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
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getAudit),
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

export const adminRouter = router;
