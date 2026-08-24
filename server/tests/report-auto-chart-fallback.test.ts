/**
 * 自動補圖的候選要往下試，不能只賭第一張。
 *
 * 實跑「自行車展與工具機展的前三年參展商家數」時，工具機展那一節整節沒有圖。
 * 追下去是：融合排序把 1-CC-參觀者統計（3 列，扣掉合計只剩 2 個資料點）排在第一，
 * 而 autoChart 的預設路徑只試 pool[0]——它畫不出來就整節放棄，
 * 排在第二的 6-TM-參展商家數（10 列、年度/參展總家數）明明畫得出九點折線。
 *
 * 佔比路徑早就會往下試 AUTO_CHART_TRIES 張；預設路徑沒有，才是這個症狀的成因。
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { autoChart } from '@/modules/report/report.compose';

/** 3 列、扣掉合計只剩 2 點——低於長條的下限，buildExactChart 會回 undefined */
const tooFew = {
  id: 'stats', source: 'CC匯出.xlsx', sheet: '1-CC-參觀者統計',
  caption: '展覽名稱:台北國際自行車展覽會 展覽年度:2025',
  headers: ['類型', '今年預登人數'], rowCount: 3,
  rows: [['Taiwan', '128'], ['Overseas', '232'], ['總數', '360']],
};

/** 逐年的參展商家數——這才是該節要的那張 */
const yearly = {
  id: 'tm-counts', source: 'TM 匯出.xlsx', sheet: '6-TM-參展商家數',
  caption: '展覽名稱:台北國際工具機展',
  headers: ['年度', '參展總家數'], rowCount: 9,
  rows: [
    ['2011', '931'], ['2013', '1,014'], ['2015', '1,018'], ['2017', '1,105'],
    ['2019', '1,227'], ['2021', '979'], ['2022', '934'], ['2023', '1,034'], ['2025', '975'],
  ],
};

/** 完全畫不出來的表：沒有任何數值欄 */
const textOnly = {
  id: 'text', source: 'x.xlsx', sheet: '0-備註', caption: '',
  headers: ['項目', '說明'], rowCount: 3,
  rows: [['a', '甲'], ['b', '乙'], ['c', '丙']],
};

const entry = (t: typeof tooFew) => ({
  id: t.id, source: t.source, sheet: t.sheet, caption: t.caption,
  headers: t.headers, rowCount: t.rowCount,
});

const byId = (tables: { id: string }[]) => (_t: string, id: string) =>
  Promise.resolve(tables.find((x) => x.id === id) ?? null);

beforeEach(() => mockLoadTable.mockReset());

describe('autoChart 的預設路徑', () => {
  it('第一張畫不出來時往下試——整節沒圖比換一張表糟得多', async () => {
    mockLoadTable.mockImplementation(byId([tooFew, yearly]));
    const chart = await autoChart('t1', [entry(tooFew), entry(yearly)], '工具機展前三年參展商家數趨勢', new Set());
    expect(chart?.sourceLabel).toContain('6-TM-參展商家數');
    expect(chart?.points).toHaveLength(9);
  });

  it('選中的那張才記進 used，跳過的不佔名額', async () => {
    mockLoadTable.mockImplementation(byId([tooFew, yearly]));
    const used = new Set<string>();
    await autoChart('t1', [entry(tooFew), entry(yearly)], '工具機展參展商家數', used);
    expect([...used]).toEqual(['tm-counts']);
  });

  it('候選全部畫不出來就回 undefined，不拋錯', async () => {
    mockLoadTable.mockImplementation(byId([tooFew, textOnly]));
    const used = new Set<string>();
    expect(await autoChart('t1', [entry(tooFew), entry(textOnly)], '工具機展參展商家數', used)).toBeUndefined();
    expect(used.size).toBe(0);
  });

  it('已用過的表照樣先排除，再往下試', async () => {
    mockLoadTable.mockImplementation(byId([tooFew, yearly]));
    const chart = await autoChart(
      't1', [entry(yearly), entry(tooFew)], '工具機展參展商家數', new Set(['tm-counts']),
    );
    // 唯一沒用過的是 tooFew，而它畫不出來——不得退回去重畫已用過的 yearly
    expect(chart).toBeUndefined();
  });
});
