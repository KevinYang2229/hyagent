/**
 * 檢索器選擇的共用出口（retriever.pick）與其呼叫端。
 *
 * 這條縫是全分支審查抓到的 Important：admin「測試查詢」端點原本寫死 staticIndexRetriever，
 * 在 db 模式下會走到 existsSync(索引檔) → false → 快取 null → 回 []，
 * 對每個問題都回報「0 命中」卻不噴任何錯誤——而它正是操作者用來驗證遷移成功的工具。
 * 任何新的檢索呼叫端漏接 pickRetriever 都是同一種靜默失效，故在此立看守。
 */
const pgvectorSearch = jest.fn().mockResolvedValue([]);
const staticSearch = jest.fn().mockResolvedValue([]);
const hasPgvectorIndex = jest.fn();
const hasStaticIndex = jest.fn();

jest.mock('@/modules/knowledge/retriever.pgvector', () => ({
  __esModule: true,
  hasPgvectorIndex,
  pgvectorRetriever: { name: 'pgvector', search: pgvectorSearch },
  invalidatePgvectorModelCache: jest.fn(),
}));

jest.mock('@/modules/knowledge/retriever.staticIndex', () => ({
  __esModule: true,
  hasStaticIndex,
  staticIndexRetriever: { name: 'static-index', search: staticSearch },
  invalidateIndexCache: jest.fn(),
}));

import type { Request, Response } from 'express';

// env 於載入時 safeParse(process.env) 且 DATA_BACKEND=db 要求 DATABASE_URL；
// 不打真資料庫（連線層全被 mock 掉），只是讓 schema 驗證過得去
process.env.DATABASE_URL ??= 'postgresql://user:pw@localhost:5432/test';

/** env 在模組載入時定型，切後端一律重新載入受測模組 */
function loadIn<T>(backend: 'file' | 'db', path: string): T {
  process.env.DATA_BACKEND = backend;
  let mod!: T;
  jest.isolateModules(() => {
    mod = require(path) as T;
  });
  return mod;
}

const loadPick = (backend: 'file' | 'db'): typeof import('@/modules/knowledge/retriever.pick') =>
  loadIn(backend, '@/modules/knowledge/retriever.pick');

const loadController = (
  backend: 'file' | 'db',
): typeof import('@/modules/knowledge/knowledge.admin.controller') =>
  loadIn(backend, '@/modules/knowledge/knowledge.admin.controller');

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  jest.clearAllMocks();
});

describe('pickRetriever', () => {
  it('db 後端且已建索引 → pgvector', async () => {
    hasPgvectorIndex.mockResolvedValue(true);
    const { pickRetriever } = loadPick('db');
    expect((await pickRetriever('t1')).name).toBe('pgvector');
    expect(hasStaticIndex).not.toHaveBeenCalled(); // db 模式不該去碰索引檔
  });

  it('db 後端但尚未建索引 → stub（不可退回讀檔的 staticIndex）', async () => {
    hasPgvectorIndex.mockResolvedValue(false);
    const { pickRetriever } = loadPick('db');
    expect((await pickRetriever('t1')).name).toBe('stub');
  });

  it('file 後端且有索引檔 → static-index', async () => {
    hasStaticIndex.mockReturnValue(true);
    const { pickRetriever } = loadPick('file');
    expect((await pickRetriever('t1')).name).toBe('static-index');
    expect(hasPgvectorIndex).not.toHaveBeenCalled(); // file 模式不該打資料庫
  });

  it('file 後端且無索引檔 → stub', async () => {
    hasStaticIndex.mockReturnValue(false);
    const { pickRetriever } = loadPick('file');
    expect((await pickRetriever('t1')).name).toBe('stub');
  });
});

describe('admin 測試查詢端點', () => {
  /** 只餵 queryTest 用得到的欄位；型別以 controller 的簽章為準 */
  function reqRes(): { req: Request; res: Response; json: jest.Mock } {
    const json = jest.fn();
    return {
      req: { params: { id: 't1' }, body: { question: 'HyCMS 是什麼' } } as unknown as Request,
      res: { json } as unknown as Response,
      json,
    };
  }

  it('db 後端時走 pgvector，不會去讀根本不存在的索引檔', async () => {
    hasPgvectorIndex.mockResolvedValue(true);
    pgvectorSearch.mockResolvedValue([
      { id: 'A', title: 'HyCMS', url: 'u/a', content: 'x'.repeat(300), score: 0.9 },
    ]);
    const { knowledgeAdminController } = loadController('db');

    const { req, res, json } = reqRes();
    await knowledgeAdminController.queryTest(req, res);

    // 寫死 staticIndexRetriever 的舊實作會讓這裡是 0 呼叫、回傳 hits: []——正是那個靜默錯誤
    expect(pgvectorSearch).toHaveBeenCalledWith({ tenantId: 't1', userId: 'admin' }, 'HyCMS 是什麼');
    expect(staticSearch).not.toHaveBeenCalled();
    const { hits } = json.mock.calls[0][0].data as {
      hits: { title: string; snippet: string }[];
    };
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('HyCMS');
    expect(hits[0].snippet).toHaveLength(160); // 仍維持既有的 160 字截斷
  });

  it('file 後端時走 static-index（原行為不變）', async () => {
    hasStaticIndex.mockReturnValue(true);
    staticSearch.mockResolvedValue([]);
    const { knowledgeAdminController } = loadController('file');

    const { req, res } = reqRes();
    await knowledgeAdminController.queryTest(req, res);

    expect(staticSearch).toHaveBeenCalledWith({ tenantId: 't1', userId: 'admin' }, 'HyCMS 是什麼');
    expect(pgvectorSearch).not.toHaveBeenCalled();
  });
});
