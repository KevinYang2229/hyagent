/**
 * knowledge_tables 是平行檢索路徑，漏掉即為側門。
 * setFileVisibility 必須在同一交易更新兩張表，且封裝成單一函式，
 * 不讓呼叫端有機會只呼叫其中一個。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  }),
  DbWriteQueue: class {
    // tenantStore.createTenant/updateTenant 在 DATA_BACKEND='db' 下會透過這條隊列
    // write-through 一份租戶快照；真正的 DbWriteQueue 對失敗會 .catch 吞掉（見
    // src/lib/db.ts）。這裡的 task({}) 是空殼 db，寫入必定失敗——比照正式行為吞掉，
    // 否則會變成未捕捉的 rejection 讓整個 worker 程序崩潰，而不是單純測試失敗。
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}).catch(() => {}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
jest.mock('@/config/env', () => ({
  __esModule: true,
  // LOG_LEVEL / NODE_ENV 不可省：logger.ts 在 import 階段就會讀它們，
  // 缺了會在跟 SQL 無關的地方直接炸掉（Task 3 實測踩到）。
  env: {
    DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.', LOG_LEVEL: 'silent', NODE_ENV: 'test',
  },
}));

import { setFileVisibility } from '@/modules/knowledge/knowledge.visibility';

function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] };
  return Array.from(parts.raw ?? []).join('?');
}

import { listTableCatalog, loadTable, searchTableCatalog } from '@/modules/knowledge/knowledge.tables.repo';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('標籤更新的原子性', () => {
  it('setFileVisibility 同時更新 chunks 與 tables', async () => {
    executeRaw.mockClear();
    await setFileVisibility('t1', 'f1', ['kb:hr']);
    const sqls = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sqls).toContain('update knowledge_chunks');
    expect(sqls).toContain('update knowledge_tables');
  });
});

/** 抓最後一次 $queryRaw 呼叫的完整 SQL 文字（template 字面 + 內嵌 Prisma.sql 片段） */
function lastQueryRawSql(): string {
  const call = queryRaw.mock.calls[queryRaw.mock.calls.length - 1] as unknown[];
  const own = Array.from((call[0] as unknown as { raw: readonly string[] }).raw).join('?');
  const nested = call
    .slice(1)
    .filter((a): a is { sql: string } =>
      typeof a === 'object' && a !== null && typeof (a as { sql?: unknown }).sql === 'string')
    .map((a) => a.sql)
    .join(' ');
  return `${own} ${nested}`;
}

describe('表格檢索沒有側門', () => {
  it('acl=on 時 searchTableCatalog 帶可見性條件', async () => {
    const t = tenantStore.createTenant('acl-tables-test');
    tenantStore.updateTenant(t.id, {
      knowledgeAcl: 'on',
      knowledgeLabels: [{ id: 'hr', label: '人資' }],
    });
    queryRaw.mockClear();
    await searchTableCatalog({ tenantId: t.id, userId: 'nobody' }, [1, 0, 0], 5);

    expect(lastQueryRawSql()).toContain('visibility_scopes');
  });

  /**
   * loadTable 是「以 id 直接取表」那道側門——目錄查詢（searchTableCatalog/listTableCatalog）
   * 擋得住的可見性限制，若這裡不擋，繞過目錄直接指定 id 就能讀到不該看的表。
   * 過去只有 searchTableCatalog 有這個斷言，loadTable 這道側門本身沒有測試守著。
   */
  it('acl=on 時 loadTable 帶可見性條件（繞過目錄直接指定 id 那道側門）', async () => {
    const t = tenantStore.createTenant('acl-tables-loadtable-test');
    tenantStore.updateTenant(t.id, {
      knowledgeAcl: 'on',
      knowledgeLabels: [{ id: 'hr', label: '人資' }],
    });
    queryRaw.mockClear();
    await loadTable({ tenantId: t.id, userId: 'nobody' }, 'table-1');

    expect(lastQueryRawSql()).toContain('visibility_scopes &&');
  });

  it('acl=off 時 loadTable 不帶可見性條件（遷移期行為零改變）', async () => {
    const t = tenantStore.createTenant('acl-tables-loadtable-off-test');
    tenantStore.updateTenant(t.id, { knowledgeAcl: 'off' });
    queryRaw.mockClear();
    await loadTable({ tenantId: t.id, userId: 'nobody' }, 'table-1');

    expect(lastQueryRawSql()).not.toContain('visibility_scopes &&');
  });

  /**
   * listTableCatalog 也會整段送進 LLM prompt（report.compose 的 catalogBlock、
   * report.outline 的 knowledgeOverview），不過濾就是檔名／欄位名外洩——
   * 修復前這支函式不吃 principal、也完全不過濾。
   */
  it('acl=on 時 listTableCatalog 帶可見性條件', async () => {
    const t = tenantStore.createTenant('acl-tables-listcatalog-test');
    tenantStore.updateTenant(t.id, {
      knowledgeAcl: 'on',
      knowledgeLabels: [{ id: 'hr', label: '人資' }],
    });
    queryRaw.mockClear();
    await listTableCatalog({ tenantId: t.id, userId: 'nobody' });

    expect(lastQueryRawSql()).toContain('visibility_scopes &&');
  });

  it('acl=off 時 listTableCatalog 不帶可見性條件（遷移期行為零改變）', async () => {
    const t = tenantStore.createTenant('acl-tables-listcatalog-off-test');
    tenantStore.updateTenant(t.id, { knowledgeAcl: 'off' });
    queryRaw.mockClear();
    await listTableCatalog({ tenantId: t.id, userId: 'nobody' });

    expect(lastQueryRawSql()).not.toContain('visibility_scopes &&');
  });
});
