/**
 * 索引 repository 的 db 後端：向量字面值格式、整份取代語意、分批寫入、整份刪除。
 * 以假 Prisma client 攔截 $executeRaw / $queryRaw，不打真資料庫。
 */
const executeRaw = jest.fn().mockResolvedValue(0);
const queryRaw = jest.fn().mockResolvedValue([]);

/**
 * 假交易 client 用自己專屬的 $executeRaw（txExecuteRaw），不跟外層 db 的 executeRaw
 * 共用同一個 jest.fn。saveIndexToDb 的三段敘述**必須**全部走 tx、不能有任何一段
 * 逃回外層 db——如果 tx 與外層共用同一個 mock，「metadata upsert 改用 db.$executeRaw
 * 而非 tx.$executeRaw」這種部分逃逸的回歸會完全測不出來：呼叫次數、payload 都跟
 * 全部走 tx 時一模一樣，只有分開計數才能抓到。
 */
const txExecuteRaw = jest.fn().mockResolvedValue(0);
const txClient = { $executeRaw: txExecuteRaw, $queryRaw: queryRaw };
const transaction = jest.fn(
  async (arg: unknown, _opts?: { timeout?: number }) =>
    typeof arg === 'function' ? await (arg as (tx: unknown) => Promise<unknown>)(txClient) : arg,
);

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

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/logger', () => ({ __esModule: true, logger: mockLogger }));

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
  // mockReset 而非 mockClear：失敗路徑的測試用 mockRejectedValueOnce 排隊，只 clear 的話
  // 未被消耗的 once 會外溢到後面的測試，變成難查的隨機失敗。重置後補回原本的預設回傳值。
  executeRaw.mockReset().mockResolvedValue(0);
  txExecuteRaw.mockReset().mockResolvedValue(0);
  queryRaw.mockReset().mockResolvedValue([]);
  transaction.mockClear(); // 保留自訂實作，只清呼叫紀錄
  mockLogger.error.mockClear();
});

/** tagged template 的第一個參數是字串片段陣列；接回來就是靜態 SQL 模板 */
function sqlTextOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ').toLowerCase();
}

/**
 * 把一次 $executeRaw 呼叫真正綁定的值攤平。
 * insert 那幾筆的內插值是 Prisma.join 合併後的 Sql，實際參數在它的 .values 裡；
 * 只看 call[0]（靜態模板）分辨不出「綁對值」與「綁成常數/錯欄位」的實作。
 */
function bindValuesOf(call: unknown[]): unknown[] {
  return call.slice(1).flatMap((v) =>
    v !== null && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
      ? (v as { values: unknown[] }).values
      : [v],
  );
}

/** 每列 chunk 綁 8 個值，順序同 saveIndexToDb 的 Prisma.sql 片段（含 visibility_scopes） */
const FIELDS_PER_CHUNK = 8;
const [I_TENANT, I_ID, I_URL, I_TITLE, I_TEXT, I_FILE_ID, I_VISIBILITY, I_VECTOR] = [
  0, 1, 2, 3, 4, 5, 6, 7,
];

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
    const first = String(txExecuteRaw.mock.calls[0]?.[0] ?? '');
    expect(first.toLowerCase()).toContain('delete');
    expect(txExecuteRaw.mock.calls.length).toBeGreaterThanOrEqual(3); // delete + chunks + indexes upsert
  });

  it('索引層級 metadata 一併寫入 knowledge_indexes', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    const stmts = txExecuteRaw.mock.calls.map((c) => String(c[0] ?? '').toLowerCase());
    expect(stmts.some((s) => s.includes('knowledge_indexes'))).toBe(true);
  });

  it('delete + 所有批次 insert + metadata upsert 全部在同一個交易內', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    // 沒有交易的話，delete 已 commit 而中途 insert 失敗會留下「metadata 說 ready、
    // chunks 只剩一半」的狀態——hasPgvectorIndex 仍回 true，靜默供應殘缺索引。
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(typeof transaction.mock.calls[0][0]).toBe('function');
    // 逾時要放得下最大租戶整份重寫；Prisma 預設 5 秒對 1.5k 列太緊
    const opts = transaction.mock.calls[0][1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBeGreaterThanOrEqual(30_000);
  });

  it('三段敘述全部走交易內的 tx，沒有任何一段逃回外層 db.$executeRaw', async () => {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', idx);
    // 只要有一段（例如 metadata upsert）改用 db.$executeRaw 而非 tx.$executeRaw，
    // 就是「部分逃出交易」的回歸：delete 與 chunks insert 仍在交易內、能 rollback，
    // 但 metadata upsert 已經 commit，交易語意名存實亡。呼叫次數與 payload 在
    // 共用 mock 的情況下完全看不出差異，必須分開計數才能抓到。
    expect(executeRaw).not.toHaveBeenCalled();
    expect(txExecuteRaw.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 綁定值的保真度：只斷言靜態 SQL 模板分辨不出「寫對」與數種寫壞的實作——
 * 把 toVectorLiteral(c.vector) 換成 c.text、fileId 無條件 null、批次迴圈 off-by-one
 * 造成重複或漏掉 chunks，這些都會讓模板長得一模一樣。而這條路徑搬的是已經付過錢、
 * 無法重來的向量，唯一的成功訊號是腳本印出的一行字。
 */
describe('saveIndex（db 後端）綁定值保真度', () => {
  const TOTAL = 205; // = CHUNK_INSERT_BATCH(200) + 5，強迫真的走到第二批
  const bigIdx: KnowledgeIndexFile = {
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'text-embedding-3-large',
    source: 'https://example.com',
    // 每個 chunk 的 id 與向量都可辨識：向量首元素即序號，錯位/重複一眼看得出來
    chunks: Array.from({ length: TOTAL }, (_, i) => ({
      id: `c${i}`,
      url: `https://example.com/${i}`,
      title: `標題 ${i}`,
      text: `內容 ${i}`,
      vector: [i, 0.5, -1],
      // 奇數號為檔案來源、偶數號為網站來源（removeFile / countBySource 靠這欄區分）
      ...(i % 2 === 1 ? { fileId: `F${i}` } : {}),
    })),
  };

  /** 走完 saveIndex，回傳所有 insert 呼叫攤平後的「每列 7 值」tuple */
  async function insertTuplesOf(): Promise<{ calls: unknown[][]; tuples: unknown[][] }> {
    const { saveIndex } = loadRepoInDbMode();
    await saveIndex('t1', bigIdx);
    const calls = txExecuteRaw.mock.calls.filter((c) =>
      sqlTextOf(c).includes('insert into knowledge_chunks'),
    );
    const tuples: unknown[][] = [];
    for (const call of calls) {
      const values = bindValuesOf(call);
      expect(values.length % FIELDS_PER_CHUNK).toBe(0);
      for (let i = 0; i < values.length; i += FIELDS_PER_CHUNK) {
        tuples.push(values.slice(i, i + FIELDS_PER_CHUNK));
      }
    }
    return { calls, tuples };
  }

  it('205 個 chunk 剛好切成兩個 insert statement（200 + 5）', async () => {
    const { calls } = await insertTuplesOf();
    expect(calls).toHaveLength(2);
    expect(bindValuesOf(calls[0]).length / FIELDS_PER_CHUNK).toBe(200);
    expect(bindValuesOf(calls[1]).length / FIELDS_PER_CHUNK).toBe(5);
  });

  it('每個 chunk id 恰好出現一次（不重複、不遺漏）', async () => {
    const { tuples } = await insertTuplesOf();
    const ids = tuples.map((t) => t[I_ID]);
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);
    expect([...ids].sort()).toEqual([...bigIdx.chunks.map((c) => c.id)].sort());
  });

  it('向量以精確的 pgvector 字面值綁在該列的向量欄位上', async () => {
    const { tuples } = await insertTuplesOf();
    // 挑第二批裡的一個（c203），確保跨批次也沒有錯位
    const t = tuples.find((x) => x[I_ID] === 'c203');
    expect(t?.[I_VECTOR]).toBe('[203,0.5,-1]');
    // 同一列的其餘欄位也要對上，否則「向量對了但接到別列」照樣是壞的
    expect(t?.[I_TENANT]).toBe('t1');
    expect(t?.[I_URL]).toBe('https://example.com/203');
    expect(t?.[I_TITLE]).toBe('標題 203');
    expect(t?.[I_TEXT]).toBe('內容 203');
    // 第一批的邊界列也驗一次
    expect(tuples.find((x) => x[I_ID] === 'c0')?.[I_VECTOR]).toBe('[0,0.5,-1]');
    expect(tuples.find((x) => x[I_ID] === 'c199')?.[I_VECTOR]).toBe('[199,0.5,-1]');
  });

  it('fileId：網站 chunk 綁 null、檔案 chunk 綁該 id（來源區分不可被抹掉）', async () => {
    const { tuples } = await insertTuplesOf();
    expect(tuples.find((t) => t[I_ID] === 'c204')?.[I_FILE_ID]).toBeNull();
    expect(tuples.find((t) => t[I_ID] === 'c203')?.[I_FILE_ID]).toBe('F203');
    expect(tuples.find((t) => t[I_ID] === 'c0')?.[I_FILE_ID]).toBeNull();
    expect(tuples.find((t) => t[I_ID] === 'c1')?.[I_FILE_ID]).toBe('F1');
    // 全體數量也要對（0..204 的奇數共 102 個）：無條件 null 的實作會讓這裡歸零
    expect(tuples.filter((t) => t[I_FILE_ID] !== null)).toHaveLength(102);
  });

  it('visibilityScopes 未設時綁 NULL（＝從未標記，非明確標成空陣列）', async () => {
    const { tuples } = await insertTuplesOf();
    expect(tuples.every((t) => t[I_VISIBILITY] === null)).toBe(true);
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

/**
 * 輕量讀取：向量以文字字面值往返時每筆約 27KB，而「取 model/source」「算數量」「生推薦問句」
 * 這三條路徑一個位元組都用不到。6k 個 chunk 就是 170MB，Supabase 會直接以 statement timeout
 * 砍掉查詢（57014）——而且是每匯入一個檔重演一次，檔案越多越早撞牆。
 */
describe('輕量讀取（db 後端）', () => {
  const METAROW = {
    generated_at: new Date('2026-08-04T00:00:00.000Z'),
    model: 'text-embedding-3-large',
    source: 'file://人事規章.xlsx',
  };

  it('loadIndexMeta 只查 knowledge_indexes，完全不碰 knowledge_chunks', async () => {
    queryRaw.mockResolvedValueOnce([METAROW]);
    const { loadIndexMeta } = loadRepoInDbMode();
    const got = await loadIndexMeta('t1');

    expect(got).toEqual({
      generatedAt: '2026-08-04T00:00:00.000Z',
      model: 'text-embedding-3-large',
      source: 'file://人事規章.xlsx',
    });
    // 為了兩個字串把整份向量拖過網路，正是 57014 的成因
    expect(queryRaw.mock.calls.map(sqlTextOf).join(' ')).not.toContain('knowledge_chunks');
  });

  it('loadIndexMeta 查無索引列時回 null', async () => {
    queryRaw.mockResolvedValueOnce([]);
    const { loadIndexMeta } = loadRepoInDbMode();
    expect(await loadIndexMeta('nobody')).toBeNull();
  });

  it('loadIndexText 讀得到文字，但 select 不含 embedding 欄', async () => {
    queryRaw.mockResolvedValueOnce([METAROW]).mockResolvedValueOnce([
      { id: 'a', url: 'file://x.xlsx', title: 'x.xlsx', text: '內容 A', file_id: 'F1' },
    ]);
    const { loadIndexText } = loadRepoInDbMode();
    const got = await loadIndexText('t1');

    expect(got?.chunks).toEqual([
      { id: 'a', url: 'file://x.xlsx', title: 'x.xlsx', text: '內容 A', fileId: 'F1' },
    ]);
    const chunkQuery = queryRaw.mock.calls.map(sqlTextOf).find((s) => s.includes('knowledge_chunks'));
    expect(chunkQuery).toBeDefined();
    expect(chunkQuery).not.toContain('embedding'); // 少了這條斷言，退回整份載入不會被發現
  });

  it('countChunksBySource 在 DB 端聚合，不把任何列搬回來', async () => {
    queryRaw.mockResolvedValueOnce([{ website: 12, file: 8004 }]);
    const { countChunksBySource } = loadRepoInDbMode();
    expect(await countChunksBySource('t1')).toEqual({ website: 12, file: 8004 });

    const sql = queryRaw.mock.calls.map(sqlTextOf).join(' ');
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('embedding');
  });

  it('countChunksBySource 對無任何 chunk 的租戶回 0（不是 undefined）', async () => {
    queryRaw.mockResolvedValueOnce([]);
    const { countChunksBySource } = loadRepoInDbMode();
    expect(await countChunksBySource('nobody')).toEqual({ website: 0, file: 0 });
  });
});

/**
 * appendChunks 與 saveIndex 語意不同：只 INSERT、不刪，且**刻意不包交易**。
 *
 * 互動式交易的逾時是牆鐘時間，涵蓋所有批次的網路傳輸——每列 halfvec(3072) 以文字字面值
 * 送出約 27KB，1.5k 個 chunk 就是 40MB 要在同一個交易內推到 Supabase，大檔必定撞
 * 30 秒上限（P2028），而且每次重試連 embedding 一起重跑，反覆付費卻永遠寫不進去。
 * 少了交易也就沒有 rollback，因此失敗時的補償刪除是這條路徑的正確性關鍵。
 */
describe('appendChunks（db 後端）', () => {
  const TOTAL = 205; // = CHUNK_INSERT_BATCH(200) + 5，強迫真的走到第二批
  const chunks = Array.from({ length: TOTAL }, (_, i) => ({
    id: `c${i}`,
    url: 'file://人事規章.xlsx',
    title: '人事規章.xlsx',
    text: `內容 ${i}`,
    vector: [i, 0.5, -1],
    fileId: 'F1',
  }));
  const meta = { model: 'text-embedding-3-large', source: 'file://人事規章.xlsx' };

  /** 取出補償刪除那一筆 $executeRaw 呼叫 */
  function cleanupCall(): unknown[] | undefined {
    return executeRaw.mock.calls.find((c) => sqlTextOf(c).includes('delete'));
  }

  it('不包交易——40MB 的跨網路傳輸放在交易裡必定撞 30 秒逾時', async () => {
    const { appendChunks } = loadRepoInDbMode();
    await appendChunks('t1', chunks, meta);
    expect(transaction).not.toHaveBeenCalled();
    expect(txExecuteRaw).not.toHaveBeenCalled();
  });

  it('chunks 分批 insert，metadata upsert 擺最後', async () => {
    const { appendChunks } = loadRepoInDbMode();
    await appendChunks('t1', chunks, meta);
    const stmts = executeRaw.mock.calls.map(sqlTextOf);
    expect(stmts.filter((s) => s.includes('insert into knowledge_chunks'))).toHaveLength(2);
    // metadata 是「這批 chunks 已經好了」的宣告，提早寫會讓檢索器在資料還沒到齊時就當它是最新的
    expect(stmts[stmts.length - 1]).toContain('knowledge_indexes');
  });

  it('成功路徑不下任何 delete——附加不得動到其他檔案的 chunks', async () => {
    const { appendChunks } = loadRepoInDbMode();
    await appendChunks('t1', chunks, meta);
    expect(cleanupCall()).toBeUndefined();
  });

  it('insert 中途失敗 → 補償刪除本次寫入的所有 id，並拋回原始錯誤', async () => {
    const { appendChunks } = loadRepoInDbMode();
    const boom = new Error('Transaction already closed');
    executeRaw.mockRejectedValueOnce(boom);

    await expect(appendChunks('t1', chunks, meta)).rejects.toBe(boom);

    // 沒有 rollback，殘骸只能自己收：漏掉就留下 meta.files 指不到、admin 刪不掉，
    // 檢索卻照樣撈得到的孤兒 chunks（重試換一組 randomUUID，永遠不會覆寫到它們）
    const del = cleanupCall();
    expect(del).toBeDefined();
    const bound = bindValuesOf(del as unknown[]);
    expect(bound).toHaveLength(TOTAL + 1); // tenantId + 每個 chunk id
    expect(bound).toEqual(expect.arrayContaining(['t1', 'c0', 'c204']));
  });

  it('metadata upsert 失敗一樣要補償，不能留下「chunks 在、meta 沒更新」', async () => {
    const { appendChunks } = loadRepoInDbMode();
    const boom = new Error('connection reset');
    // 兩批 insert 過，第三個 statement（metadata upsert）才失敗
    executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockRejectedValueOnce(boom);

    await expect(appendChunks('t1', chunks, meta)).rejects.toBe(boom);
    expect(cleanupCall()).toBeDefined();
  });

  it('補償刪除本身也失敗時，往外拋的仍是原始錯誤，並留下可追查的紀錄', async () => {
    const { appendChunks } = loadRepoInDbMode();
    const boom = new Error('Transaction already closed');
    executeRaw.mockRejectedValueOnce(boom).mockRejectedValueOnce(new Error('cleanup failed'));

    // 改拋 cleanup 的錯會蓋掉真正的根因，P2028 這種關鍵訊息就此消失在日誌裡
    await expect(appendChunks('t1', chunks, meta)).rejects.toBe(boom);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('chunks 為空時完全不打 DB', async () => {
    const { appendChunks } = loadRepoInDbMode();
    await appendChunks('t1', [], meta);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

/**
 * 網站重爬的取代範圍。saveIndex 是「刪光整個租戶」，用在重爬上會逼呼叫端先把檔案 chunks
 * 整份撈回來（8.8k 個約 238MB，直接撞 statement timeout），而且它先刪後寫——失敗時使用者
 * 上傳文件的向量已經沒了，重爬產不回來。replaceWebsiteChunks 把範圍收斂到 file_id is null。
 */
describe('replaceWebsiteChunks（db 後端）', () => {
  const meta = {
    generatedAt: '2026-08-18T00:00:00.000Z',
    model: 'text-embedding-3-large',
    source: 'https://example.com',
  };
  const webChunks = [
    { id: 'w1', url: 'https://example.com/a', title: 'A', text: '網站甲', vector: [1, 0, 0] },
  ];

  it('delete 帶 file_id is null 條件——不得刪到檔案來源的 chunks', async () => {
    const { replaceWebsiteChunks } = loadRepoInDbMode();
    await replaceWebsiteChunks('t1', webChunks, meta);

    const del = txExecuteRaw.mock.calls.map(sqlTextOf).find((s) => s.includes('delete'));
    expect(del).toBeDefined();
    // 少了這個條件，重爬會連使用者上傳的文件一起清掉，而那些內容爬蟲永遠產不回來
    expect(del).toContain('file_id is null');
  });

  it('仍包在交易內：這是整批取代，delete 後 insert 失敗會留下殘缺的網站內容', async () => {
    const { replaceWebsiteChunks } = loadRepoInDbMode();
    await replaceWebsiteChunks('t1', webChunks, meta);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled(); // 沒有任何一段逃出交易
  });

  it('更新 knowledge_indexes 的 model 與 source（重爬即重新定義索引）', async () => {
    const { replaceWebsiteChunks } = loadRepoInDbMode();
    await replaceWebsiteChunks('t1', webChunks, meta);

    // 與 appendChunks 相反：附加不得改動既有索引的模型，重爬才是重新定義的時機
    const upsert = txExecuteRaw.mock.calls.map(sqlTextOf).find((s) => s.includes('knowledge_indexes'));
    expect(upsert).toContain('model = excluded.model');
    expect(upsert).toContain('source = excluded.source');
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
