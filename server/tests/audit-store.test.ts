/** 稽核 store：record/list（新→舊）/ 每租戶上限捨舊 / 租戶隔離。 */
import { auditStore, type AuditEntry } from '@/modules/audit/audit.store';

function entry(partial: Partial<AuditEntry> = {}): AuditEntry {
  return { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: true, summary: 's', ...partial };
}

describe('auditStore', () => {
  afterEach(() => auditStore.clear());

  it('record 後 list 回該租戶紀錄（新→舊）', () => {
    auditStore.record('t1', entry({ summary: 'a' }));
    auditStore.record('t1', entry({ summary: 'b' }));
    const list = auditStore.list('t1');
    expect(list.map((e) => e.summary)).toEqual(['b', 'a']); // 新在前
  });

  it('租戶隔離', () => {
    auditStore.record('t1', entry());
    expect(auditStore.list('t2')).toHaveLength(0);
  });

  it('超過每租戶上限（500）捨最舊', () => {
    for (let i = 0; i < 520; i++) auditStore.record('t3', entry({ summary: `#${i}` }));
    const list = auditStore.list('t3', 1000);
    expect(list).toHaveLength(500);
    expect(list[0].summary).toBe('#519'); // 最新
    expect(list.some((e) => e.summary === '#0')).toBe(false); // 最舊已捨
  });
});
