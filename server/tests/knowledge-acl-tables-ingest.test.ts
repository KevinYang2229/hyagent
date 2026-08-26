/**
 * 表格入庫時必須蓋上可見性標籤。
 *
 * 查詢端（searchTableCatalog / loadTable）已依 visibility_scopes 過濾，
 * 但入庫端若不寫該欄，任何帶表格的檔案其表格對所有人恆不可見——
 * 症狀是「問文件內容答得出來、問裡面的數字就說沒有」。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $executeRaw: executeRaw, $queryRaw: jest.fn().mockResolvedValue([]) }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void Promise.resolve(task({})).catch(() => {}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
jest.mock('@/config/env', () => ({
  __esModule: true,
  env: {
    DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.', LOG_LEVEL: 'silent', NODE_ENV: 'test',
  },
}));

import { saveTables } from '@/modules/knowledge/knowledge.tables.repo';
import type { ParsedTable } from '@/modules/knowledge/doc-parse';

function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] };
  return Array.from(parts.raw ?? []).join('?');
}

/**
 * 取最後一次 $executeRaw 呼叫實際綁定的參數值（而非 SQL 文字）。
 *
 * 頂層呼叫是 `db.$executeRaw\`...values ${Prisma.join(values)}\``，call[1] 即
 * Prisma.join(...) 的結果——一個攤平了所有巢狀 Prisma.sql 參數的 Sql 物件，
 * .values 依序對應每個 ${} 插值。NULL vs [] 只能從這裡驗證：SQL 文字兩種情況
 * 完全相同（都是一個佔位符），差異只存在於實際綁定的值。
 */
function lastBoundValues(): unknown[] {
  const call = executeRaw.mock.calls[executeRaw.mock.calls.length - 1] as unknown[];
  return (call[1] as { values: unknown[] }).values;
}

describe('表格入庫的可見性投影', () => {
  beforeEach(() => executeRaw.mockClear());

  const tables: ParsedTable[] = [
    { sheet: 'S1', caption: '', headers: ['a'], rows: [['1']] },
  ];

  it('insert 欄位清單含 visibility_scopes，且實際綁定值是傳入的陣列', async () => {
    await saveTables('t1', 'f1', 'x.xlsx', tables, undefined, ['kb:hr']);

    const sql = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sql).toContain('knowledge_tables');
    expect(sql).toContain('visibility_scopes');
    // 最後一個插值是 visibility_scopes 這一欄（見 saveTables 的欄位順序）
    expect(lastBoundValues().at(-1)).toEqual(['kb:hr']);
  });

  it('未傳 visibilityScopes 時，實際綁定值是 NULL 而非空陣列（語意不同：待標記 vs 明確標成誰都不能看）', async () => {
    await saveTables('t1', 'f1', 'x.xlsx', tables);

    const sql = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sql).toContain('visibility_scopes');
    expect(lastBoundValues().at(-1)).toBeNull();
    expect(lastBoundValues().at(-1)).not.toEqual([]);
  });
});
