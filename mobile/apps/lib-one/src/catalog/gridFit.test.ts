import { GRID_SIDE_PADDING, fitGrid, tabletCard, tabletCellWidth } from './gridFit';

const LANDSCAPE = { width: 1150, height: 700, wide: true, landscape: true };
const PORTRAIT = { width: 790, height: 950, wide: true, landscape: false };

it('平板橫放最多三張、直放最多兩張', () => {
  expect(fitGrid({ ...LANDSCAPE, count: 5 }).columns).toBe(3);
  expect(fitGrid({ ...PORTRAIT, count: 5 }).columns).toBe(2);
  expect(fitGrid({ ...PORTRAIT, count: 12 }).columns).toBe(2);
});

it('平板卡寬：橫放三張填滿寬度，轉成直放仍是同一寬度、兩張放得下', () => {
  for (const [w, h] of [[1180, 820], [1366, 1024], [1194, 834], [1133, 744]]) {
    const land = tabletCellWidth(w, h);
    expect(tabletCellWidth(h, w)).toBe(land);
    expect(land * 2).toBeLessThanOrEqual(h - GRID_SIDE_PADDING);
    if (w !== 1133) expect(w - GRID_SIDE_PADDING - land * 3).toBeLessThan(3);
  }
  const card = tabletCard({ sizingCount: 5, screenW: 1180, screenH: 820, chromeH: 230 });
  expect(tabletCard({ sizingCount: 5, screenW: 820, screenH: 1180, chromeH: 230 })).toEqual(card);
  expect(fitGrid({ ...LANDSCAPE, count: 3, card })).toMatchObject(card);
  expect(fitGrid({ ...PORTRAIT, count: 3, card })).toMatchObject(card);
});

it('卡片依最大分類（5 項）定尺寸：直放橫放都一屏放完；全部 12 項需要捲動', () => {
  const card = tabletCard({ sizingCount: 5, screenW: 1180, screenH: 820, chromeH: 230 });
  expect(fitGrid({ count: 5, width: 1150, height: 820 - 230, wide: true, landscape: true, card }).fits).toBe(true);
  expect(fitGrid({ count: 5, width: 790, height: 1180 - 230, wide: true, landscape: false, card }).fits).toBe(true);
  expect(fitGrid({ count: 12, width: 1150, height: 820 - 230, wide: true, landscape: true, card }).fits).toBe(false);
});

it('手機分類（3 項）放得下；全部 12 項放不下就退回可捲動', () => {
  expect(fitGrid({ count: 3, width: 390, height: 600, wide: false }).fits).toBe(true);
  expect(fitGrid({ count: 12, width: 390, height: 600, wide: false })).toMatchObject({ fits: false, columns: 2 });
});
