/**
 * 圖表類型：由 LLM 依「這一節在講什麼」提出，但**程式依資料形狀有否決權**。
 *
 * 模型很容易把 107 個國家選成圓餅、把年度序列選成長條——那是規則問題不是理解問題，
 * 寫在 prompt 裡擋不住，必須寫在程式裡（比照合計列排除、不可解析值略過的作法）。
 * 覆寫一律往 bar 收斂：它對任何「類別 vs 數值」都成立。
 */
import { resolveChartKind } from '@/modules/report/report.compose';
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

  it('無法辨識的 kind 退回預設判斷', () => {
    expect(resolveChartKind('donut', countries, v(3))).toBe('bar');
    expect(resolveChartKind('donut', years, v(5))).toBe('line');
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
