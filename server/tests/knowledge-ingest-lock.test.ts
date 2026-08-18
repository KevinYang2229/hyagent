/**
 * 批次匯入的租戶級互斥鎖：取得／接管／續期／釋放的 SQL 語意。
 * 以假 Prisma client 攔截，不打真資料庫。
 */
const executeRaw = jest.fn().mockResolvedValue(0);
const queryRaw = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
}));
const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/logger', () => ({ __esModule: true, logger: mockLogger }));

function loadInDbMode(): typeof import('@/modules/knowledge/knowledge.ingest-lock') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.ingest-lock');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.ingest-lock');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  executeRaw.mockReset().mockResolvedValue(0);
  queryRaw.mockReset().mockResolvedValue([]);
  mockLogger.warn.mockClear();
});

const sqlTextOf = (call: unknown[]): string => (call[0] as readonly string[]).join(' ').toLowerCase();
const bindValuesOf = (call: unknown[]): unknown[] => call.slice(1);

describe('acquireIngestLock', () => {
  it('取得成功時回傳鎖，holder 帶得到 host:pid 方便排查', async () => {
    queryRaw.mockResolvedValueOnce([{ holder: 'x' }]);
    const { acquireIngestLock } = loadInDbMode();
    const lock = await acquireIngestLock('t1');

    expect(lock?.tenantId).toBe('t1');
    expect(lock?.holder).toContain(String(process.pid));
  });

  it('鎖被活著的持有者握著時回 null（呼叫端應略過該租戶，而非報錯）', async () => {
    queryRaw.mockResolvedValueOnce([]); // ON CONFLICT 的 where 沒過 = 沒有回傳列
    const { acquireIngestLock } = loadInDbMode();
    expect(await acquireIngestLock('t1')).toBeNull();
  });

  it('取得與接管在同一個 INSERT ... ON CONFLICT 內完成', async () => {
    queryRaw.mockResolvedValueOnce([{ holder: 'x' }]);
    const { acquireIngestLock, LOCK_TTL_MINUTES } = loadInDbMode();
    await acquireIngestLock('t1');

    const sql = sqlTextOf(queryRaw.mock.calls[0]);
    // 拆成先 SELECT 再 UPDATE 的話，兩個 process 會同時看到過期的鎖、同時判定可接管，
    // 這道鎖就等於沒做。原子性必須靠 ON CONFLICT ... where 一次完成。
    expect(sql).toContain('insert into knowledge_ingest_locks');
    expect(sql).toContain('on conflict');
    expect(sql).toContain('heartbeat_at');
    expect(sql).toContain('returning holder');
    expect(bindValuesOf(queryRaw.mock.calls[0])).toContain(LOCK_TTL_MINUTES);
  });

  it('TTL 以 heartbeat_at 為準而非 acquired_at（長匯入不該被誤判成殘留）', async () => {
    queryRaw.mockResolvedValueOnce([{ holder: 'x' }]);
    const { acquireIngestLock } = loadInDbMode();
    await acquireIngestLock('t1');
    const sql = sqlTextOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/where\s+knowledge_ingest_locks\.heartbeat_at\s*</);
    expect(sql).not.toMatch(/where\s+knowledge_ingest_locks\.acquired_at\s*</);
  });

  it('file 後端不打 DB：單一 process，無從併發', async () => {
    process.env.DATA_BACKEND = 'file';
    let mod!: typeof import('@/modules/knowledge/knowledge.ingest-lock');
    jest.isolateModules(() => {
      mod = require('@/modules/knowledge/knowledge.ingest-lock');
    });
    expect(await mod.acquireIngestLock('t1')).not.toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('renewIngestLock / releaseIngestLock', () => {
  it('續期帶 holder 條件——鎖已被接管就不該再續期別人的鎖', async () => {
    const { renewIngestLock } = loadInDbMode();
    await renewIngestLock({ tenantId: 't1', holder: 'me' });

    const sql = sqlTextOf(executeRaw.mock.calls[0]);
    expect(sql).toContain('update knowledge_ingest_locks');
    expect(sql).toContain('holder =');
    expect(bindValuesOf(executeRaw.mock.calls[0])).toEqual(['t1', 'me']);
  });

  it('釋放只刪自己的鎖', async () => {
    const { releaseIngestLock } = loadInDbMode();
    await releaseIngestLock({ tenantId: 't1', holder: 'me' });

    const sql = sqlTextOf(executeRaw.mock.calls[0]);
    expect(sql).toContain('delete from knowledge_ingest_locks');
    expect(bindValuesOf(executeRaw.mock.calls[0])).toEqual(['t1', 'me']);
  });

  it('釋放失敗不拋錯：匯入已經完成，殘留鎖由 TTL 回收', async () => {
    executeRaw.mockRejectedValueOnce(new Error('connection reset'));
    const { releaseIngestLock } = loadInDbMode();
    await expect(releaseIngestLock({ tenantId: 't1', holder: 'me' })).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
