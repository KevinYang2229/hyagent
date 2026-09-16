/**
 * db 模式煙霧驗證（CI 用；本機也可對測試 DB 跑）。
 *
 * 用法：
 *   DATA_BACKEND=db DATABASE_URL=... npx tsx scripts/db-smoke.ts write   # 寫入 8 個 store
 *   DATA_BACKEND=db DATABASE_URL=... npx tsx scripts/db-smoke.ts verify  # 全新進程還原並斷言
 *
 * 兩階段分屬不同進程：verify 讀到的必然來自 DB（而非殘留的記憶體 Map），
 * 等同驗證「重啟還原」。涵蓋：tenants(+加密欄位)、api keys(雜湊)、sessions、
 * submissions、usage(月分桶)、audit、forms、scope-policy(+bundle)、webhooks、attachments。
 */
import { closeDb, connectDb } from '../src/lib/db';
import { auditStore, initAuditStore } from '../src/modules/audit/audit.store';
import { initScopePolicy, scopePolicy } from '../src/modules/authz/scope-policy';
import { resolveScopes } from '../src/modules/authz/resolve-scopes';
import { attachmentStore } from '../src/modules/conversation/attachment.store';
import { conversationStore, initConversationStore } from '../src/modules/conversation/conversation.store';
import { formStore, initFormStore } from '../src/modules/form/form.store';
import { getDefinition } from '../src/modules/form/form.registry';
import {
  acquireIngestLock,
  releaseIngestLock,
  renewIngestLock,
} from '../src/modules/knowledge/knowledge.ingest-lock';
import { initTenantStore, tenantStore } from '../src/modules/tenant/tenant.store';
import { initUsageStore, usageStore } from '../src/modules/usage/usage.store';
import { initWebhookStore, webhookStore } from '../src/modules/webhook/webhook.store';
import { initSubmissionStore, submissionStore } from '../src/modules/workflow/submission.store';

const TENANT_NAME = 'db-smoke-tenant';
let failures = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures += 1;
}

async function initAll(): Promise<void> {
  await initTenantStore();
  await Promise.all([
    initConversationStore(),
    initSubmissionStore(),
    initUsageStore(),
    initAuditStore(),
    initFormStore(),
    initScopePolicy(),
    initWebhookStore(),
  ]);
}

async function write(): Promise<void> {
  await initAll();

  const tenant = tenantStore.createTenant(TENANT_NAME, ['https://smoke.example.com'], 'sso-smoke-secret-16ch');
  const key = tenantStore.createApiKey(tenant.id, 'secret');
  tenantStore.updateTenant(tenant.id, {
    llmConfig: { provider: 'anthropic', anthropicApiKey: 'sk-ant-smoke-byo-key' },
    quotaMonthlyLlmTokens: 12345,
    // 目錄以租戶隔離（內建 mock 名錄只給 default 租戶），部門要由本租戶自己的目錄提供，
    // 否則 kevin 落在 UNKNOWN_DEPARTMENT，下方以部門為 key 的套餐就展不開。
    userDirectory: [{ id: 'kevin', name: 'Kevin Yang', department: '行銷部' }],
  });

  const session = conversationStore.create(tenant.id, 'smoke-user', 'leave-request');
  session.values.reason = 'db-smoke';
  conversationStore.save(session);

  attachmentStore.save(session.id, { name: 'r.pdf', mime: 'application/pdf', buffer: Buffer.from('smoke-bytes') });

  submissionStore.record(tenant.id, {
    oaRequestId: 'SMOKE-1', formId: 'leave-request', formTitle: '請假單',
    userId: 'smoke-user', submittedAt: new Date().toISOString(),
  });

  usageStore.recordLLMUsage(tenant.id, {
    usage: { inputTokens: 70, outputTokens: 30 }, model: 'claude-sonnet-4-5', keySource: 'platform',
  });

  auditStore.record(tenant.id, {
    toolId: 'oa.submitForm', userId: 'smoke-user', at: new Date().toISOString(), ok: true, summary: 'db-smoke',
  });

  const def = getDefinition('default', 'leave-request');
  formStore.saveDefinition(tenant.id, { ...def, formId: 'smoke-form' });

  scopePolicy.setPolicy(tenant.id, {
    groups: {}, accounts: {},
    bundles: [{ id: 'smoke-pack', name: '煙霧套餐', scopes: ['service:form'] }],
    groupBundles: { 行銷部: ['smoke-pack'] }, accountBundles: {},
  });

  webhookStore.register({ tenantId: tenant.id, url: 'https://smoke.example.com/hook' });

  // 交棒給 verify 階段：raw key 只在簽發當下存在，經檔案傳遞
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/db-smoke-handoff.json', JSON.stringify({ tenantId: tenant.id, rawKey: key.key, sessionId: session.id }));

  await closeDb(); // 沖完所有排隊寫入
  console.log('write phase done');
}

async function verify(): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const handoff = JSON.parse(readFileSync('/tmp/db-smoke-handoff.json', 'utf-8')) as {
    tenantId: string; rawKey: string; sessionId: string;
  };

  await initAll();
  const { tenantId, rawKey, sessionId } = handoff;

  const tenant = tenantStore.getTenant(tenantId);
  check('tenant 還原', tenant?.name === TENANT_NAME);
  check('ssoSecret 解密還原', tenant?.ssoSecret === 'sso-smoke-secret-16ch');
  check('BYO key 解密還原', tenant?.llmConfig?.anthropicApiKey === 'sk-ant-smoke-byo-key');
  check('配額還原', tenant?.quotaMonthlyLlmTokens === 12345);
  const apiKey = tenantStore.getApiKey(rawKey);
  check('api key 雜湊驗證', apiKey?.tenantId === tenantId && apiKey.key !== rawKey);

  const session = conversationStore.get(sessionId, tenantId, 'smoke-user');
  check('session 還原（含 values）', session.values.reason === 'db-smoke');

  const db = await connectDb();
  const att = await db.attachmentRow.findFirst({ where: { sessionId } });
  check('attachment bytes 還原', att?.content.toString() === 'smoke-bytes');

  check('submission 還原', submissionStore.find(tenantId, 'SMOKE-1')?.formTitle === '請假單');
  check('usage 月分桶還原', usageStore.currentMonthLlmTokens(tenantId) === 100);
  check('audit 還原', auditStore.list(tenantId, 10).some((e) => e.summary === 'db-smoke'));
  check('form 定義還原', formStore.getOverride(tenantId, 'smoke-form') !== undefined);
  check('bundle 展開生效', resolveScopes({ tenantId, userId: 'kevin' }).includes('service:form'));
  check('webhook 還原', webhookStore.listByTenant(tenantId).length === 1);

  // 清理即驗證：級聯清理（controller 用的 purgeTenant）在此以 store 方法逐一呼叫，
  // 沖寫後查 DB 確認各表 0 殘留——同時驗證「刪租戶不留孤兒」。
  tenantStore.deleteTenant(tenantId);
  conversationStore.purgeTenant(tenantId);
  submissionStore.purgeTenant(tenantId);
  usageStore.purgeTenant(tenantId);
  auditStore.purgeTenant(tenantId);
  formStore.purgeTenant(tenantId);
  scopePolicy.purgeTenant(tenantId);
  webhookStore.purgeTenant(tenantId);
  await closeDb(); // 沖完所有 purge 寫入

  const after = await connectDb();
  const orphans =
    (await after.submissionRow.count({ where: { tenantId } })) +
    (await after.tenantFormRow.count({ where: { tenantId } })) +
    (await after.tenantUsageRow.count({ where: { tenantId } })) +
    (await after.auditLogRow.count({ where: { tenantId } })) +
    (await after.scopePolicyRow.count({ where: { tenantId } })) +
    (await after.webhookRow.count({ where: { tenantId } })) +
    (await after.sessionRow.count({ where: { tenantId } }));
  check('刪租戶級聯清理無孤兒', orphans === 0);

  await checkIngestLock();
  await closeDb();

  if (failures > 0) {
    console.error(`db-smoke failed: ${failures} checks`);
    process.exit(1);
  }
  console.log('db-smoke all green');
}

/**
 * 批次匯入互斥鎖：對真實 Postgres 實跑一遍。
 *
 * 單元測試把 Prisma mock 掉，驗得到 SQL 的「形狀」卻驗不到它是否合法——
 * `make_interval(mins => $1)` 就是這樣溜過去的（Prisma 綁 bigint、函式收 int，
 * 42883 只有在真的送到 Postgres 才會出現）。凡是手寫 SQL 的路徑都要有一段實跑。
 */
async function checkIngestLock(): Promise<void> {
  const t = 'db-smoke-lock-tenant';
  const db = await connectDb();
  await db.$executeRaw`delete from knowledge_ingest_locks where tenant_id = ${t}`;

  const first = await acquireIngestLock(t);
  check('匯入鎖：首次取得成功', first !== null);
  if (!first) return;

  check('匯入鎖：同租戶再取被擋下（這就是兩支 watcher 重複匯入的防線）',
    (await acquireIngestLock(t)) === null);

  await renewIngestLock(first);
  const [row] = await db.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from knowledge_ingest_locks
    where tenant_id = ${t} and holder = ${first.holder}`;
  check('匯入鎖：續期後仍由自己持有', row.n === 1);

  await releaseIngestLock(first);
  const [gone] = await db.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from knowledge_ingest_locks where tenant_id = ${t}`;
  check('匯入鎖：釋放後該列消失', gone.n === 0);

  const again = await acquireIngestLock(t);
  check('匯入鎖：釋放後可再次取得', again !== null);
  if (again) await releaseIngestLock(again);
}

const phase = process.argv[2];
const run = phase === 'write' ? write : phase === 'verify' ? verify : null;
if (!run) {
  console.error('usage: tsx scripts/db-smoke.ts <write|verify>');
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
