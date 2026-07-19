import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { openapiSpec } from '@/modules/docs/openapi';
import { env } from '@/config/env';
import { requestLogger } from '@/middlewares/request-logger';
import { errorHandler, notFoundHandler } from '@/middlewares/error-handler';
import { requireAuth } from '@/middlewares/require-auth';
import { resolveTenant } from '@/middlewares/resolve-tenant';
import { tenantRateLimit } from '@/middlewares/tenant-rate-limit';
import { tenantMonthlyQuota } from '@/middlewares/tenant-quota';
import { tenantService } from '@/modules/tenant/tenant.service';
import { authRouter } from '@/modules/auth/auth.routes';
import { conversationRouter } from '@/modules/conversation/conversation.routes';
import { formRouter } from '@/modules/form/form.routes';
import { leaveRouter } from '@/modules/leave/leave.routes';
import { adminRouter } from '@/modules/admin/admin.routes';
import { widgetRouter } from '@/modules/widget/widget.routes';
import { tenantSelfRouter } from '@/modules/tenant/tenant.routes';

/**
 * MVP app：只掛對話與表單路由，不連 DB / Redis / Socket。
 * 之後接 Prisma/Redis 時，把對應 router 與 infra 加回即可。
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  // 動態 CORS：放行來源 = 第一方設定（CORS_ORIGIN，SPA 自身）∪ 任一租戶的 allowedOrigins。
  // 預設租戶為 '*' 時恆放行，維持改造前行為（向後相容）；租戶收緊網域後，CORS 隨之收緊。
  // 真正的資料隔離由 resolveTenant（API Key）在路由層把關，此處僅為瀏覽器層閘門。
  const firstPartyOrigins =
    env.CORS_ORIGIN === '*'
      ? '*'
      : env.CORS_ORIGIN.split(',')
          .map((s) => s.trim().replace(/\/+$/, ''))
          .filter(Boolean);
  app.use(
    cors((req, callback) => {
      const origin = req.header('origin');
      // 同源或非瀏覽器請求（無 Origin，如 curl / server-to-server）一律放行
      if (!origin) {
        callback(null, { origin: true, credentials: true });
        return;
      }
      const stripped = origin.replace(/\/+$/, '');
      const allowed =
        firstPartyOrigins === '*' ||
        (Array.isArray(firstPartyOrigins) && firstPartyOrigins.includes(stripped)) ||
        tenantService.isOriginAllowedByAnyTenant(origin);
      // 允許則回 origin: true（反射來源），否則 false（瀏覽器擋下）
      callback(null, { origin: allowed, credentials: true });
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // 健康檢查：server 能啟動即代表 LLM provider 的 API key 通過 env 驗證（見 config/env fail-fast），
  // 故回報 provider/model 供前端顯示「AI 已連線」。此處不實際呼叫 LLM，避免額外費用與延遲。
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      llm: { provider: env.LLM_PROVIDER, model: env.LLM_MODEL },
    });
  });

  // 向後相容：舊版路徑帶 /v1 前綴（/api/v1/*）內部改寫為 /api/*。
  // 用改寫而非 HTTP 轉址，同一次請求即處理完成，保留 method / body / headers。
  // 掛在根路徑手動改寫 req.url（避免 app.use('/api/v1') 於 next() 還原前綴）。
  // 待確認外部串接皆已改用無 /v1 的路徑後可移除。
  app.use((req, _res, next) => {
    req.url = req.url.replace(/^\/api\/v1(\/|\?|$)/, '/api$1');
    next();
  });

  // API 文件（互動式）：OpenAPI 規格 + Swagger UI
  app.get('/api/openapi.json', (_req, res) => res.status(200).json(openapiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec as object));

  // 公開：登入 / 換發 token
  app.use('/api/auth', authRouter);

  // 受保護：需帶有效 access token 才能操作
  // resolveTenant 先解析 API Key → 租戶（未帶 key 落到預設租戶，向後相容），
  // requireAuth 驗證使用者身分後 tenantRateLimit 依「租戶＋使用者」限流；
  // conversations 會觸發 LLM 計費，再加 tenantMonthlyQuota 月配額守門
  app.use('/api/conversations', resolveTenant, requireAuth, tenantRateLimit, tenantMonthlyQuota, conversationRouter);
  app.use('/api/forms', resolveTenant, requireAuth, tenantRateLimit, formRouter);
  app.use('/api/leave', requireAuth, leaveRouter);

  // 公開 widget 設定：resolveTenant 以 ?key=pk_ 解租戶，無 requireAuth（widget 載入即可讀外觀）
  app.use('/api/widget', resolveTenant, widgetRouter);

  // 租戶自助設定：resolveTenant 解析 sk_（controller 內強制 secret）；無 requireAuth（整合方伺服器對伺服器）
  app.use('/api/tenant', resolveTenant, tenantRateLimit, tenantSelfRouter);

  // 管理 API：建立租戶 / 金鑰 / webhook、查用量（自帶 requireAdmin，x-admin-key 保護）
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
