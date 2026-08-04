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

import {
  hasPgvectorIndex,
  invalidatePgvectorModelCache,
  pgvectorRetriever,
} from '@/modules/knowledge/retriever.pgvector';

/** 第一次 $queryRaw 回索引 metadata（model），第二次回候選列 */
function mockQueries(candidates: Record<string, unknown>[]): void {
  queryRaw.mockReset();
  queryRaw
    .mockResolvedValueOnce([{ model: 'test' }])
    .mockResolvedValueOnce(candidates);
}

/** 從某次 $queryRaw 呼叫的參數中取出內嵌的 Prisma.Sql 片段（lexicalBranch 或 Prisma.empty） */
function lexicalFragmentIn(callArgs: unknown[]): { sql: string; values: unknown[] } | undefined {
  return callArgs.find(
    (a): a is { sql: string; values: unknown[] } =>
      typeof a === 'object' && a !== null && typeof (a as { sql?: unknown }).sql === 'string',
  ) as { sql: string; values: unknown[] } | undefined;
}

describe('pgvectorRetriever', () => {
  // model 快取以租戶為 key、跨測試存活；每個案例結束後失效，避免前一案例快取的
  // model 讓下一案例少發一次 $queryRaw，打亂 mockResolvedValueOnce 的呼叫序
  afterEach(() => invalidatePgvectorModelCache('t1'));

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

    // 只驗證上面兩個斷言不夠守門：mock 直接把 { id: 'D', ... } 準備好回傳，
    // 就算實作把 lexicalBranch／union 整段刪掉（只剩 dense limit 20），這個 mock
    // 一樣會回傳同一列，兩個斷言照樣通過——假訊號。改為直接檢查送進 $queryRaw
    // 的候選查詢真的帶了 union + like any 那一路，且參數化的詞正是這次查詢抽出的
    // 專有名詞；這樣刪掉 lexicalBranch 才會讓這個測試失敗（純 dense 送出的查詢
    // 不會有 union / like any 片段）。
    const candidateCallArgs = queryRaw.mock.calls[1];
    const lexicalFragment = lexicalFragmentIn(candidateCallArgs);
    expect(lexicalFragment?.sql).toEqual(expect.stringContaining('union'));
    expect(lexicalFragment?.sql).toEqual(expect.stringContaining('like any'));
    expect(lexicalFragment?.values.flat()).toContain('%spaceme%');
  });

  it('候選重複時只留一筆（dense 與 lexical 兩路可能撈到同一列）', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
    ]);
    const out = await pgvectorRetriever.search('t1', 'HyCMS');
    expect(out).toHaveLength(1);
  });

  it('hasPgvectorIndex 與 search 依序呼叫時共用同一次 model 查詢（避免每回合多打一次資料庫）', async () => {
    mockQueries([
      { id: 'A', url: 'u/a', title: 'HyCMS', text: '內容', cosine: 0.8 },
    ]);
    // 模擬 agent-service 組合流程：pickRetriever 先用 hasPgvectorIndex 判斷要不要用這個
    // 檢索器，判斷完緊接著呼叫同一個 retriever 的 search()——這兩步理應只查一次
    // knowledge_indexes，否則每個問答回合都會多打一次資料庫。
    expect(await hasPgvectorIndex('t1')).toBe(true);
    const out = await pgvectorRetriever.search('t1', 'HyCMS');
    expect(out.map((c) => c.id)).toEqual(['A']);
    // mockQueries 只準備了 2 筆回傳值（model、candidates）。若沒有快取，search 會
    // 自己再查一次 model，把「candidates」那筆誤當成 model 結果吃掉，接下來拿不到
    // candidates 資料而整個往下錯——所以「剛好 2 次」本身就是快取生效的證明。
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
