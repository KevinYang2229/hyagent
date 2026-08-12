import http from 'node:http';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { closeDb } from '@/lib/db';
import { initAuditStore } from '@/modules/audit/audit.store';
import { initScopePolicy } from '@/modules/authz/scope-policy';
import { migrateTenantScopes } from '@/modules/authz/scope-migration';
import { cleanupExpiredSessions, initConversationStore } from '@/modules/conversation/conversation.store';
import { initFormStore } from '@/modules/form/form.store';
import { initKnowledgeStore } from '@/modules/knowledge/knowledge.store';
import { purgeFinishedReportJobs } from '@/modules/report/report.job';
import { reportStore } from '@/modules/report/report.store';
import { initTenantStore } from '@/modules/tenant/tenant.store';
import { initUsageStore } from '@/modules/usage/usage.store';
import { initWebhookStore } from '@/modules/webhook/webhook.store';
import { initSubmissionStore } from '@/modules/workflow/submission.store';

async function main(): Promise<void> {
  // DATA_BACKEND=db 時先從 Postgres 還原各 store（file 為 no-op）；失敗即 fail-fast，不帶空資料上線
  await initTenantStore();
  await Promise.all([
    initConversationStore(),
    initSubmissionStore(),
    initUsageStore(),
    initAuditStore(),
    initFormStore(),
    initScopePolicy(),
    initWebhookStore(),
    initKnowledgeStore(),
  ]);

  const app = createApp();

  // 既有租戶的 disabledServices/disabledForms → grantedScopes 一次性遷移；store 已於上方 init 完成。
  migrateTenantScopes();

  // session 保留政策：開機已清一次（initConversationStore），此後每日再跑；unref 不擋關機
  // 報告 TTL 回收（產出物 + job 記錄）比照同一個每日排程：purgeExpired 不呼叫就等於 TTL
  // 只在 get() 讀取時擋讀、資料本體與 job 記錄永遠不刪，與設計文件承諾的「記憶體與 DB 皆然」不符。
  setInterval(() => {
    cleanupExpiredSessions().catch((err) => logger.warn({ err }, 'session cleanup failed'));
    reportStore.purgeExpired();
    purgeFinishedReportJobs();
  }, 24 * 60 * 60 * 1000).unref();

  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV, backend: env.DATA_BACKEND }, 'OA Agent (MVP) listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      // 把各 store 排隊中的 db 寫入沖完再退出，避免最後一批變更遺失
      void closeDb().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
