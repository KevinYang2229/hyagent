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

describe('表格入庫的可見性投影', () => {
  beforeEach(() => executeRaw.mockClear());

  const tables: ParsedTable[] = [
    { sheet: 'S1', caption: '', headers: ['a'], rows: [['1']] },
  ];

  it('insert 欄位清單含 visibility_scopes', async () => {
    await saveTables('t1', 'f1', 'x.xlsx', tables, undefined, ['kb:hr']);

    const sql = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sql).toContain('knowledge_tables');
    expect(sql).toContain('visibility_scopes');
  });

  it('未傳 visibilityScopes 時 insert 欄位清單仍含該欄（值為 NULL，非空陣列）', async () => {
    await saveTables('t1', 'f1', 'x.xlsx', tables);

    const sql = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sql).toContain('visibility_scopes');
  });
});
