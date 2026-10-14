import { asyncHandler } from '@/utils/async-handler';
import { conversationController } from '@/modules/conversation/conversation.controller';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { openapiSpec } from '@/modules/docs/openapi';
import { env } from '@/config/env';
import { pingDb } from '@/lib/db';
import { requestLogger } from '@/middlewares/request-logger';
import { errorHandler, notFoundHandler } from '@/middlewares/error-handler';
import { requireAuth } from '@/middlewares/require-auth';
import { resolveTenant } from '@/middlewares/resolve-tenant';
import { tenantRateLimit } from '@/middlewares/tenant-rate-limit';
import { tenantMonthlyQuota } from '@/middlewares/tenant-quota';
import { tenantService } from '@/modules/tenant/tenant.service';
import { authRouter } from '@/modules/auth/auth.routes';
import { mcpPublicRouter } from '@/modules/mcp/mcp.routes';
import { feedbackRouter } from '@/modules/feedback/feedback.routes';
import { conversationRouter } from '@/modules/conversation/conversation.routes';
import { visionRouter } from '@/modules/vision/vision.routes';
import { formRouter } from '@/modules/form/form.routes';
import { knowledgeMemberRouter } from '@/modules/knowledge/knowledge.member.routes';
import { notificationsRouter } from '@/modules/notifications/notifications.routes';
import { skillsRouter } from '@/modules/skills/skills.routes';
import { tasksRouter } from '@/modules/tasks/tasks.routes';
import { reportRouter } from '@/modules/report/report.routes';
import { leaveRouter } from '@/modules/leave/leave.routes';
import { adminRouter } from '@/modules/admin/admin.routes';
import { widgetRouter } from '@/modules/widget/widget.routes';
import { tenantSelfRouter } from '@/modules/tenant/tenant.routes';
import { toolInvokeRouter } from '@/modules/tools/tool-invoke.routes';
import { speechRouter } from '@/modules/speech/speech.routes';

/**
 * MVP app：只掛對話與表單路由，不連 DB / Redis / Socket。
 * 之後接 Prisma/Redis 時，把對應 router 與 infra 加回即可。
 */
export function createApp(): Express {
  const app = express();
  if (env.TRUST_PROXY.trim()) app.set('trust proxy', env.TRUST_PROXY.split(',').map((p) => p.trim()).filter(Boolean));

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

  // 存活檢查（liveness）：process 有回應即 200。server 能啟動即代表 LLM provider 的 API key
  // 通過 env 驗證（見 config/env fail-fast），故回報 provider/model 供前端顯示「AI 已連線」。
  // 此處不實際呼叫 LLM、不查 DB，避免額外費用與延遲——依賴健康度由 /readyz 負責。
  // 同時掛 /api/healthz：Google Cloud Run 的前端（GFE）會攔截根路徑「精確的 /healthz」
  // 自行回 404，請求根本進不到容器（實測 /healthz/ 與 /HEALTHZ 都正常，只有這一條被攔）。
  // 根路徑保留給 Zeabur/K8s 等以 /healthz 做探針的平台，前端一律改探 /api/healthz。
  app.get(['/healthz', '/api/healthz'], (_req, res) => {
    res.status(200).json({
      status: 'ok',
      llm: { provider: env.LLM_PROVIDER, model: env.LLM_MODEL },
    });
  });

  // 就緒檢查（readiness）：確認外部依賴可服務——db 模式下實際 ping 資料庫，不可達回 503，
  // 讓編排器（Zeabur/K8s）在 DB 斷線時停止導流。file 模式無外部依賴，恆 ready。
  app.get(['/readyz', '/api/readyz'], async (_req, res) => {
    const dbOk = await pingDb();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ready' : 'unready',
      backend: env.DATA_BACKEND,
      checks: { db: dbOk ? 'ok' : 'down' },
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
  // MCP 呼叫 JWT 的公鑰（MCP server 驗章用；公開、不需登入）
  app.use(mcpPublicRouter);
  app.use('/api/auth', authRouter);

  // 受保護：需帶有效 access token 才能操作
  // resolveTenant 先解析 API Key → 租戶（未帶 key 落到預設租戶，向後相容），
  // requireAuth 驗證使用者身分後 tenantRateLimit 依「租戶＋使用者」限流；
  // conversations 會觸發 LLM 計費，再加 tenantMonthlyQuota 月配額守門
  // AI 回覆評價不呼叫 LLM，不掛月配額（spec §2.3）：須在 conversations 之前掛；只掛 replies 子路徑，其他請求不會重複經過限流
  app.use('/api/conversations/:id/replies', resolveTenant, requireAuth, tenantRateLimit, feedbackRouter);
  app.post('/api/conversations/queries/:queryId/stop', resolveTenant, requireAuth, tenantRateLimit, asyncHandler(conversationController.stopQuery));
  app.use('/api/conversations', resolveTenant, requireAuth, tenantRateLimit, tenantMonthlyQuota, conversationRouter);
  // 影像辨識（貨架／優惠券）：呼叫 LLM 計費，與對話同樣套月配額
  app.use('/api/vision', resolveTenant, requireAuth, tenantRateLimit, tenantMonthlyQuota, visionRouter);
  app.use('/api/tools', resolveTenant, requireAuth, tenantRateLimit, toolInvokeRouter);
  app.use('/api/speech', resolveTenant, requireAuth, tenantRateLimit, tenantMonthlyQuota, speechRouter);
  app.use('/api/forms', resolveTenant, requireAuth, tenantRateLimit, formRouter);

  // 報告：狀態查詢與下載。不掛 tenantMonthlyQuota——那是對話輪次額度，
  // 報告的成本已由同租戶單一任務與節數上限守住
  app.use('/api/notifications', resolveTenant, requireAuth, tenantRateLimit, notificationsRouter);
  app.use('/api/skills', resolveTenant, requireAuth, tenantRateLimit, skillsRouter);
  // 知識庫（登入者視角）：開場推薦詞的開關要用本人的權限判定，免登入的 /api/widget/config 做不到
  app.use('/api/knowledge', resolveTenant, requireAuth, tenantRateLimit, knowledgeMemberRouter);
  app.use('/api/tasks', resolveTenant, requireAuth, tenantRateLimit, tasksRouter);
  app.use('/api/reports', resolveTenant, requireAuth, tenantRateLimit, reportRouter);
  app.use('/api/leave', resolveTenant, requireAuth, leaveRouter);

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
