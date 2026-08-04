/**
 * knowledge.store 的 db 後端：以假 Prisma client 驗證 upsert 內容與開機還原，
 * 不打真資料庫（tests/setup-env.ts 固定 DATA_BACKEND=file，此處以 isolateModules 覆寫）。
 */
const upsert = jest.fn().mockResolvedValue(undefined);
const findMany = jest.fn().mockResolvedValue([]);

jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ knowledgeSourceRow: { upsert, findMany } }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void {
      void task({ knowledgeSourceRow: { upsert, findMany } });
    }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/** 在 DATA_BACKEND=db 下重新載入 store（env 於模組載入時定型，必須 isolateModules） */
function loadStoreInDbMode(): typeof import('@/modules/knowledge/knowledge.store') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.store');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.store');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  upsert.mockClear();
  findMany.mockClear();
});

describe('knowledgeStore（db 後端）', () => {
  it('saveSource 寫入 knowledge_sources，帶 tenant_id 與 source', async () => {
    const { knowledgeStore } = loadStoreInDbMode();
    knowledgeStore.saveSource('t1', {
      startUrl: 'https://x.com', maxPages: 50, chunkChars: 600,
      embeddingModel: 'text-embedding-3-large', rerank: false,
    });
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 't1' });
    expect(arg.create.source).toMatchObject({ startUrl: 'https://x.com', rerank: false });
  });

  it('setMeta 寫入 meta 欄位而不覆蓋 source', async () => {
    const { knowledgeStore } = loadStoreInDbMode();
    knowledgeStore.setMeta('t2', { status: 'ready', chunkCount: 7 });
    await Promise.resolve();
    const arg = upsert.mock.calls[0][0];
    expect(arg.update.meta).toMatchObject({ status: 'ready', chunkCount: 7 });
    expect(arg.update.source).toBeUndefined();
  });

  it('initKnowledgeStore 從資料庫還原 source 與 meta', async () => {
    findMany.mockResolvedValueOnce([
      {
        tenantId: 't3',
        source: { startUrl: 'https://restored.com', maxPages: 10, chunkChars: 800,
                  embeddingModel: 'text-embedding-3-large', rerank: true },
        meta: { status: 'ready', chunkCount: 42 },
      },
    ]);
    const { knowledgeStore, initKnowledgeStore } = loadStoreInDbMode();
    await initKnowledgeStore();
    expect(knowledgeStore.getSource('t3').startUrl).toBe('https://restored.com');
    expect(knowledgeStore.getMeta('t3').chunkCount).toBe(42);
  });

  it('空的 source/meta（jsonb 預設 {}）不會污染預設值', async () => {
    findMany.mockResolvedValueOnce([{ tenantId: 't4', source: {}, meta: {} }]);
    const { knowledgeStore, initKnowledgeStore } = loadStoreInDbMode();
    await initKnowledgeStore();
    expect(knowledgeStore.getSource('t4').maxPages).toBeGreaterThan(0);
    expect(knowledgeStore.getMeta('t4').status).toBe('none');
  });
});
