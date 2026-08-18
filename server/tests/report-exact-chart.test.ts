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
  firstNumericColumn,
  fuseRankings,
  parseCellNumber,
  selectCatalog,
  tablePreview,
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
    kind: 'bar' as const, complete: true, title: '各國預登人數', unit: '人',
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

  /*
   * 折線的節錄方式跟長條相反：長條依數值遞減取前 N 筆，折線依年份遞增取**最後** N 筆。
   * 兩者都寫成「前 N 筆」的話，一張 2014–2025 的折線會被說成「16 列中的前 12 筆」——
   * 圖上的數字沒錯，但描述它的那句話是錯的。
   */
  it('折線取的是最近的 N 筆，說明不得寫成「前 N 筆」', () => {
    const line = { ...exact, kind: 'line' as const, totalRows: 16 };
    const md = renderMarkdown(doc(line));
    expect(md).toContain('共 16 列中最近的 3 筆');
    expect(md).not.toContain('前 3 筆');
    expect(renderHtml(doc(line))).toContain('共 16 列中最近的 3 筆');
  });

  it('英文語系同樣區分 top 與 most recent', () => {
    const en = (chart: ReportSection['chart']) => renderMarkdown({ ...doc(chart), locale: 'en' });
    expect(en({ ...exact, totalRows: 87 })).toContain('Top 3 of 87 rows');
    expect(en({ ...exact, kind: 'line' as const, totalRows: 87 })).toContain('Most recent 3 of 87 rows');
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

/**
 * 散文與圖表的數字一致性。
 *
 * 實跑時模型寫出「2022 年 8,598 為歷年最高」，而同一節的圖表（由程式從完整表算出）
 * 顯示 2023 年是 18,697——它只是沒在 top-5 檢索片段裡看到那一列。同一節內散文與圖
 * 互相矛盾，比兩者都錯更傷可信度，所以把真實資料列一併餵給撰文的模型。
 */
describe('tablePreview', () => {
  const table = {
    id: 't', source: 'CC匯出.xlsx', sheet: '2-CC-參觀者預登人數',
    caption: '展覽名稱:台北國際自行車展覽會', headers: ['年度', '預登總數'], rowCount: 4,
    rows: [['2022', '8,598'], ['2023', '18,697'], ['2019', '6,159'], ['2018', '7,926']],
  };

  it('依數值欄由大到小排序——散文引用的多半是極值', () => {
    const out = tablePreview(table);
    const lines = out.split('\n');
    expect(lines[lines.length - 4]).toContain('18,697'); // 最大值排在資料列首位
    expect(out.indexOf('18,697')).toBeLessThan(out.indexOf('8,598'));
  });

  it('全部列出時明講，避免模型把節錄當成全部', () => {
    expect(tablePreview(table)).toContain('已全部列出');
  });

  it('只取前幾列時標明總列數與排序依據', () => {
    const many = { ...table, rows: Array.from({ length: 40 }, (_, i) => [`${2000 + i}`, String(i)]) };
    const out = tablePreview(many);
    expect(out).toContain('共 40 列');
    expect(out).toContain('預登總數');
  });

  it('沒有數值欄時退回原始順序，不排序也不出錯', () => {
    const text = { ...table, headers: ['項目', '說明'], rows: [['a', '甲'], ['b', '乙'], ['c', '丙']] };
    expect(firstNumericColumn(text)).toBe(-1);
    expect(() => tablePreview(text)).not.toThrow();
  });
});

/**
 * 候選清單的多樣性。這批資料每個工作表都有逐年複本（8-CC-參展商展區 有 16 份），
 * 名稱與欄位完全相同、只有橫幅的年度不同——bigram 分不出它們，於是 20 個名額被同一張表
 * 佔掉十幾個，結構不同的表（畫佔比需要的兩列統計表）根本擠不進清單，模型不可能選它。
 */
describe('selectCatalog 的多樣性收斂', () => {
  const dup = (sheet: string, year: number) => ({
    id: `${sheet}-${year}`, source: 'x.xlsx', sheet,
    caption: `展覽年度:${year}`, headers: ['展區', '家數'], rowCount: 25,
  });
  const catalog = [
    ...Array.from({ length: 16 }, (_, i) => dup('8-CC-參展商展區', 2010 + i)),
    { id: 'stats', source: 'x.xlsx', sheet: '5-CC-參展商統計', caption: '展覽年度:2025',
      headers: ['類型', '今年家數'], rowCount: 3 },
    { id: 'counts', source: 'x.xlsx', sheet: '6-CC-參展商家數', caption: '',
      headers: ['年度', '參展總家數'], rowCount: 17 },
  ];

  it('同一工作表名不佔滿名額，結構不同的表擠得進來', () => {
    const out = selectCatalog(catalog, '參展商的國內外組成比例', 6);
    const sheets = out.map((t) => t.sheet);
    expect(sheets.filter((s) => s === '8-CC-參展商展區').length).toBeLessThanOrEqual(2);
    expect(sheets).toContain('5-CC-參展商統計'); // 少了這張就永遠畫不出佔比圖
    expect(sheets).toContain('6-CC-參展商家數');
  });

  it('不足名額寧可回傳短清單，也不用複本填滿——那正是原本的問題', () => {
    const out = selectCatalog(catalog, '展區', 12);
    expect(out.length).toBeLessThan(12);
    expect(out.filter((t) => t.sheet === '8-CC-參展商展區')).toHaveLength(2);
  });
});

/**
 * 選表的排名融合。語意與字面互有勝負，且失誤方式互補：
 *   語意把「國際參展商來源地區分布」對到參觀者的表——被「來源地區分布」帶走，丟了類別詞；
 *   字面把「歷年參展商數量成長趨勢」對到參展商統計——抓得住類別詞，不知道趨勢要逐年那張。
 */
describe('fuseRankings', () => {
  const e = (id: string, sheet: string) => ({
    id, source: 'x.xlsx', sheet, caption: '', headers: ['a', 'b'], rowCount: 5,
  });

  it('兩邊都靠前的排最前面', () => {
    const sem = [e('1', 'A'), e('2', 'B'), e('3', 'C')];
    const lex = [e('3', 'C'), e('1', 'A'), e('2', 'B')];
    expect(fuseRankings(sem, lex)[0].sheet).toBe('A'); // 1+2 名優於 3+1 名
  });

  it('同工作表的逐年複本只投一票——不收斂的話等於替同一答案灌票', () => {
    // 實測直接融合（未收斂）比單用任一訊號更差，就是被這個放大的：
    // 語意清單裡「重複表」佔滿前十名，正解被擠到第十一，未收斂時它必輸。
    const sem = [
      ...Array.from({ length: 10 }, (_, i) => e(`d${i}`, '重複表')),
      e('right', '正解表'),
    ];
    const lex = [e('right', '正解表'), e('other', '其他表'), e('d0', '重複表')];
    expect(fuseRankings(sem, lex)[0].sheet).toBe('正解表');
  });

  it('只出現在單邊的項目仍會進入結果，只是排在後面', () => {
    const out = fuseRankings([e('1', 'A')], [e('2', 'B')]);
    expect(out.map((t) => t.sheet).sort()).toEqual(['A', 'B']);
  });
});
