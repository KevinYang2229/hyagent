/**
 * 報告產出物儲存：多格式並存、TTL 回收、get 為 async（db 模式下需能從資料庫讀回）。
 */
import { env } from '@/config/env';
import { reportStore } from '@/modules/report/report.store';

/** 推過保存期限的時間點；不寫死小時數，TTL 預設調整時測試不必跟著改 */
const afterTtl = (base = Date.now()): Date =>
  new Date(base + (env.REPORT_TTL_HOURS + 1) * 3600_000);

function save(reportId: string, format: string, body: string): void {
  reportStore.save({
    reportId,
    tenantId: 't1',
    userId: 'u1',
    format,
    filename: `report.${format}`,
    content: Buffer.from(body, 'utf8'),
  });
}

beforeEach(() => reportStore._resetForTest());

describe('reportStore', () => {
  it('同一 reportId 的不同格式互不覆蓋', async () => {
    save('r1', 'md', '# md');
    save('r1', 'html', '<h1>html</h1>');
    expect((await reportStore.get('r1', 'md'))?.content.toString()).toBe('# md');
    expect((await reportStore.get('r1', 'html'))?.content.toString()).toBe('<h1>html</h1>');
    expect((await reportStore.formatsOf('r1')).sort()).toEqual(['html', 'md']);
  });

  it('未存過的報告或格式回 undefined', async () => {
    save('r1', 'md', '# md');
    expect(await reportStore.get('r1', 'pdf')).toBeUndefined();
    expect(await reportStore.get('nope', 'md')).toBeUndefined();
    expect(await reportStore.formatsOf('nope')).toEqual([]);
  });

  it('帶回租戶與建立者，供下載時授權比對（job 記憶體狀態可能已因重啟消失）', async () => {
    save('r1', 'md', '# md');
    const stored = await reportStore.get('r1', 'md');
    expect(stored?.tenantId).toBe('t1');
    expect(stored?.userId).toBe('u1');
  });

  it('TTL 過期後被回收', async () => {
    save('r1', 'md', '# md');
    const later = afterTtl();
    const purged = reportStore.purgeExpired(later);
    expect(purged).toBe(1);
    expect(await reportStore.get('r1', 'md')).toBeUndefined();
  });

  it('未過期者不被回收', async () => {
    save('r1', 'md', '# md');
    expect(reportStore.purgeExpired(new Date())).toBe(0);
    expect(await reportStore.get('r1', 'md')).toBeDefined();
  });

  it('過期後即使沒人呼叫 purgeExpired，get 也不會照回記憶體中的內容', async () => {
    const realNow = Date.now;
    try {
      const base = new Date('2026-01-01T00:00:00.000Z').getTime();
      Date.now = () => base;
      save('r1', 'md', '# md');
      // 沒有呼叫 reportStore.purgeExpired()：時間推過 TTL 後直接 get
      Date.now = () => afterTtl(base).getTime();
      expect(await reportStore.get('r1', 'md')).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});

/**
 * 後台查詢：以「一份報告」為單位列出（同一 reportId 的多種格式收在一起），
 * 支援時間區間與關鍵字（檔名／使用者）。job 狀態純記憶體、重啟即失，
 * 因此這裡能查的只有 report_docs 實際存下來的欄位。
 */
describe('reportStore.listByTenant', () => {
  function saveAt(
    reportId: string,
    userId: string,
    filename: string,
    formats: string[] = ['md', 'html'],
  ): void {
    for (const format of formats) {
      reportStore.save({
        reportId,
        tenantId: 't1',
        userId,
        format,
        filename: `${filename}.${format}`,
        content: Buffer.from('x', 'utf8'),
      });
    }
  }

  it('同一 reportId 的多種格式收成一列，files 依格式列出', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    const rows = await reportStore.listByTenant('t1', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].reportId).toBe('r1');
    expect(rows[0].userId).toBe('kevin');
    expect(rows[0].files.map((f) => f.format).sort()).toEqual(['html', 'md']);
  });

  it('只回該租戶的報告', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    reportStore.save({
      reportId: 'other',
      tenantId: 't2',
      userId: 'kevin',
      format: 'md',
      filename: '別的租戶.md',
      content: Buffer.from('x', 'utf8'),
    });
    const rows = await reportStore.listByTenant('t1', {});
    expect(rows.map((r) => r.reportId)).toEqual(['r1']);
  });

  it('關鍵字比對檔名（不分大小寫）', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    saveAt('r2', 'amy', '請假規定彙整');
    expect((await reportStore.listByTenant('t1', { q: '產品' })).map((r) => r.reportId)).toEqual(['r1']);
    expect((await reportStore.listByTenant('t1', { q: '請假' })).map((r) => r.reportId)).toEqual(['r2']);
  });

  it('關鍵字也比對使用者', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    saveAt('r2', 'amy', '請假規定彙整');
    expect((await reportStore.listByTenant('t1', { q: 'amy' })).map((r) => r.reportId)).toEqual(['r2']);
  });

  it('時間區間過濾（from／to 皆為含端點）', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    const rows = await reportStore.listByTenant('t1', {
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(rows).toHaveLength(1);

    const past = await reportStore.listByTenant('t1', {
      to: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past).toHaveLength(0);
  });

  it('已過期的報告不列出——使用者端拿不到的東西，後台也不該列成可下載', async () => {
    saveAt('r1', 'kevin', '產品分析報告');
    const rows = await reportStore.listByTenant('t1', {}, new Date(Date.now() + 8760 * 3600_000));
    expect(rows).toHaveLength(0);
  });

  it('依建立時間新到舊排序', async () => {
    // 同一毫秒寫入時建立時間相同、排序不定，固定時間才驗得到「新到舊」這件事
    const realNow = Date.now;
    try {
      Date.now = () => new Date('2026-01-01T00:00:00.000Z').getTime();
      saveAt('r1', 'kevin', '第一份');
      Date.now = () => new Date('2026-01-01T01:00:00.000Z').getTime();
      saveAt('r2', 'kevin', '第二份');
    } finally {
      Date.now = realNow;
    }
    // 查詢的時間基準也要落在保存期內，否則兩份都會被判定過期而濾掉
    const rows = await reportStore.listByTenant('t1', {}, new Date('2026-01-02T00:00:00.000Z'));
    expect(rows.map((r) => r.reportId)).toEqual(['r2', 'r1']);
  });
});
