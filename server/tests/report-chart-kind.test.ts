/**
 * 圖表類型：由 LLM 依「這一節在講什麼」提出，但**程式依資料形狀有否決權**。
 *
 * 模型很容易把 107 個國家選成圓餅、把年度序列選成長條——那是規則問題不是理解問題，
 * 寫在 prompt 裡擋不住，必須寫在程式裡（比照合計列排除、不可解析值略過的作法）。
 * 覆寫一律往 bar 收斂：它對任何「類別 vs 數值」都成立。
 */
import { looksLikeProportion, resolveChartKind } from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import type { ReportDoc, SectionChart } from '@/modules/report/report.types';

const years = ['2019', '2021', '2022', '2023', '2025'];
const countries = ['日本', '美國', '德國'];
const v = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('resolveChartKind', () => {
  it('模型要 line 且標籤是年份序列 → line', () => {
    expect(resolveChartKind('line', years, v(5))).toBe('line');
  });

  it('模型要 line 但標籤是類別 → 改 bar（折線會暗示不存在的連續性）', () => {
    expect(resolveChartKind('line', countries, v(3))).toBe('bar');
  });

  it('沒指定但標籤就是年份 → 主動用 line（趨勢用長條看不出走向）', () => {
    expect(resolveChartKind(undefined, years, v(5))).toBe('line');
  });

  it('模型要 pie 且扇形數在上限內 → pie', () => {
    expect(resolveChartKind('pie', ['台灣', '海外'], [128, 232])).toBe('pie');
  });

  it('模型要 pie 但超過 6 塊 → 改 bar（角度比不出大小）', () => {
    const many = Array.from({ length: 7 }, (_, i) => `國家${i}`);
    expect(resolveChartKind('pie', many, v(7))).toBe('bar');
  });

  it('模型要 pie 但有負值 → 改 bar（負值構不成佔比）', () => {
    expect(resolveChartKind('pie', ['甲', '乙', '丙'], [5, -3, 2])).toBe('bar');
  });

  it('無法辨識的 kind 退回預設判斷（散佈圖、雷達圖等尚未支援）', () => {
    expect(resolveChartKind('scatter', countries, v(3))).toBe('bar');
    expect(resolveChartKind('radar', years, v(5))).toBe('line');
  });

  it('重複年份不算時間序列——那是分組資料，折線會把它畫成假的走勢', () => {
    expect(resolveChartKind('line', ['2023', '2023', '2024'], v(3))).toBe('bar');
  });
});

const doc = (chart: SectionChart): ReportDoc => ({
  title: 'r', topic: 't', locale: 'zh-Hant', generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [{ heading: 'h', query: 'q', body: '內文。', sources: [], hits: 5, chart }],
});
const base = { complete: true as const, sourceLabel: 'x.xlsx / s', totalRows: 5 };

describe('renderer：三種圖各自畫得出來', () => {
  it('折線畫出 path 與資料點', () => {
    const html = renderHtml(doc({
      ...base, kind: 'line', title: '歷年預登',
      points: years.map((y, i) => ({ label: y, value: (i + 1) * 1000 })),
    }));
    expect(html).toContain('<path d="M');
    expect(html).toContain('<circle');
    expect(html).toContain('2019');
  });

  it('圓餅畫出扇形與含百分比的圖例', () => {
    const html = renderHtml(doc({
      ...base, kind: 'pie', title: '台灣海外佔比', unit: '人',
      points: [{ label: '台灣', value: 128 }, { label: '海外', value: 232 }],
    }));
    expect(html).toContain('<path d="M 110 110');
    expect(html).toContain('35.6%'); // 128/360
    expect(html).toContain('台灣');
  });

  it('圓餅總和為 0 時不畫（不能除以零，也沒有佔比可言）', () => {
    const html = renderHtml(doc({
      ...base, kind: 'pie', title: 'z',
      points: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }],
    }));
    expect(html).not.toContain('<svg');
  });

  it('長條仍是預設，且不引入外部資源', () => {
    const html = renderHtml(doc({
      ...base, kind: 'bar', title: '各國',
      points: countries.map((c, i) => ({ label: c, value: (i + 1) * 10 })),
    }));
    expect(html).toContain('<rect');
    expect(html).not.toMatch(/<script|https?:\/\/[^"']*\.(js|css)/i);
  });
});

describe('甜甜圈與自動補圖', () => {
  it('donut 與 pie 適用同一組規則', () => {
    expect(resolveChartKind('donut', ['台灣', '海外'], [128, 232])).toBe('donut');
    // 超過 6 塊或有負值時同樣退回 bar
    expect(resolveChartKind('donut', Array.from({ length: 7 }, (_, i) => `x${i}`), v(7))).toBe('bar');
    expect(resolveChartKind('donut', ['甲', '乙'], [5, -1])).toBe('bar');
  });

  it('donut 畫出中央的留白圓，且仍附含百分比的圖例', () => {
    const html = renderHtml(doc({
      ...base, kind: 'donut', title: '國內外組成', unit: '家',
      points: [{ label: '國內', value: 757 }, { label: '國外', value: 197 }],
    }));
    expect(html).toContain('<circle cx="110" cy="110"'); // 中央留白
    expect(html).toContain('79.4%');
    expect(html).toContain('國內');
  });

  it('pie 不畫中央留白（兩者只差在這裡）', () => {
    const html = renderHtml(doc({
      ...base, kind: 'pie', title: 'x',
      points: [{ label: 'a', value: 1 }, { label: 'b', value: 1 }],
    }));
    expect(html).not.toContain('<circle cx="110" cy="110"');
  });
});

/**
 * 自動補圖的選型。圓餅成立與否是語意判斷——「國內 757／國外 197」構成一個整體、
 * 「日本 30／美國 232」只是兩個並列的數字，兩者的欄位型別完全相同。
 * 自動補圖若只看型別就永遠落在長條，圓餅等於形同虛設。
 */
describe('looksLikeProportion', () => {
  it('認得佔比語意', () => {
    for (const q of ['參展商的國內外組成比例', '台灣與海外的佔比', '客群結構占多少', 'market share breakdown']) {
      expect(looksLikeProportion(q)).toBe(true);
    }
  });

  it('排名、趨勢、分布不算佔比', () => {
    for (const q of ['各國買主排名', '歷年預登趨勢', '各展區家數分布']) {
      expect(looksLikeProportion(q)).toBe(false);
    }
  });
});

/**
 * 跨節不重複用表。自動補圖只看「最相關的表 + 欄位型別」，同一張表很容易在多節之間
 * 重複中選——實測一份報告有三節都畫了同一張 6-CC-參展商家數，讀者看到三張一樣的圖。
 */
describe('類別配色', () => {
  it('圓餅各塊用不同色相，而非同色深淺——類別要靠色相區分', () => {
    const html = renderHtml(doc({
      ...base, kind: 'donut', title: 'x',
      points: [{ label: 'a', value: 3 }, { label: 'b', value: 2 }, { label: 'c', value: 1 }],
    }));
    const fills = [...html.matchAll(/<path d="M 110 110[^"]*" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(new Set(fills).size).toBe(3);
    // 同色相深淺的舊配色（#0b6bcb / #2f83d6 / #5a9be0）辨識度不足，不應再出現
    expect(fills).not.toContain('#2f83d6');
    expect(fills).not.toContain('#5a9be0');
  });

  it('分組長條的各數列同樣用可區分的色相', () => {
    const html = renderHtml(doc({
      ...base, kind: 'grouped', title: 'g', series: ['甲', '乙'],
      points: [{ label: 'A', value: 1, values: [1, 2] }, { label: 'B', value: 3, values: [3, 4] }],
    }));
    // 圖例的色塊：y="4" 那一列。屬性順序不固定，用 [^>]* 跨過 width/height
    const fills = [...html.matchAll(/<rect [^>]*y="4"[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(new Set(fills).size).toBe(2);
  });
});
