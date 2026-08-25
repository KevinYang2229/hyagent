/**
 * 標籤投影：寫入 chunks 時 visibility_scopes 必須一起進去，
 * 且 upsert 的 do update set 必須含該欄——漏了的症狀是
 * 「改了權限但沒生效，重啟也沒用」（upsert 默默保留舊值）。
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
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

// setup-env.ts 把測試固定在 DATA_BACKEND='file'；不覆寫則 saveIndex 走檔案路徑，
// $executeRaw 一次都不會被呼叫，本測試會因錯誤的原因失敗。
// LOG_LEVEL / NODE_ENV 補在 brief 原始 mock 之外：src/lib/logger.ts 在模組載入時就以
// env.LOG_LEVEL 建構 pino()，缺這兩欄會讓 pino 丟「default level:undefined」而非
// 讓測試因為 SQL 缺 visibility_scopes 才失敗——mock 整個模組必須補齊 logger 也讀得到的欄位。
jest.mock('@/config/env', () => ({
  __esModule: true,
  env: {
    DATA_BACKEND: 'db',
    EMBEDDING_MODEL: 'test',
    KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

import { saveIndex } from '@/modules/knowledge/knowledge.index.repo';

/** 把某次 $executeRaw 的 template strings 併回可搜尋的字串 */
function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] } | readonly string[];
  const raw = (parts as { raw?: readonly string[] }).raw ?? (parts as readonly string[]);
  return Array.from(raw).join('?');
}

describe('chunks 寫入含可見性投影', () => {
  beforeEach(() => executeRaw.mockClear());

  it('insert 欄位清單與 on conflict 都含 visibility_scopes', async () => {
    await saveIndex('t1', {
      generatedAt: new Date().toISOString(),
      model: 'test',
      source: 'https://example.com',
      chunks: [
        { id: 'c1', url: 'u1', title: 't', text: 'x', vector: [1, 0, 0], visibilityScopes: ['kb:hr'] },
      ],
    });

    const inserts = executeRaw.mock.calls
      .map(sqlTextOf)
      .filter((s) => s.includes('insert into knowledge_chunks'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain('visibility_scopes');
      expect(sql).toMatch(/do update set[\s\S]*visibility_scopes\s*=\s*excluded\.visibility_scopes/);
    }
  });
});
