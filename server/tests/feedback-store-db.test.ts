/**
 * feedback.store 的 db 後端：以假 Prisma client 驗證 cleanupExpired 也會依 cutoff 刪 db 整表，
 * 涵蓋停機期間到期、開機未載入的列（手法沿用 report-store-db.test.ts）。
 */
const deleteMany = jest.fn().mockResolvedValue(undefined);
const fakeDb = { replyFeedbackRow: { deleteMany, upsert: jest.fn().mockResolvedValue(undefined), findMany: jest.fn().mockResolvedValue([]) } };

jest.mock('@/lib/db', () => ({
  __esModule: true,
  getDb: () => fakeDb,
  connectDb: async () => fakeDb,
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void {
      void task(fakeDb);
    }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  deleteMany.mockClear();
});

it('db 後端 cleanupExpired 依保存期限對 db 整表刪除（即使記憶體為空）', () => {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/feedback/feedback.store');
  jest.isolateModules(() => {
    mod = require('@/modules/feedback/feedback.store');
  });
  const now = Date.parse('2026-10-13T00:00:00.000Z');
  expect(mod.feedbackStore.cleanupExpired(now)).toBe(0);
  expect(deleteMany).toHaveBeenCalledTimes(1);
  const { updatedAt } = deleteMany.mock.calls[0][0].where;
  expect(updatedAt.lt).toEqual(new Date(now - 180 * 86_400_000));
});
