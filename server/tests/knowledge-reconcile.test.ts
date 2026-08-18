/**
 * 索引對帳：三種漂移的掃描，以及「只刪報告上列出的那幾筆」這個安全性質。
 * 以假 Prisma client 攔截 $queryRaw / $executeRaw，不打真資料庫。
 */
const executeRaw = jest.fn().mockResolvedValue(0);
const queryRaw = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
}));

import type { OrphanFile } from '@/modules/knowledge/knowledge.reconcile';

function loadInDbMode(): typeof import('@/modules/knowledge/knowledge.reconcile') {
  process.env.DATA_BACKEND = 'db';
  let mod!: typeof import('@/modules/knowledge/knowledge.reconcile');
  jest.isolateModules(() => {
    mod = require('@/modules/knowledge/knowledge.reconcile');
  });
  return mod;
}

afterEach(() => {
  process.env.DATA_BACKEND = 'file';
  executeRaw.mockReset().mockResolvedValue(0);
  queryRaw.mockReset().mockResolvedValue([]);
});

/** tagged template 的靜態片段接回來就是 SQL 模板 */
function sqlTextOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ').toLowerCase();
}

/** 攤平實際綁定的值（Prisma.join 合併後的參數在其 .values 裡） */
function bindValuesOf(call: unknown[]): unknown[] {
  return call.slice(1).flatMap((v) =>
    v !== null && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
      ? (v as { values: unknown[] }).values
      : [v],
  );
}

const ORPHANS: OrphanFile[] = [
  { tenantId: 't1', fileId: 'F-old', title: 'CC匯出.xlsx', chunks: 800 },
  { tenantId: 't2', fileId: 'F-dead', title: '規章.pdf', chunks: 12 },
];

describe('scanIndexDrift', () => {
  it('三種漂移各查一次，全部唯讀', async () => {
    queryRaw
      .mockResolvedValueOnce(ORPHANS)
      .mockResolvedValueOnce([{ tenantId: 'TTS', chunks: 8004 }])
      .mockResolvedValueOnce([{ tenantId: 't1', fileId: 'F-x', name: 'a.txt' }]);

    const { scanIndexDrift } = loadInDbMode();
    const report = await scanIndexDrift();

    expect(report.orphans).toEqual(ORPHANS);
    expect(report.phantoms).toEqual([{ tenantId: 'TTS', chunks: 8004 }]);
    expect(report.missing).toEqual([{ tenantId: 't1', fileId: 'F-x', name: 'a.txt' }]);
    expect(executeRaw).not.toHaveBeenCalled(); // 掃描不得寫入任何東西
  });

  it('孤兒查詢 join knowledge_sources——讀不到 meta 的租戶寧可漏報也不誤判', async () => {
    const { scanIndexDrift } = loadInDbMode();
    await scanIndexDrift();

    const sql = queryRaw.mock.calls.map(sqlTextOf).find((s) => s.includes('jsonb_array_elements'));
    expect(sql).toContain('join knowledge_sources');
    // 少了這個 join，沒有 sources 列的租戶會因為 not exists 恆真而整份被判成孤兒
    expect(sql).toContain('c.file_id is not null');
  });

  it('帶 tenantId 時三個查詢都要收斂範圍', async () => {
    const { scanIndexDrift } = loadInDbMode();
    await scanIndexDrift('t1');
    expect(queryRaw).toHaveBeenCalledTimes(3);
    for (const call of queryRaw.mock.calls) {
      expect(bindValuesOf(call)).toContain('t1');
    }
  });

  it('file 後端直接擋下（整份 JSON 原子覆寫，不會有部分寫入）', async () => {
    process.env.DATA_BACKEND = 'file';
    let mod!: typeof import('@/modules/knowledge/knowledge.reconcile');
    jest.isolateModules(() => {
      mod = require('@/modules/knowledge/knowledge.reconcile');
    });
    await expect(mod.scanIndexDrift()).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('deleteOrphanChunks', () => {
  it('逐筆列出 (tenant_id, file_id)，不下相關子查詢', async () => {
    const { deleteOrphanChunks } = loadInDbMode();
    await deleteOrphanChunks(ORPHANS);

    const sql = sqlTextOf(executeRaw.mock.calls[0]);
    expect(sql).toContain('delete from knowledge_chunks');
    // 關鍵安全性質：刪的是報告上印出來、人看過的那幾筆。若改成把掃描的子查詢直接寫成
    // DELETE，掃描與刪除之間的任何資料變動都會擴大刪除範圍，且事後無從稽核刪了什麼。
    expect(sql).not.toContain('not exists');
    expect(sql).not.toContain('jsonb_array_elements');
    expect(bindValuesOf(executeRaw.mock.calls[0])).toEqual(['t1', 'F-old', 't2', 'F-dead']);
  });

  it('沒有孤兒時完全不打 DB', async () => {
    const { deleteOrphanChunks } = loadInDbMode();
    expect(await deleteOrphanChunks([])).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('回傳實際刪除的列數', async () => {
    executeRaw.mockResolvedValueOnce(812);
    const { deleteOrphanChunks } = loadInDbMode();
    expect(await deleteOrphanChunks(ORPHANS)).toBe(812);
  });
});
