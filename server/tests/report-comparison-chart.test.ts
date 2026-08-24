/**
 * 跨表對比圖：把不同檔案的同一個指標畫進同一張圖。
 *
 * 實跑「自行車展與工具機展的前三年參展商家數」時，對比分析那一節的散文在講對比，
 * 圖卻是兩張各自獨立的折線並排——因為 chart-ref 只吃單一 table id，一張圖的數字
 * 永遠只能來自一張表。兩個展分屬兩個檔案，於是「對比」這件事沒有任何一張圖表達得出來。
 *
 * 數值仍由程式各自從完整資料列讀出，模型只負責挑表、挑欄位、命名數列——
 * 這條路徑存在的理由（不讓模型轉述數字）不因為多了一張表而改變。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { buildExactChart, extractChartRefs } from '@/modules/report/report.compose';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { ReportDoc, SectionChart } from '@/modules/report/report.types';

const CC = {
  id: 'cc', source: 'CC匯出.xlsx', sheet: '6-CC-參展商家數',
  caption: '展覽名稱:台北國際自行車展覽會',
  headers: ['年度', '參展總家數'], rowCount: 6,
  rows: [
    ['2019', '1,139'], ['2021', '387'], ['2022', '733'],
    ['2023', '890'], ['2024', '985'], ['2025', '954'],
  ],
};

/** 工具機展是雙年展——2024 這一年在它的表上根本不存在 */
const TM = {
  id: 'tm', source: 'TM 匯出.xlsx', sheet: '6-TM-參展商家數',
  caption: '展覽名稱:台北國際工具機展',
  headers: ['年度', '參展總家數'], rowCount: 5,
  rows: [
    ['2019', '1,227'], ['2021', '979'], ['2022', '934'],
    ['2023', '1,034'], ['2025', '975'], ['總數', '5,149'],
  ],
};

const byId = (_t: string, id: string) =>
  Promise.resolve([CC, TM].find((x) => x.id === id) ?? null);

const ref = (over: Record<string, unknown> = {}) => ({
  tables: [{ id: 'cc', series: '自行車展' }, { id: 'tm', series: '工具機展' }],
  label: '年度', value: '參展總家數', kind: 'bar', title: '兩展參展總家數對比', unit: '家',
  ...over,
});

beforeEach(() => mockLoadTable.mockReset().mockImplementation(byId));

describe('chart-ref 的 tables 形式', () => {
  const block = (json: unknown): string => `內文。\n\n\`\`\`chart-ref\n${JSON.stringify(json)}\n\`\`\``;

  it('沒有 table、只有 tables 的 ref 必須被接受', () => {
    const out = extractChartRefs(block(ref()));
    expect(out.body).toBe('內文。');
    expect(out.refs[0]?.tables).toHaveLength(2);
    expect(out.refs[0]?.tables?.[1]).toEqual({ id: 'tm', series: '工具機展' });
  });

  it('只給一張表的 tables 沒有對比可言，退回單表路徑', () => {
    const out = extractChartRefs(block(ref({ tables: [{ id: 'cc', series: '自行車展' }] })));
    expect(out.refs[0]?.tables).toBeUndefined();
    expect(out.refs[0]?.table).toBe('cc');
  });

  it('數列缺名字或 id 的項目整個 ref 丟掉——圖例上不能有無名數列', () => {
    expect(extractChartRefs(block(ref({ tables: [{ id: 'cc' }, { id: 'tm', series: 'x' }] }))).refs).toHaveLength(0);
  });

  it('單表的 ref 不受影響', () => {
    const out = extractChartRefs(block({ table: 'cc', label: '年度', value: '參展總家數' }));
    expect(out.refs[0]?.table).toBe('cc');
    expect(out.refs[0]?.tables).toBeUndefined();
  });
});

describe('buildComparisonChart（經 buildExactChart 分派）', () => {
  it('各表的數值各自讀出，以年度對齊成同一張分組圖', async () => {
    const chart = await buildExactChart('t1', ref());
    expect(chart?.kind).toBe('grouped');
    expect(chart?.series).toEqual(['自行車展', '工具機展']);
    expect(chart?.complete).toBe(true);
    const at = (year: string) => chart?.points.find((p) => p.label === year)?.values;
    expect(at('2023')).toEqual([890, 1034]);
    expect(at('2025')).toEqual([954, 975]);
  });

  /*
   * 雙年展的空缺不得補 0：那會在圖上長出一根不存在的長條，而且正好長在
   * 「工具機展 2024 年掉到 0」這種最容易被誤讀成災難的位置。
   */
  it('只留每張表都有的年度，缺的年份整個略過而不是補 0', async () => {
    const chart = await buildExactChart('t1', ref());
    const labels = chart?.points.map((p) => p.label);
    expect(labels).not.toContain('2024');
    expect(labels).toEqual(['2019', '2021', '2022', '2023', '2025']);
  });

  it('合計列不算對齊的年度', async () => {
    const chart = await buildExactChart('t1', ref());
    expect(chart?.points.map((p) => p.label)).not.toContain('總數');
  });

  it('年度標籤依時間遞增排列——分組長條要讀得出走向', async () => {
    const chart = await buildExactChart('t1', ref());
    expect(chart?.points.map((p) => p.label)).toEqual(['2019', '2021', '2022', '2023', '2025']);
  });

  it('出處要列出每一個檔案，讀者才回得去核對', async () => {
    const chart = await buildExactChart('t1', ref());
    expect(chart?.sourceLabel).toContain('CC匯出.xlsx');
    expect(chart?.sourceLabel).toContain('TM 匯出.xlsx');
  });

  it('欄位名在任一張表對不上就整張不畫——寧可沒有圖也不要拿錯欄位的數字', async () => {
    expect(await buildExactChart('t1', ref({ value: '不存在' }))).toBeUndefined();
    expect(await buildExactChart('t1', ref({ label: '不存在' }))).toBeUndefined();
  });

  it('任一張表查無資料就不畫', async () => {
    expect(await buildExactChart('t1', ref({ tables: [{ id: 'cc', series: 'A' }, { id: 'nope', series: 'B' }] })))
      .toBeUndefined();
  });

  it('對齊後不足兩個標籤就不畫——一個點的對比沒有意義', async () => {
    mockLoadTable.mockImplementation((_t: string, id: string) =>
      Promise.resolve(id === 'cc' ? CC : { ...TM, rows: [['2023', '1,034']] }));
    expect(await buildExactChart('t1', ref())).toBeUndefined();
  });

  it('超過上限的數列只取前幾個，圖例才讀得完', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: i % 2 === 0 ? 'cc' : 'tm', series: `數列${i}` }));
    const chart = await buildExactChart('t1', ref({ tables: many }));
    expect(chart?.series?.length).toBeLessThanOrEqual(4);
  });
});

describe('對比圖的說明文字', () => {
  const doc = (chart: SectionChart): ReportDoc => ({
    title: 'r', topic: 't', locale: 'zh-Hant', generatedAt: '2026-08-24T00:00:00.000Z',
    sections: [{ heading: '對比', query: 'q', body: '內文。', sources: [], hits: 5, charts: [chart] }],
  });

  it('依年度截斷時說「最近的 N 筆」，不得說成「前 N 筆」', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [`${2005 + i}`, String(100 + i)]);
    mockLoadTable.mockImplementation((_t: string, id: string) =>
      Promise.resolve({ ...(id === 'cc' ? CC : TM), rows: rows(20) }));
    const chart = await buildExactChart('t1', ref());
    const md = renderMarkdown(doc(chart as SectionChart));
    expect(md).toContain('最近的');
    expect(md).not.toContain('中的前');
  });

  it('markdown 每個數列各開一欄', async () => {
    const chart = await buildExactChart('t1', ref());
    const md = renderMarkdown(doc(chart as SectionChart));
    expect(md).toContain('| 自行車展 | 工具機展 |');
    expect(md).toContain('| 2023 | 890 | 1,034 |');
  });
});
