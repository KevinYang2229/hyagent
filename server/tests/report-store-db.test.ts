/**
 * report.store 的 db 後端：以假 Prisma client 驗證讀回、過期判定、upsert 內容、
 * formatsOf 的 db 併集，不打真資料庫（tests/setup-env.ts 固定 DATA_BACKEND=file，
 * 此處以 isolateModules 覆寫，手法沿用 knowledge-store-db.test.ts）。
 *
 * 這組測試補的正是 report.store 相對 attachment.store 的核心差異：get 做成 async
 * 就是為了讓重啟後（記憶體為空）仍能從 Postgres 讀回產出物；讀不回來等於 db 落地白做。
 */
const findUnique = jest.fn();
const upsert = jest.fn().mockResolvedValue(undefined);
const findMany = jest.fn().mockResolvedValue([]);
const deleteMany = jest.fn().mockResolvedValue(undefined);

const fakeDb = { reportDocRow: { findUnique, upsert, findMany, deleteMany } };

jest.mock('@/lib/db', () => ({
  __esModule: true,
  getDb: () => fakeDb,
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void {
      void task(fakeDb);
    }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/** 在 DATA_BACKEND=db 下重新載入 store（env 於模組載入時定型，必須 isolateModules） */
function loadStoreInDbMode(): typeof import('@/modules/report/report.store') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/report/report.store');
  jest.isolateModules(() => {
    mod = require('@/modules/report/report.store');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  findUnique.mockClear();
  upsert.mockClear();
  findMany.mockClear();
  deleteMany.mockClear();
});

describe('reportStore（db 後端）', () => {
  it('記憶體未命中 → 查 db → 取得資料並回填記憶體（第二次 get 不再打 db）', async () => {
    findUnique.mockResolvedValueOnce({
      reportId: 'r1',
      format: 'md',
      tenantId: 't1',
      userId: 'u1',
      filename: 'report.md',
      content: Buffer.from('# md', 'utf8'),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const { reportStore } = loadStoreInDbMode();

    const first = await reportStore.get('r1', 'md');
    expect(first?.content.toString()).toBe('# md');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { reportId_format: { reportId: 'r1', format: 'md' } },
    });

    const second = await reportStore.get('r1', 'md');
    expect(second?.content.toString()).toBe('# md');
    expect(findUnique).toHaveBeenCalledTimes(1); // 已回填記憶體，不再打 db
  });

  it('db 列已過期 → 視為未命中回 undefined', async () => {
    findUnique.mockResolvedValueOnce({
      reportId: 'r1',
      format: 'md',
      tenantId: 't1',
      userId: 'u1',
      filename: 'report.md',
      content: Buffer.from('# md', 'utf8'),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    const { reportStore } = loadStoreInDbMode();

    expect(await reportStore.get('r1', 'md')).toBeUndefined();
  });

  it('save 在 db 模式下送出的 upsert where / create / update 內容正確', async () => {
    const { reportStore } = loadStoreInDbMode();

    reportStore.save({
      reportId: 'r1',
      tenantId: 't1',
      userId: 'u1',
      format: 'md',
      filename: 'report.md',
      content: Buffer.from('# md', 'utf8'),
    });
    await Promise.resolve(); // enqueue 的 task 為 fire-and-forget，等一個 microtask 讓它執行完

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ reportId_format: { reportId: 'r1', format: 'md' } });
    expect(arg.create).toMatchObject({
      reportId: 'r1',
      format: 'md',
      tenantId: 't1',
      userId: 'u1',
      filename: 'report.md',
    });
    expect(Buffer.isBuffer(arg.create.content)).toBe(true);
    expect(arg.create.content.toString()).toBe('# md');
    expect(arg.create.expiresAt).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(arg.update.content)).toBe(true);
    expect(arg.update.expiresAt).toBeInstanceOf(Date);
  });

  it('formatsOf：記憶體是空的，db 模式下仍能取得格式清單', async () => {
    findMany.mockResolvedValueOnce([
      { format: 'md', filename: 'report.md' },
      { format: 'html', filename: 'report.html' },
    ]);
    const { reportStore } = loadStoreInDbMode();

    const formats = await reportStore.formatsOf('r1');
    expect(formats.sort()).toEqual(['html', 'md']);
    expect(findMany).toHaveBeenCalledWith({
      where: { reportId: 'r1', expiresAt: { gt: expect.any(Date) } },
      select: { format: true, filename: true },
    });
  });

  it('formatsOf：記憶體與 db 各有資料時取聯集且去重', async () => {
    findMany.mockResolvedValueOnce([
      { format: 'md', filename: 'report.md' },
      { format: 'pdf', filename: 'report.pdf' },
    ]);
    const { reportStore } = loadStoreInDbMode();

    reportStore.save({
      reportId: 'r1',
      tenantId: 't1',
      userId: 'u1',
      format: 'md',
      filename: 'report.md',
      content: Buffer.from('# md', 'utf8'),
    });
    await Promise.resolve();

    const formats = await reportStore.formatsOf('r1');
    expect(formats.sort()).toEqual(['md', 'pdf']);
  });

  it('filesOf：記憶體是空的，db 模式下仍能取得格式＋檔名清單（狀態端點設定下載檔名用）', async () => {
    findMany.mockResolvedValueOnce([{ format: 'md', filename: '請假規定彙整報告.md' }]);
    const { reportStore } = loadStoreInDbMode();

    const files = await reportStore.filesOf('r1');
    expect(files).toEqual([{ format: 'md', filename: '請假規定彙整報告.md' }]);
  });

  it('filesOf：記憶體與 db 各有資料時取聯集且去重，同格式以記憶體命中優先', async () => {
    findMany.mockResolvedValueOnce([
      { format: 'md', filename: 'db-算出的檔名.md' },
      { format: 'pdf', filename: 'report.pdf' },
    ]);
    const { reportStore } = loadStoreInDbMode();

    reportStore.save({
      reportId: 'r1',
      tenantId: 't1',
      userId: 'u1',
      format: 'md',
      filename: '記憶體算出的檔名.md',
      content: Buffer.from('# md', 'utf8'),
    });
    await Promise.resolve();

    const files = await reportStore.filesOf('r1');
    expect(files.sort((a, b) => a.format.localeCompare(b.format))).toEqual([
      { format: 'md', filename: '記憶體算出的檔名.md' },
      { format: 'pdf', filename: 'report.pdf' },
    ]);
  });
});
