/**
 * pgvector 檢索器：SQL 只負責取候選（dense top-k + lexical 命中），
 * 融合評分與保留條件在 JS，與 file 靜態索引共用 retriever.scoring —— 行為必須等價。
 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: 10 }),
  }),
}));

const queryRaw = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $queryRaw: queryRaw }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import { pgvectorRetriever } from '@/modules/knowledge/retriever.pgvector';

/** 第一次 $queryRaw 回索引 metadata（model），第二次回候選列 */
function mockQueries(candidates: Record<string, unknown>[]): void {
  queryRaw.mockReset();
  queryRaw
    .mockResolvedValueOnce([{ model: 'test' }])
    .mockResolvedValueOnce(candidates);
}

describe('pgvectorRetriever', () => {
  it('未建索引時回空陣列', async () => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([]);
    expect(await pgvectorRetriever.search('t1', '任何問題')).toEqual([]);
  });

  it('空查詢不打資料庫', async () => {
    queryRaw.mockReset();
    expect(await pgvectorRetriever.search('t1', '   ')).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('依融合分數排序並淘汰低分無命中者', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS 網站管理平台', text: 'HyCMS 內容管理', cosine: 0.9 },
      { id: 'B', url: 'u/b', title: '無關頁', text: '無關內容', cosine: 0.1 },
      { id: 'C', url: 'u/c', title: 'HyLib 圖書自動化', text: '圖書系統', cosine: 0.5 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'HyCMS 是什麼');
    // B：cosine 0.1 < MIN_SCORE 且無命中 → 淘汰
    expect(out.map((c) => c.id)).toEqual(['A', 'C']);
    // A 命中 hycms 一次：0.9 + 0.15
    expect(out[0].score).toBeCloseTo(1.05);
  });

  it('語意遠但專有名詞命中仍保留（不可被 ANN 截掉的行為）', async () => {
    mockQueries([
      { id: 'D', url: 'u/d', title: 'SpaceMe 空間管理', text: '與問題語意不近', cosine: 0.05 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'SpaceMe 怎麼收費');
    expect(out.map((c) => c.id)).toEqual(['D']);
    expect(out[0].score).toBeCloseTo(0.2); // 0.05 + 0.15
  });

  it('候選重複時只留一筆（dense 與 lexical 兩路可能撈到同一列）', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'HyCMS');
    expect(out).toHaveLength(1);
  });
});
