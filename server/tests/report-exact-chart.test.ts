/**
 * 精確圖表：LLM 只挑「哪張表、哪兩欄」，數值一律由程式從完整資料列讀出。
 *
 * 這條路徑存在的理由，就是要同時避開 inline 圖表的兩個問題——LLM 轉述數字會失真，
 * 而檢索只取 top-k、畫出來的圖看起來卻像完整分布。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import {
  buildExactChart,
  extractChartRef,
  parseCellNumber,
  selectCatalog,
} from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { ReportDoc, ReportSection } from '@/modules/report/report.types';

const TABLE = {
  id: 'tbl-1',
  source: 'TM 匯出.xlsx',
  sheet: '4-TM-參觀者預登國家數',
  caption: '展覽名稱:台北國際工具機展 展覽年度:2025',
  headers: ['國家', '人數'],
  rowCount: 5,
  rows: [
    ['中華民國', '351'],
    ['日本', '30'],
    ['美國', '22'],
    ['德國', '11'],
    ['總數', '414'],
  ],
};

beforeEach(() => mockLoadTable.mockReset().mockResolvedValue(TABLE));

describe('parseCellNumber', () => {
  it('吃得下千分位與百分比', () => {
    expect(parseCellNumber('37,993')).toBe(37993);
    expect(parseCellNumber('74.7%')).toBe(74.7);
    expect(parseCellNumber('0')).toBe(0);
  });

  it('非數值回 null——該列要被略過，而不是當成 0', () => {
    // 當成 0 會在圖上憑空生出一條不存在的資料
    expect(parseCellNumber('不適用')).toBeNull();
    expect(parseCellNumber('')).toBeNull();
  });
});

describe('extractChartRef', () => {
  it('抽出挑選結果並移除區塊', () => {
    const out = extractChartRef('內文。\n\n```chart-ref\n{"table":"tbl-1","label":"國家","value":"人數"}\n```');
    expect(out.body).toBe('內文。');
    expect(out.ref).toEqual({ table: 'tbl-1', label: '國家', value: '人數' });
  });

  it('缺必要欄位或 JSON 壞掉只丟挑選、保留散文', () => {
    expect(extractChartRef('x\n```chart-ref\n{"table":"a"}\n```').ref).toBeUndefined();
    expect(extractChartRef('x\n```chart-ref\n{壞\n```').ref).toBeUndefined();
  });
});

describe('buildExactChart', () => {
  it('數值直接讀自資料列，並標記為完整、附上出處與總列數', async () => {
    const chart = await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '人數' });
    expect(chart?.complete).toBe(true);
    expect(chart?.points[0]).toEqual({ label: '中華民國', value: 351 });
    expect(chart?.sourceLabel).toContain('TM 匯出.xlsx');
    expect(chart?.sourceLabel).toContain('展覽年度:2025');
    expect(chart?.totalRows).toBe(4); // 總數列不算資料點
  });

  it('合計列被排除——它與組成項不同層級，畫在一起會重複計算並壓垮其他長條', async () => {
    const chart = await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '人數' });
    expect(chart?.points.map((p) => p.label)).not.toContain('總數');
  });

  it('依數值由大到小排序', async () => {
    const chart = await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '人數' });
    expect(chart?.points.map((p) => p.value)).toEqual([351, 30, 22, 11]);
  });

  it('欄位名對不上就不畫——寧可沒有圖，也不要拿錯欄位的數字', async () => {
    expect(await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '不存在' })).toBeUndefined();
    expect(await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '國家' })).toBeUndefined();
  });

  it('查無該表回 undefined，不拋錯', async () => {
    mockLoadTable.mockResolvedValue(null);
    expect(await buildExactChart('t1', { table: 'nope', label: '國家', value: '人數' })).toBeUndefined();
  });

  it('可用資料列不足 3 筆不成圖', async () => {
    mockLoadTable.mockResolvedValue({ ...TABLE, rows: [['a', '1'], ['b', '2'], ['c', '文字']] });
    expect(await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '人數' })).toBeUndefined();
  });

  it('超過 12 筆只取前 12，totalRows 仍記錄真實筆數', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`國家${i}`, String(i)]);
    mockLoadTable.mockResolvedValue({ ...TABLE, rows });
    const chart = await buildExactChart('t1', { table: 'tbl-1', label: '國家', value: '人數' });
    expect(chart?.points).toHaveLength(12);
    expect(chart?.totalRows).toBe(30);
  });
});

const doc = (chart: ReportSection['chart']): ReportDoc => ({
  title: '展覽數據報告', topic: '展覽數據', locale: 'zh-Hant',
  generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [{ heading: '預登', query: 'q', body: '內文。', sources: [], hits: 5, chart }],
});

describe('renderer：精確圖表的說明文字', () => {
  const exact: ReportSection['chart'] = {
    complete: true, title: '各國預登人數', unit: '人',
    points: [{ label: '中華民國', value: 351 }, { label: '日本', value: 30 }, { label: '美國', value: 22 }],
    sourceLabel: 'TM 匯出.xlsx / 4-TM-參觀者預登國家數', totalRows: 3,
  };

  it('完整資料的說明講「直接讀自原始資料」，不得出現「節錄」', () => {
    const md = renderMarkdown(doc(exact));
    expect(md).toContain('全部 3 列');
    expect(md).toContain('直接讀自原始資料');
    expect(md).not.toContain('節錄');
  });

  it('只取前幾名時要標明「共 N 列中的前 M 筆」', () => {
    const md = renderMarkdown(doc({ ...exact, totalRows: 87 }));
    expect(md).toContain('共 87 列中的前 3 筆');
  });

  it('HTML 同樣區分兩種可信度', () => {
    expect(renderHtml(doc(exact))).toContain('直接讀自原始資料');
    expect(renderHtml(doc({ ...exact, complete: false, sourceLabel: undefined, totalRows: undefined })))
      .toContain('節錄');
  });
});

describe('selectCatalog', () => {
  const entry = (sheet: string, caption: string) => ({
    id: sheet + caption, source: 'x.xlsx', sheet, caption, headers: ['國家', '人數'], rowCount: 10,
  });
  const many = [
    entry('4-TM-參觀者預登國家數', '展覽名稱:台北國際工具機展 展覽年度:2025'),
    entry('9-TM-媒體統計', '展覽名稱:台北國際工具機展 展覽年度:2025'),
    entry('1-CC-參觀者統計', '展覽名稱:台北國際自行車展覽會 展覽年度:2012'),
    ...Array.from({ length: 40 }, (_, i) => entry(`雜訊表${i}`, `無關橫幅${i}`)),
  ];

  it('表數少於上限時原樣回傳', () => {
    expect(selectCatalog(many.slice(0, 3), '任意', 20)).toHaveLength(3);
  });

  it('依查詢句把相關的表排到前面，並收斂到上限', () => {
    // 目錄是每一節都要送一次的，165 張表約 10k token；不篩會讓模型在雜訊裡找針
    const out = selectCatalog(many, '台北國際工具機展 2025 各國預登人數', 5);
    expect(out).toHaveLength(5);
    expect(out[0].sheet).toBe('4-TM-參觀者預登國家數');
  });
});
