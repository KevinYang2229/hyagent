/**
 * 標籤必須在「載入 → 寫回」的來回中存活。
 *
 * ingestFile / removeFile 都走 loadIndex → saveIndex（刪光整租戶再塞回）。
 * loadIndex 若沒把 visibility_scopes 撈回來，寫回時就是 NULL——
 * 每上傳一個新檔就清空所有既有標籤，fail-closed 下等於知識庫無預警失聲。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn();
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
jest.mock('@/config/env', () => ({
  __esModule: true,
  // LOG_LEVEL / NODE_ENV 不可省：logger.ts 在 import 階段就會讀它們，
  // 缺了會在跟 SQL 無關的地方直接炸掉（Task 3 實測踩到）。
  env: {
    DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.', LOG_LEVEL: 'silent', NODE_ENV: 'test',
  },
}));

import { loadIndex } from '@/modules/knowledge/knowledge.index.repo';

describe('標籤在讀寫來回中存活', () => {
  it('loadIndex 撈回 visibility_scopes', async () => {
    queryRaw.mockReset();
    queryRaw
      .mockResolvedValueOnce([{ generated_at: new Date(), model: 'test', source: 'https://x.com' }])
      .mockResolvedValueOnce([
        {
          id: 'c1', url: 'u1', title: 't1', text: 'x1', file_id: 'f1',
          visibility_scopes: ['kb:hr'], embedding: '[1,0,0]',
        },
      ]);

    const idx = await loadIndex('t1');
    expect(idx?.chunks[0]?.visibilityScopes).toEqual(['kb:hr']);
  });

  it('loadIndex 的 select 清單含 visibility_scopes', async () => {
    queryRaw.mockReset();
    queryRaw
      .mockResolvedValueOnce([{ generated_at: new Date(), model: 'test', source: 's' }])
      .mockResolvedValueOnce([]);
    await loadIndex('t1');

    const chunkQuery = queryRaw.mock.calls[1] as unknown[];
    const raw = (chunkQuery[0] as unknown as { raw: readonly string[] }).raw;
    expect(Array.from(raw).join('?')).toContain('visibility_scopes');
  });
});
