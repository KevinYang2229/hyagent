/**
 * 存取紀錄的 db 後端：SQL 形狀、表格路徑、清除語句。
 * 規則本身（公開不記、合併、快照…）見 knowledge-access-log.test.ts。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn().mockResolvedValue([]);
const mockDb = { $executeRaw: executeRaw, $queryRaw: queryRaw };
let pending: Promise<unknown>[] = [];
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => mockDb,
  DbWriteQueue: class {
    // 其他 store（tenant、knowledge meta）的寫入在空殼 db 上必定失敗；比照正式行為吞掉
    enqueue(task: (db: unknown) => Promise<void>): void {
      pending.push(task(mockDb).catch(() => {}));
    }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
jest.mock('@/config/env', () => ({
  __esModule: true,
  env: {
    DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.', LOG_LEVEL: 'silent', NODE_ENV: 'test',
    KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS: 180,
  },
}));

import { scopePolicy } from '@/modules/authz/scope-policy';
import { cleanupExpiredAccessLogs, recordKnowledgeAccess, resetAccessLogsForTest } from '@/modules/knowledge/access-log';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { loadTable } from '@/modules/knowledge/knowledge.tables.repo';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';

function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[]; strings?: readonly string[] };
  return Array.from(parts.raw ?? parts.strings ?? []).join('?');
}
const accessLogCalls = () => executeRaw.mock.calls.filter((c) => sqlTextOf(c).includes('knowledge_access_logs'));
async function drain(): Promise<void> {
  const p = pending;
  pending = [];
  await Promise.all(p);
}

function makeTenant(name: string): string {
  const tid = tenantStore.createTenant(name).id;
  tenantStore.updateTenant(tid, { knowledgeLabels: [{ id: 'hr', label: '人資' }, { id: 'public', label: '公開' }] });
  const policy = scopePolicy.getPolicy(tid);
  policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
  scopePolicy.setPolicy(tid, policy);
  knowledgeStore.addFileMeta(tid, { fileId: 'hr', name: 'hr.xlsx', chunks: 1, ingestedAt: new Date().toISOString(), visibilityScopes: ['kb:hr'] }, {});
  return tid;
}

beforeEach(async () => {
  await drain();
  resetAccessLogsForTest();
  executeRaw.mockClear();
  queryRaw.mockReset().mockResolvedValue([]);
});
afterEach(() => scopePolicy.clear());

it('insert 只寫固定欄位，沒有任何內容欄位', async () => {
  const tid = makeTenant('alogdb-insert');
  await drain();
  executeRaw.mockClear();
  recordKnowledgeAccess({ tenantId: tid, userId: 'HYW001' }, 'chat', [{ fileId: 'hr' }], { refId: 's-1' });
  await drain();

  const calls = accessLogCalls();
  expect(calls).toHaveLength(1);
  const sql = sqlTextOf(calls[0]);
  expect(sql).toMatch(/\(tenant_id, user_id, actor_id, path, file_id, file_name, scopes, ref_id, at\)/);
  expect(sql).not.toMatch(/question|answer|content|text|excerpt/);
});

it('表格 table 路徑：loadTable 載入非公開檔的表時記錄', async () => {
  const tid = makeTenant('alogdb-table');
  queryRaw.mockResolvedValueOnce([
    { id: 'tb1', source: 'hr.xlsx', sheet: 'S1', caption: null, headers: ['姓名'], rows: [['王小明']], row_count: 1, file_id: 'hr' },
  ]);
  await drain();
  executeRaw.mockClear();
  const table = await loadTable({ tenantId: tid, userId: 'HYW001' }, 'tb1', 'table', { refId: 's-2' });
  await drain();

  expect(table?.rows).toEqual([['王小明']]); // 回傳內容不受影響
  expect(accessLogCalls()).toHaveLength(1);
});

it('寫入失敗不影響 loadTable 的回傳', async () => {
  const tid = makeTenant('alogdb-fail');
  queryRaw.mockResolvedValueOnce([
    { id: 'tb1', source: 'hr.xlsx', sheet: 'S1', caption: null, headers: ['a'], rows: [['1']], row_count: 1, file_id: 'hr' },
  ]);
  executeRaw.mockRejectedValueOnce(new Error('relation "knowledge_access_logs" does not exist'));
  await expect(loadTable({ tenantId: tid, userId: 'u' }, 'tb1', 'table')).resolves.toMatchObject({ id: 'tb1' });
  await drain();
});

it('清除：有覆寫的租戶各自刪，其餘以平台預設一句刪', async () => {
  const a = makeTenant('alogdb-clean-a');
  tenantStore.updateTenant(a, { knowledgeAccessLogRetentionDays: 365 });
  await drain();
  executeRaw.mockClear();
  cleanupExpiredAccessLogs();
  await drain();

  const sqls = accessLogCalls().map(sqlTextOf);
  expect(sqls.some((s) => s.includes('where tenant_id = ?') && s.includes('at < ?'))).toBe(true);
  expect(sqls.some((s) => s.includes('tenant_id <> all('))).toBe(true);
});
