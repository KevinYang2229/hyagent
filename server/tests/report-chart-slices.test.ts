/**
 * 「一列跨欄」的構成圖，以及讓它走得到的三個前置修正。
 *
 * 實跑報告時，「訪客來源」那五個項目（自行預登 72,023／駐外補助 5,807／駐外自費 18,758／
 * 廠商申請補助 1,057／現場報名 10,250，合計 107,895）沒有畫成甜甜圈，原因有四層：
 *   1. 模型附的 chart-ref 用 values 形式，parser 卻硬性要求 value → 整個 ref 被丟掉
 *   2. 該區塊未閉合（maxTokens 截斷），stripBlocks 沒移除它 → 裸 JSON 印進報告
 *   3. 落到自動補圖後，佔比路徑「第一張畫得出 donut 的就收工」→ 永遠選到只有兩列的表
 *   4. 就算 ref 被接受，values 多欄只會變成分組長條，沒有「欄 → 切片」的路徑
 */
const mockLoadTable = jest.fn();
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: jest.fn().mockResolvedValue([]),
  loadTable: (...a: unknown[]) => mockLoadTable(...a),
}));

import { autoChart, buildExactChart, extractChartRefs } from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { StoredTable } from '@/modules/knowledge/knowledge.tables.repo';
import type { ReportDoc, SectionChart } from '@/modules/report/report.types';

const SOURCES = ['自行預登', '駐外補助', '駐外自費', '廠商申請補助', '現場報名'];

const wide = (rows: string[][]): StoredTable =>
  ({
    id: 'w', source: 'CC匯出.xlsx', sheet: '3-CC-參觀者來源',
    caption: '展覽名稱:台北國際自行車展覽會',
    headers: ['類型', ...SOURCES], rowCount: rows.length, rows,
  }) as StoredTable;

const TOTAL_ROW = ['總計', '72023', '5807', '18758', '1057', '10250'];

describe('1. chart-ref 接受 values 形式（prompt 明說 value 可省略）', () => {
  const block = (json: string): string => `內文。\n\n\`\`\`chart-ref\n${json}\n\`\`\``;

  it('只有 values、沒有 value 的 ref 必須被採用', () => {
    const out = extractChartRefs(block('{"table":"t","label":"類型","values":["甲","乙"],"kind":"donut"}'));
    expect(out.refs[0]?.table).toBe('t');
    expect(out.refs[0]?.values).toEqual(['甲', '乙']);
  });

  it('values 只給一個時當成單欄的 value 用', () => {
    const out = extractChartRefs(block('{"table":"t","label":"類型","values":["人數"]}'));
    expect(out.refs[0]?.value).toBe('人數');
  });

  it('value 與 values 都沒有仍要拒絕——沒有數值欄就不成圖', () => {
    expect(extractChartRefs(block('{"table":"t","label":"類型"}')).refs).toHaveLength(0);
  });
});

describe('2. 區塊未閉合或行尾為 CRLF 時仍要移除', () => {
  const REF = '{"table":"t","label":"類型","values":["甲","乙"],"kind":"donut"}';

  it('未閉合的區塊不得留在內文——讀者不該看到裸 JSON', () => {
    const out = extractChartRefs(`內文。\n\n\`\`\`chart-ref\n${REF}`);
    expect(out.body).toBe('內文。');
    expect(out.refs[0]?.table).toBe('t');
  });

  it('被截斷成壞 JSON 的未閉合區塊：ref 丟掉，但內文一樣要乾淨', () => {
    const out = extractChartRefs('內文。\n\n```chart-ref\n{"table":"t","lab');
    expect(out.body).toBe('內文。');
    expect(out.refs).toHaveLength(0);
  });

  it('CRLF 行尾的區塊照樣抽得出來', () => {
    const out = extractChartRefs(`內文。\r\n\r\n\`\`\`chart-ref\r\n${REF}\r\n\`\`\``);
    expect(out.body).toBe('內文。');
    expect(out.refs[0]?.table).toBe('t');
  });
});

describe('3. 自動補圖的佔比路徑偏好切片較多的表', () => {
  const two = {
    id: 'two', source: 'x.xlsx', sheet: '1-CC-參觀者統計', caption: '',
    headers: ['類型', '今年預登人數'], rowCount: 3,
    rows: [['Taiwan', '128'], ['Overseas', '232'], ['總數', '360']],
  };
  const five = {
    id: 'five', source: 'x.xlsx', sheet: '3-CC-參觀者來源', caption: '',
    headers: ['來源', '人數'], rowCount: 5,
    rows: SOURCES.map((s, i) => [s, String([72023, 5807, 18758, 1057, 10250][i])]),
  };
  const entry = (t: typeof two) => ({ id: t.id, source: t.source, sheet: t.sheet, caption: t.caption, headers: t.headers, rowCount: t.rowCount });

  beforeEach(() => mockLoadTable.mockReset());

  it('兩片的圓餅資訊量最低，有五片的表就該選它', async () => {
    mockLoadTable.mockImplementation((_t: string, id: string) => Promise.resolve(id === 'two' ? two : five));
    const chart = await autoChart('t1', [entry(two), entry(five)], '訪客來源構成', new Set());
    expect(chart?.kind).toBe('donut');
    expect(chart?.points).toHaveLength(5);
  });

  it('全部候選都只有兩片時仍畫得出來——有圖勝過沒圖', async () => {
    mockLoadTable.mockResolvedValue(two);
    const chart = await autoChart('t1', [entry(two)], '訪客來源構成', new Set());
    expect(chart?.kind).toBe('donut');
    expect(chart?.points).toHaveLength(2);
  });
});

describe('4. 一列跨欄 → 切片', () => {
  beforeEach(() => mockLoadTable.mockReset());

  const sliced = (rows: string[][]): Promise<SectionChart | undefined> => {
    mockLoadTable.mockResolvedValue(wide(rows));
    return buildExactChart('t1', {
      table: 'w', label: '類型', value: '', values: SOURCES, kind: 'donut',
      title: '訪客來源構成', unit: '人',
    });
  };

  it('合計列的各欄成為切片，數值逐格讀出', async () => {
    const chart = await sliced([['2024', '1', '2', '3', '4', '5'], TOTAL_ROW]);
    expect(chart?.kind).toBe('donut');
    expect(chart?.points).toEqual([
      { label: '自行預登', value: 72023 },
      { label: '駐外補助', value: 5807 },
      { label: '駐外自費', value: 18758 },
      { label: '廠商申請補助', value: 1057 },
      { label: '現場報名', value: 10250 },
    ]);
    // 五片正好構成 107,895——這正是圓餅該用的地方
    expect(chart?.points.reduce((n, p) => n + p.value, 0)).toBe(107895);
  });

  it('沒有合計列但只有一列資料時就用那一列', async () => {
    const chart = await sliced([TOTAL_ROW.map((c, i) => (i === 0 ? '2025' : c))]);
    expect(chart?.points).toHaveLength(5);
  });

  it('多列又沒有合計列時不畫——要畫哪一列是語意問題，程式不猜也不自行加總', async () => {
    expect(await sliced([['2024', '1', '2', '3', '4', '5'], ['2025', '6', '7', '8', '9', '10']]))
      .toBeUndefined();
  });

  it('缺值的欄不成切片，其餘照畫', async () => {
    const chart = await sliced([['總計', '72023', '待補', '18758', '1057', '10250']]);
    expect(chart?.points.map((p) => p.label)).toEqual(['自行預登', '駐外自費', '廠商申請補助', '現場報名']);
  });

  it('kind 不是 pie/donut 時維持分組長條——既有行為不變', async () => {
    mockLoadTable.mockResolvedValue(wide([['Taiwan', '1', '2', '3', '4', '5'], ['Overseas', '6', '7', '8', '9', '10']]));
    const chart = await buildExactChart('t1', { table: 'w', label: '類型', value: '', values: SOURCES.slice(0, 2) });
    expect(chart?.kind).toBe('grouped');
  });

  it('說明文字要據實講「一列的各欄」，不得說成「全部 5 列」', async () => {
    const chart = await sliced([TOTAL_ROW]);
    const doc: ReportDoc = {
      title: 'r', topic: 't', locale: 'zh-Hant', generatedAt: '2026-08-18T00:00:00.000Z',
      sections: [{ heading: 'h', query: 'q', body: '內文。', sources: [], hits: 5, charts: [chart!] }],
    };
    const html = renderHtml(doc);
    expect(html).toContain('「總計」');
    expect(html).not.toContain('全部 5 列');
    // HTML 把可信度拆成「標記 + 細節」：標記一眼可辨，細節可回頭核對
    expect(html).toContain('>原始資料</span>');
    expect(renderMarkdown(doc)).toContain('「總計」');
  });
});
