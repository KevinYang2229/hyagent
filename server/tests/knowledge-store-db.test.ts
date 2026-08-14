/**
 * knowledge.store 的 db 後端：以假 Prisma client 驗證 upsert 內容與開機還原，
 * 不打真資料庫（tests/setup-env.ts 固定 DATA_BACKEND=file，此處以 isolateModules 覆寫）。
 */
const upsert = jest.fn().mockResolvedValue(undefined);
const findMany = jest.fn().mockResolvedValue([]);
const findUnique = jest.fn().mockResolvedValue(null);

jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ knowledgeSourceRow: { upsert, findMany, findUnique } }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void {
      void task({ knowledgeSourceRow: { upsert, findMany, findUnique } });
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
  findUnique.mockReset().mockResolvedValue(null);
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

  describe('addFileMeta / removeFileMeta（跨 process lost update 修正）', () => {
    it('addFileMeta 在 task 內部重讀 DB 最新的 files 再合併，不是沿用記憶體快照', async () => {
      // 模擬另一個 process（watcher CLI）已經把 DB 的 files 寫成 [A]，
      // 而本 process 的記憶體快照仍是開機時的空狀態——若直接對記憶體快照做 delta 再整包寫回，
      // 會把 DB 裡的 A 蓋掉；正確行為是 task 內部 findUnique 讀到 DB 現有的 A，合併出 [A, B]。
      findUnique.mockResolvedValueOnce({
        tenantId: 't5',
        meta: { status: 'ready', chunkCount: 1, files: [{ fileId: 'A', name: 'a.txt', chunks: 1, ingestedAt: '' }] },
      });
      const { knowledgeStore } = loadStoreInDbMode();

      knowledgeStore.addFileMeta(
        't5',
        { fileId: 'B', name: 'b.txt', chunks: 2, ingestedAt: '' },
        { status: 'ready', chunkCount: 3 },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(findUnique).toHaveBeenCalledWith({ where: { tenantId: 't5' } });
      const arg = upsert.mock.calls[0][0];
      const fileIds = (arg.update.meta.files as { fileId: string }[]).map((f) => f.fileId);
      expect(fileIds.sort()).toEqual(['A', 'B']);
    });

    it('removeFileMeta 在 task 內部重讀 DB 最新的 files 再移除，不是沿用記憶體快照', async () => {
      // 對稱案例：DB 現有 [A, B]（B 是另一個 process 剛加的），本 process 要移除 A；
      // 正確結果是 DB 剩 [B]，而不是記憶體快照裡原本就沒有的東西被誤刪或整包蓋掉。
      findUnique.mockResolvedValueOnce({
        tenantId: 't6',
        meta: {
          status: 'ready',
          chunkCount: 2,
          files: [
            { fileId: 'A', name: 'a.txt', chunks: 1, ingestedAt: '' },
            { fileId: 'B', name: 'b.txt', chunks: 1, ingestedAt: '' },
          ],
        },
      });
      const { knowledgeStore } = loadStoreInDbMode();

      knowledgeStore.removeFileMeta('t6', 'A', { chunkCount: 1 });
      await Promise.resolve();
      await Promise.resolve();

      const arg = upsert.mock.calls[0][0];
      const fileIds = (arg.update.meta.files as { fileId: string }[]).map((f) => f.fileId);
      expect(fileIds).toEqual(['B']);
    });

    it('DB 尚無 row 時（findUnique 回 null）以空狀態為基底建立', async () => {
      findUnique.mockResolvedValueOnce(null);
      const { knowledgeStore } = loadStoreInDbMode();

      knowledgeStore.addFileMeta(
        't7',
        { fileId: 'C', name: 'c.txt', chunks: 1, ingestedAt: '' },
        { status: 'ready', chunkCount: 1 },
      );
      await Promise.resolve();
      await Promise.resolve();

      const arg = upsert.mock.calls[0][0];
      expect(arg.create.tenantId).toBe('t7');
      expect((arg.update.meta.files as { fileId: string }[]).map((f) => f.fileId)).toEqual(['C']);
    });
  });
});
