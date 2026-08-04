/**
 * 索引 repository 的 db 後端：向量字面值格式、整份取代語意、分批寫入、整份刪除。
 * 以假 Prisma client 攔截 $executeRaw / $queryRaw，不打真資料庫。
 */
const executeRaw = jest.fn().mockResolvedValue(0);
const queryRaw = jest.fn().mockResolvedValue([]);
const transaction = jest.fn(async (ops: unknown[]) => ops);

jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: transaction,
  }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

function loadRepoInDbMode(): typeof import('@/modules/knowledge/knowledge.index.repo') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.index.repo');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.index.repo');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  executeRaw.mockClear();
  queryRaw.mockClear();
});

const idx: KnowledgeIndexFile = {
  generatedAt: '2026-08-04T00:00:00.000Z',
  model: 'text-embedding-3-large',
  source: 'https://example.com',
  chunks: [
    { id: 'a', url: 'https://example.com/a', title: 'A', text: '內容 A', vector: [1, 0, 0] },
    { id: 'b', url: 'https://example.com/b', title: 'B', text: '內容 B', vector: [0, 1, 0], fileId: 'F1' },
  ],
};

describe('toVectorLiteral', () => {
  it('輸出 pgvector 接受的方括號字面值', () => {
    const { toVectorLiteral } = loadRepoInDbMode();
    expect(toVectorLiteral([1, -0.5, 0])).toBe('[1,-0.5,0]');
  });
  it('空向量輸出 []', () => {
    const { toVectorLiteral } = loadRepoInDbMode();
    expect(toVectorLiteral([])).toBe('[]');
  });
});

describe('saveIndex（db 後端）', () => {
  it('先刪該租戶既有 chunks 再寫入（整份取代）', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    // 第一個 statement 必須是 delete，否則會與舊 chunks 混在一起
    const first = String(executeRaw.mock.calls[0]?.[0] ?? '');
    expect(first.toLowerCase()).toContain('delete');
    expect(executeRaw.mock.calls.length).toBeGreaterThanOrEqual(3); // delete + chunks + indexes upsert
  });

  it('索引層級 metadata 一併寫入 knowledge_indexes', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    const stmts = executeRaw.mock.calls.map((c) => String(c[0] ?? '').toLowerCase());
    expect(stmts.some((s) => s.includes('knowledge_indexes'))).toBe(true);
  });
});

describe('loadIndex（db 後端）', () => {
  it('查無 metadata 列時回 null（未建索引）', async () => {
    queryRaw.mockResolvedValueOnce([]);
    const { loadIndex } = loadRepoInDbMode();
    expect(await loadIndex('nobody')).toBeNull();
  });

  it('組回 KnowledgeIndexFile，向量字串還原為數字陣列', async () => {
    queryRaw
      .mockResolvedValueOnce([
        { generated_at: new Date('2026-08-04T00:00:00.000Z'), model: 'text-embedding-3-large', source: 'https://example.com' },
      ])
      .mockResolvedValueOnce([
        { id: 'a', url: 'https://example.com/a', title: 'A', text: '內容 A', file_id: null, embedding: '[1,0,0]' },
      ]);
    const { loadIndex } = loadRepoInDbMode();
    const got = await loadIndex('t1');
    expect(got?.model).toBe('text-embedding-3-large');
    expect(got?.chunks[0].vector).toEqual([1, 0, 0]);
    expect(got?.chunks[0].fileId).toBeUndefined();
  });
});

describe('deleteIndex（db 後端，追加需求）', () => {
  it('刪除 knowledge_chunks 與 knowledge_indexes 兩張表中該租戶的資料', async () => {
    const { deleteIndex } = loadRepoInDbMode();
    await deleteIndex('t1');
    const stmts = executeRaw.mock.calls.map((c) => String(c[0] ?? '').toLowerCase());
    expect(stmts.some((s) => s.includes('delete') && s.includes('knowledge_chunks'))).toBe(true);
    expect(stmts.some((s) => s.includes('delete') && s.includes('knowledge_indexes'))).toBe(true);
  });
});
