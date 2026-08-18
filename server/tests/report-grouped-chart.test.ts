/**
 * 分組長條與圓餅下限。
 *
 * 這批資料裡資訊密度最高的表是「一列多欄」的形狀（類型｜今年預登｜今年報到｜上屆預登｜
 * 上屆報到），兩欄的 label/value 只抓得到其中一欄，等於把四個數字丟掉三個。
 * 而台灣／海外這種兩分佔比本來就是圓餅的典型用法，卻被長條的 3 點門檻擋掉。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { buildExactChart } from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { ReportDoc, SectionChart } from '@/modules/report/report.types';

const STATS = {
  id: 't', source: 'CC匯出.xlsx', sheet: '1-CC-參觀者統計',
  caption: '展覽名稱:台北國際自行車展覽會 展覽年度:2025',
  headers: ['類型', '今年預登人數', '今年報到人數', '上屆預登人數', '上屆報到人數'],
  rowCount: 3,
  rows: [
    ['Taiwan', '128', '96', '5,801', '4,912'],
    ['Overseas', '232', '180', '12,896', '9,331'],
    ['總數', '360', '276', '18,697', '14,243'],
  ],
};

beforeEach(() => mockLoadTable.mockReset().mockResolvedValue(STATS));

describe('分組長條', () => {
  it('多個數值欄一起讀出，series 記錄欄名', async () => {
    const chart = await buildExactChart('t1', {
      table: 't', label: '類型', value: '',
      values: ['今年預登人數', '今年報到人數', '上屆預登人數'],
    });
    expect(chart?.kind).toBe('grouped');
    expect(chart?.series).toEqual(['今年預登人數', '今年報到人數', '上屆預登人數']);
    expect(chart?.points).toHaveLength(2); // 總數列被排除
    expect(chart?.points[0].values).toEqual([128, 96, 5801]);
  });

  it('超過 4 個數列只取前 4——再多長條會細到看不出差異', async () => {
    const chart = await buildExactChart('t1', {
      table: 't', label: '類型', value: '',
      values: ['今年預登人數', '今年報到人數', '上屆預登人數', '上屆報到人數', '今年預登人數'],
    });
    expect(chart?.series).toHaveLength(4);
  });

  it('任一數列缺值就整列略過——補 0 會生出不存在的長條', async () => {
    mockLoadTable.mockResolvedValue({
      ...STATS,
      rows: [['A', '1', '2'], ['B', '3', '待補'], ['C', '5', '6']],
      headers: ['類型', '甲', '乙'],
    });
    const chart = await buildExactChart('t1', { table: 't', label: '類型', value: '', values: ['甲', '乙'] });
    expect(chart?.points.map((p) => p.label)).toEqual(['A', 'C']);
  });

  it('欄位名對不上就不畫', async () => {
    expect(await buildExactChart('t1', { table: 't', label: '類型', value: '', values: ['甲', '乙'] }))
      .toBeUndefined();
  });

  it('只給一個 values 時退回單數列路徑', async () => {
    const chart = await buildExactChart('t1', { table: 't', label: '類型', value: '今年預登人數', values: ['今年預登人數'] });
    expect(chart?.kind).not.toBe('grouped');
  });
});

const doc = (chart: SectionChart): ReportDoc => ({
  title: 'r', topic: 't', locale: 'zh-Hant', generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [{ heading: 'h', query: 'q', body: '內文。', sources: [], hits: 5, chart }],
});

describe('分組長條的呈現', () => {
  const grouped: SectionChart = {
    kind: 'grouped', complete: true, title: '預登與報到', unit: '人',
    series: ['今年預登', '今年報到'],
    points: [
      { label: 'Taiwan', value: 128, values: [128, 96] },
      { label: 'Overseas', value: 232, values: [232, 180] },
    ],
    sourceLabel: 'CC匯出.xlsx / 1-CC-參觀者統計', totalRows: 2,
  };

  it('HTML 畫出各數列的長條與圖例（顏色不是唯一線索）', () => {
    const html = renderHtml(doc(grouped));
    expect(html).toContain('今年預登');
    expect(html).toContain('今年報到');
    expect(html).toContain('Taiwan');
    expect(html).toContain('180');
  });

  it('Markdown 每個數列各一欄，不只呈現第一個', () => {
    const md = renderMarkdown(doc(grouped));
    expect(md).toContain('| 今年預登 | 今年報到 |');
    expect(md).toContain('| Taiwan | 128 | 96 |');
  });
});

describe('圓餅下限', () => {
  it('兩分佔比可以畫圓餅——那正是圓餅最典型的用法', async () => {
    mockLoadTable.mockResolvedValue({
      ...STATS, headers: ['類型', '人數'],
      rows: [['Taiwan', '128'], ['Overseas', '232'], ['總數', '360']],
    });
    const chart = await buildExactChart('t1', { table: 't', label: '類型', value: '人數', kind: 'pie' });
    expect(chart?.kind).toBe('pie');
    expect(chart?.points).toHaveLength(2);
  });

  it('長條仍要求 3 點——兩條長條沒有比一句話多說什麼', async () => {
    mockLoadTable.mockResolvedValue({
      ...STATS, headers: ['類型', '人數'],
      rows: [['A', '1'], ['B', '2'], ['總數', '3']],
    });
    expect(await buildExactChart('t1', { table: 't', label: '類型', value: '人數', kind: 'bar' }))
      .toBeUndefined();
  });
});
