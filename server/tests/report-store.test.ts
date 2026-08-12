/**
 * 報告產出物儲存：多格式並存、TTL 回收、get 為 async（db 模式下需能從資料庫讀回）。
 */
import { reportStore } from '@/modules/report/report.store';

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
    expect(reportStore.formatsOf('r1').sort()).toEqual(['html', 'md']);
  });

  it('未存過的報告或格式回 undefined', async () => {
    save('r1', 'md', '# md');
    expect(await reportStore.get('r1', 'pdf')).toBeUndefined();
    expect(await reportStore.get('nope', 'md')).toBeUndefined();
    expect(reportStore.formatsOf('nope')).toEqual([]);
  });

  it('帶回租戶與建立者，供下載時授權比對（job 記憶體狀態可能已因重啟消失）', async () => {
    save('r1', 'md', '# md');
    const stored = await reportStore.get('r1', 'md');
    expect(stored?.tenantId).toBe('t1');
    expect(stored?.userId).toBe('u1');
  });

  it('TTL 過期後被回收', async () => {
    save('r1', 'md', '# md');
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const purged = reportStore.purgeExpired(later);
    expect(purged).toBe(1);
    expect(await reportStore.get('r1', 'md')).toBeUndefined();
  });

  it('未過期者不被回收', async () => {
    save('r1', 'md', '# md');
    expect(reportStore.purgeExpired(new Date())).toBe(0);
    expect(await reportStore.get('r1', 'md')).toBeDefined();
  });
});
