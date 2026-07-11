import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { requireAdmin } from '@/middlewares/require-admin';
import { asyncHandler } from '@/utils/async-handler';
import { formAdminController } from '@/modules/form/form.admin.controller';
import {
  definitionBodySchema,
  tenantFormParamSchema,
} from '@/modules/form/form.admin.schema';
import { knowledgeAdminController } from '@/modules/knowledge/knowledge.admin.controller';
import { ingestSchema, jobParamSchema, queryTestSchema, sourceSchema } from '@/modules/knowledge/knowledge.admin.schema';
import { adminController } from './admin.controller';
import { adminAuthController } from './admin.auth.controller';
import {
  adminLoginSchema,
  createKeySchema,
  createTenantSchema,
  createWebhookSchema,
  patchTenantSchema,
  putPolicySchema,
  tenantParamSchema,
  toggleWebhookSchema,
  webhookParamSchema,
} from './admin.schema';

const router = Router();

// 公開：後台登入（在 requireAdmin 之前註冊，故不受其保護）
router.post('/auth/login', validate({ body: adminLoginSchema }), asyncHandler(adminAuthController.login));

// 以下全部管理端點都需 x-admin-key 或 admin JWT
router.use(requireAdmin);

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

export const adminRouter = router;
