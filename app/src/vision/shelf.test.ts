import type { ShelfFinding, ShelfResult } from '@/api/types';
import { boxRect, daysLeft, findingDetail, fitContain, groupFindings, issueCount, replenishmentCount, boxTagText } from './shelf';

const f = (status: ShelfFinding['status'], extra: Partial<ShelfFinding> = {}): ShelfFinding => ({ name: 'x', status, box: { x: 0, y: 0, w: 0.1, h: 0.1 }, ...extra });

describe('shelf', () => {
  it('依狀態分組（不含 ok），計算需處理數', () => {
    const list = [f('out_of_stock'), f('expiring'), f('ok'), f('misplaced'), f('out_of_stock')];
    const g = groupFindings(list);
    expect([g.out_of_stock.length, g.expiring.length, g.misplaced.length]).toEqual([2, 1, 1]);
    expect(issueCount(list)).toBe(4);
  });

  it('剩幾天', () => {
    expect(daysLeft('2026-10-05', '2026-10-04')).toBe(1);
    expect(daysLeft('2026-10-04', '2026-10-04')).toBe(0);
  });

  it('各狀態的說明文字', () => {
    expect(findingDetail(f('out_of_stock', { suggestedQty: 24 }), '2026-10-04')).toBe('建議補貨 24 個');
    expect(findingDetail(f('out_of_stock'), '2026-10-04')).toBe('建議補貨');
    expect(findingDetail(f('expiring', { expiryDate: '2026-10-05' }), '2026-10-04')).toBe('有效期限：2026/10/05（剩 1 天）');
    expect(findingDetail(f('misplaced'), '2026-10-04')).toBe('擺放位置不正確');
    expect(findingDetail(f('misplaced', { note: '放到飲料區' }), '2026-10-04')).toBe('放到飲料區');
  });

  it('圖片等比縮放置中，框選換算成畫面座標', () => {
    const frame = fitContain(4000, 3000, 800, 800)!;
    expect(frame).toEqual({ left: 0, top: 100, width: 800, height: 600 });
    expect(boxRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, frame)).toEqual({ left: 400, top: 400, width: 200, height: 300 });
  });

  it('補貨提議的品項數', () => {
    const r: ShelfResult = { mode: 'shelf', findings: [], counts: { outOfStock: 0, expiring: 0, misplaced: 0 } };
    expect(replenishmentCount(r)).toBe(0);
    expect(replenishmentCount({ ...r, replenishment: { toolId: 't', input: { items: [{}, {}, {}] } } })).toBe(3);
  });

  it('框選標籤：即期品附期限', () => {
    expect(boxTagText(f('expiring', { expiryDate: '2026-10-05' }))).toBe('即期品 10/05');
    expect(boxTagText(f('expiring'))).toBe('即期品');
    expect(boxTagText(f('out_of_stock'))).toBe('缺貨');
  });

  it('圖片或容器尺寸為 0 → fitContain 回傳 null', () => {
    expect(fitContain(0, 0, 800, 800)).toBeNull();
    expect(fitContain(4000, 3000, 0, 800)).toBeNull();
  });
});
