import type { StoreTodaySummary } from '@/api/storeTypes';
import { SCENARIOS } from './scenarios';
import { formatMonthDay, greeting, summaryCards } from './summaryCards';

const S: StoreTodaySummary = {
  lowStock: { count: 3, names: ['鮭魚御飯糰', '明太子御飯糰', '三明治－火腿蛋', '沙拉－凱薩'] },
  expiring: { count: 2, names: ['沙拉－和風雞肉', '便當－雞腿飯'] },
  equipmentAlerts: { count: 1, items: [{ name: '咖啡機', issue: '紅燈閃爍' }] },
  replenishmentsToday: { count: 4 },
};

describe('summaryCards', () => {
  it('四張卡片：數量、說明、點擊動作', () => {
    const c = summaryCards(S);
    expect(c.map((x) => [x.key, x.count])).toEqual([['lowStock', 3], ['expiring', 2], ['equipment', 1], ['replenishments', 4]]);
    expect(c[0]).toMatchObject({ title: '商品庫存偏低', detail: '鮭魚御飯糰・明太子御飯糰・三明治－火腿蛋', action: { kind: 'ask', q: '哪些商品庫存偏低？' } });
    expect(c[1]).toMatchObject({ title: '即期品需要處理', detail: '有效期限 1 天內', action: { kind: 'ask', q: '今天有哪些即期品？' } });
    expect(c[2]).toMatchObject({ title: '設備異常', detail: '咖啡機紅燈閃爍', action: { kind: 'ask', q: '咖啡機紅燈閃爍怎麼處理？' } });
    expect(c[3]).toMatchObject({ title: '今日補貨單', action: { kind: 'tasks' } });
  });

  it('都沒有狀況時的說明文字', () => {
    const c = summaryCards({
      lowStock: { count: 0, names: [] },
      expiring: { count: 0, names: [] },
      equipmentAlerts: { count: 0, items: [] },
      replenishmentsToday: { count: 0 },
    });
    expect(c[0].detail).toBe('庫存都充足');
    expect(c[1].detail).toBe('目前沒有即期品');
    expect(c[2]).toMatchObject({ detail: '設備運作正常', action: { kind: 'ask', q: '設備故障怎麼排除？' } });
  });
});

describe('greeting / formatMonthDay / SCENARIOS', () => {
  it('依時段問候', () => {
    expect(greeting(6)).toBe('早安');
    expect(greeting(10)).toBe('早安');
    expect(greeting(11)).toBe('午安');
    expect(greeting(17)).toBe('午安');
    expect(greeting(18)).toBe('晚安');
  });

  it('月/日（星期）', () => {
    expect(formatMonthDay(new Date(2026, 9, 4))).toBe('10/4（日）');
  });

  it('七個常用情境與帶入的問題', () => {
    expect(SCENARIOS.map((s) => [s.label, s.q])).toEqual([
      ['查詢庫存', '幫我查庫存'],
      ['建立補貨單', '幫我把庫存偏低的商品建立補貨單'],
      ['即期品管理', '今天有哪些即期品？'],
      ['設備故障排除', '設備故障怎麼排除？'],
      ['促銷活動查詢', '現在有什麼活動？'],
      ['會員活動', '現在有什麼會員活動？'],
      ['門市報表', '幫我查詢今日門市營運報表'],
    ]);
  });
});
