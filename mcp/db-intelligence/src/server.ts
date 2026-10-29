/**
 * 執行：DBI_DS_PROJECT_01_URL=postgres://hyagent_reader:...@localhost:54330/projects \
 *       HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=db-intelligence PORT=4300 npm start -w mcp/db-intelligence
 *
 * 執行期設定（資料來源／政策／使用者目錄）存在 DBI_DATA_DIR/state.json，由 HyAgent 後台經 /admin 管理；
 * 首次啟動以 DBI_CONFIG（預設 config/demo.json）為種子。Catalog 存在同一目錄。
 */
import path from 'node:path';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createDbIntelligenceApp } from './app';
import { ConsoleAuditSink, multiAuditSink, RingAuditSink } from './audit';
import { FileCatalogStore } from './catalog/store';
import { loadConfig } from './config';
import { PoolRegistry } from './pools';
import { PostgresExecutor } from './query/executor';
import { DbIntelligenceService, directoryResolver } from './service';
import { fileState } from './state';

const rawPort = process.env.PORT?.trim() || '4300';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) throw new Error('PORT 必須是 1～65535 的整數');

const serverId = process.env.MCP_SERVER_ID ?? 'db-intelligence';
const dataDir = process.env.DBI_DATA_DIR ?? process.env.DBI_CATALOG_DIR ?? 'data';
const state = fileState(path.join(dataDir, 'state.json'), () => loadConfig(process.env.DBI_CONFIG ?? 'config/demo.json'));
const catalogs = new FileCatalogStore(dataDir);
const pools = new PoolRegistry(() => state.dataSources(), { max: Number(process.env.DBI_POOL_MAX ?? 5) });
const recentAudit = new RingAuditSink();

const service = new DbIntelligenceService({
  dataSources: () => state.dataSources(),
  catalogs,
  policies: () => state.policies(),
  principals: directoryResolver(() => state.principals(), { serverId }),
  executor: new PostgresExecutor(pools),
  audit: multiAuditSink(new ConsoleAuditSink(), recentAudit),
  limits: { timeoutMs: Number(process.env.DBI_STATEMENT_TIMEOUT_MS ?? 10_000) },
});

const app = createDbIntelligenceApp({
  verifier: createHyAgentVerifier({
    jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
    audience: serverId,
    rejectReplay: true,
  }),
  service,
  admin: { state, catalogs, pools, audit: recentAudit, serverId },
});
const http = app.listen(port, () => console.log(`db-intelligence MCP server on http://localhost:${port}/mcp（管理 API：/admin）`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    http.close();
    void pools.closeAll().finally(() => process.exit(0));
  });
}
