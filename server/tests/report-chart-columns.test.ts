/**
 * 自動補圖的選欄：哪一欄是維度（標籤）、哪一欄是量值（長度）。
 *
 * 實跑時發現的缺陷：「年度 | 預登人數」兩欄都解析得出數字，原本的規則
 * 「第一個數值欄當量值、第一個非量值欄當標籤」會把年度選成量值——
 * 十二根長條的長度分別是 2014…2025，差距不到 0.5%，整張圖看起來全是滿格。
 *
 * 年份是時間軸的刻度，不是可以比長短的量。這個區分必須寫在程式裡：
 * 自動補圖是沒有模型參與的路徑，只看得到欄位型別。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { buildExactChart, pickChartColumns } from '@/modules/report/report.compose';
import type { StoredTable } from '@/modules/knowledge/knowledge.tables.repo';

const table = (headers: string[], rows: string[][]): StoredTable =>
  ({ id: 't', source: 'CC匯出.xlsx', sheet: 's', caption: '', headers, rowCount: rows.length, rows }) as StoredTable;

const YEAR_ROWS = [
  ['2014', '6045'], ['2015', '5651'], ['2016', '6174'], ['2017', '6926'],
  ['2018', '7926'], ['2019', '6159'], ['2020', '0'], ['2021', '3592'],
  ['2022', '8598'], ['2023', '18697'], ['2024', '18420'], ['2025', '360'],
];

describe('pickChartColumns', () => {
  it('年度不得被選成量值——長度畫年份等於整排長條都填滿', () => {
    const t = table(['年度', '預登人數'], YEAR_ROWS);
    expect(pickChartColumns(t)).toEqual({ li: 0, vi: 1 });
  });

  it('有非數值欄時它就是標籤', () => {
    const t = table(['類型', '人數'], [['台灣', '128'], ['海外', '232'], ['其他', '11']]);
    expect(pickChartColumns(t)).toEqual({ li: 0, vi: 1 });
  });

  it('年度夾在中間也一樣跳過，量值取真正的量', () => {
    const t = table(['類型', '年度', '人數'], [['台灣', '2024', '128'], ['海外', '2024', '232'], ['其他', '2024', '11']]);
    expect(pickChartColumns(t)).toEqual({ li: 0, vi: 2 });
  });

  it('唯一的數值欄是年份時不畫——沒有量值可比，畫出來的一定是假的', () => {
    const t = table(['展區', '年度'], [['A', '2023'], ['B', '2024'], ['C', '2025']]);
    expect(pickChartColumns(t)).toBeUndefined();
  });

  it('整張表都是文字時不畫', () => {
    const t = table(['展區', '備註'], [['A', '無'], ['B', '無'], ['C', '無']]);
    expect(pickChartColumns(t)).toBeUndefined();
  });

  it('只有一欄時不畫——沒有第二欄可以當另一個角色', () => {
    expect(pickChartColumns(table(['人數'], [['1'], ['2'], ['3']]))).toBeUndefined();
  });
});

describe('端到端：年度表畫出的是趨勢折線', () => {
  beforeEach(() => mockLoadTable.mockReset());

  it('年度當 x 軸、人數當高度，且依年份遞增', async () => {
    const t = table(['年度', '預登人數'], YEAR_ROWS);
    mockLoadTable.mockResolvedValue(t);
    const cols = pickChartColumns(t)!;
    const chart = await buildExactChart('t1', {
      table: 't', label: t.headers[cols.li], value: t.headers[cols.vi],
    });
    expect(chart?.kind).toBe('line');
    expect(chart?.points[0]).toEqual({ label: '2014', value: 6045 });
    expect(chart?.points.at(-1)).toEqual({ label: '2025', value: 360 });
    // 數值一律讀自原始儲存格，不做任何推估或補值
    expect(chart?.complete).toBe(true);
    expect(chart?.points.find((p) => p.label === '2020')?.value).toBe(0);
  });
});
