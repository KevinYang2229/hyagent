/**
 * 選表的展覽歸屬：問哪個展，就不該讓別的展的表排在前面。
 *
 * 實跑「工具機展前三年參展商家數」時，融合排序把 1-CC-參觀者統計（自行車展、3 列）
 * 排在第一名，工具機展自己的 6-TM-參展商家數 只排第二。這批資料四個展覽的工作表
 * 名稱與欄位幾乎一模一樣，語意與字面都分不出來——但橫幅上的「展覽名稱:」是硬訊號，
 * 問句又通常直接點名展覽，不用它等於白白丟掉唯一能區分的欄位。
 *
 * 一律只降級、不剔除：辨識不到展覽時整個機制退成 no-op，寧可維持現狀也不要誤殺。
 */
import { exhibitionOf, preferMentionedExhibitions } from '@/modules/report/report.compose';
import type { TableCatalogEntry } from '@/modules/knowledge/knowledge.tables.repo';

const CC = '台北國際自行車展覽會';
const TM = '台北國際工具機展';
const CP = 'COMPUTEX TAIPEI';
const GF = '台灣國際創意禮品文具展 DG Taiwan';

const t = (sheet: string, name?: string, year?: number): TableCatalogEntry => ({
  id: `${sheet}-${name ?? 'x'}-${year ?? 0}`,
  source: 'x.xlsx',
  sheet,
  ...(name ? { caption: `展覽名稱:${name}${year ? ` 展覽年度:${year}` : ''}` } : {}),
  headers: ['年度', '家數'],
  rowCount: 10,
});

const sheets = (list: TableCatalogEntry[]): string[] => list.map((e) => e.sheet);

describe('exhibitionOf', () => {
  it('從橫幅取出展覽名稱，年度不算在內', () => {
    expect(exhibitionOf(t('6-TM-參展商家數', TM, 2025))).toBe(TM);
    expect(exhibitionOf(t('6-TM-參展商家數', TM))).toBe(TM);
  });

  it('沒有橫幅或橫幅沒有展覽名稱時回 undefined——這種表視為中立，不受降級影響', () => {
    expect(exhibitionOf(t('6-TM-參展商家數'))).toBeUndefined();
    expect(exhibitionOf({ ...t('x'), caption: '展覽年度:2025' })).toBeUndefined();
  });
});

describe('preferMentionedExhibitions', () => {
  it('問工具機展時，自行車展的表要退到後面', () => {
    const out = preferMentionedExhibitions(
      [t('1-CC-參觀者統計', CC, 2025), t('6-TM-參展商家數', TM), t('1-TM-參觀者統計', TM, 2025)],
      '工具機展前三年參展商家數趨勢台北國際工具機展最近三年的參展商家數為何？',
    );
    expect(sheets(out)).toEqual(['6-TM-參展商家數', '1-TM-參觀者統計', '1-CC-參觀者統計']);
  });

  it('點名兩個展時兩邊都留在前面，其餘的才退後', () => {
    const out = preferMentionedExhibitions(
      [t('8-CP-參展商展區', CP, 2024), t('6-CC-參展商家數', CC), t('6-TM-參展商家數', TM)],
      '自行車展與工具機展的前三年參展商家數對比',
    );
    expect(sheets(out)).toEqual(['6-CC-參展商家數', '6-TM-參展商家數', '8-CP-參展商展區']);
  });

  it('同一展覽內部的原有名次不變——這裡只調整展覽歸屬，不重新評分', () => {
    const out = preferMentionedExhibitions(
      [t('1-CC-參觀者統計', CC), t('5-TM-參展商統計', TM), t('6-TM-參展商家數', TM)],
      '台北國際工具機展的參展商',
    );
    expect(sheets(out)).toEqual(['5-TM-參展商統計', '6-TM-參展商家數', '1-CC-參觀者統計']);
  });

  it('沒有橫幅的表視為中立，留在前段', () => {
    const out = preferMentionedExhibitions(
      [t('1-CC-參觀者統計', CC), t('0-說明'), t('6-TM-參展商家數', TM)],
      '工具機展參展商家數',
    );
    expect(sheets(out)).toEqual(['0-說明', '6-TM-參展商家數', '1-CC-參觀者統計']);
  });

  it('問句沒點名任何展覽時原樣回傳——辨識不到就退成 no-op，不亂動排序', () => {
    const list = [t('1-CC-參觀者統計', CC), t('6-TM-參展商家數', TM)];
    expect(sheets(preferMentionedExhibitions(list, '歷年參展商家數的整體趨勢'))).toEqual(sheets(list));
  });

  it('全部展覽都被點名時原樣回傳', () => {
    const list = [t('a', CC), t('b', TM)];
    expect(sheets(preferMentionedExhibitions(list, '自行車展與工具機展'))).toEqual(['a', 'b']);
  });

  /*
   * 「自行」兩個字也出現在「自行預登」這個欄位名上。辨識展覽若放寬到兩字，
   * 一句「自行預登人數」就會被當成問自行車展，把其他三個展的表全部降級。
   */
  it('欄位名裡的巧合字不得當成點名展覽', () => {
    const list = [t('2-CP-參觀者預登人數', CP), t('2-CC-參觀者預登人數', CC)];
    expect(sheets(preferMentionedExhibitions(list, '各展的自行預登與現場報名人數比較'))).toEqual(sheets(list));
  });

  it('英文展名以完整字詞比對，大小寫不拘', () => {
    const out = preferMentionedExhibitions(
      [t('6-CC-參展商家數', CC), t('6-CP-參展商家數', CP)],
      'computex 的參展商家數',
    );
    expect(sheets(out)).toEqual(['6-CP-參展商家數', '6-CC-參展商家數']);
  });

  it('簡稱也認得——問句多半寫「禮品文具展」而不是完整展名', () => {
    const out = preferMentionedExhibitions(
      [t('6-CC-參展商家數', CC), t('6-GF-參展商家數', GF)],
      '禮品文具展的參展商家數',
    );
    expect(sheets(out)).toEqual(['6-GF-參展商家數', '6-CC-參展商家數']);
  });
});
