import http from 'node:http';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { migrateTenantScopes } from '@/modules/authz/scope-migration';

const app = createApp();

// 既有租戶的 disabledServices/disabledForms → grantedScopes 一次性遷移；store 已於上方 import 載入完成。
migrateTenantScopes();

const server = http.createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'OA Agent (MVP) listening');
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
