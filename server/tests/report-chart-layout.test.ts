/**
 * 圖表版面：標籤截斷、x 軸抽稀、y 軸範圍。
 *
 * 這三件事在 server 端都得靠估算——SVG 沒有字體度量可查，版面卻必須在畫之前決定。
 * 估錯的後果不是難看而是不可讀（字疊字）或不誠實（軸被截斷卻沒說），所以要有測試釘住。
 */
import { renderHtml } from '@/modules/report/renderers/html';
import type { ReportDoc, SectionChart } from '@/modules/report/report.types';

const doc = (chart: SectionChart): ReportDoc => ({
  title: 'r',
  topic: 't',
  locale: 'zh-Hant',
  generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [{ heading: 'h', query: 'q', body: '內文。', sources: [], hits: 5, charts: [chart] }],
});

const LONG = '台北國際自行車展覽會參觀者預先登記人數統計';
/** 圓餅圖例可用寬度遠大於長條的標籤欄，要更長的字串才截得到 */
const LONGER = `${LONG}含團體與現場報名合計`;

/** 頁面 <head> 本來就有一個 <title>，圖表掛的要從總數扣掉它 */
const chartTitleTags = (html: string): number => (html.match(/<title>/g) ?? []).length - 1;

/** x 軸標籤畫在 y=212（PLOT_H - 8），用這個位置把它們從其他文字裡挑出來 */
const xLabelCount = (html: string): number => (html.match(/y="212"/g) ?? []).length;

describe('標籤截斷', () => {
  it('長條圖的長標籤被截斷，且掛 <title> 保住全名', () => {
    const html = renderHtml(doc({
      kind: 'bar', complete: false, title: 't',
      points: [{ label: LONG, value: 30 }, { label: '美國', value: 232 }, { label: '德國', value: 11 }],
    }));
    expect(html).toContain('…');
    // 截斷是為了不壓到長條，但資訊不能就這樣消失
    expect(html).toContain(`<title>${LONG}</title>`);
    // 畫出來的那一份必須是截斷後的，全名只活在 <title> 裡
    expect(html).not.toContain(`>${LONG}</text>`);
  });

  it('短標籤原樣輸出，不生出多餘的 <title>', () => {
    const html = renderHtml(doc({
      kind: 'bar', complete: false, title: 't',
      points: [{ label: '日本', value: 30 }, { label: '美國', value: 232 }, { label: '德國', value: 11 }],
    }));
    expect(html).not.toContain('…');
    expect(chartTitleTags(html)).toBe(0);
  });

  it('圓餅圖例只截標籤、保住數值與佔比——那是圖例存在的理由', () => {
    const html = renderHtml(doc({
      kind: 'pie', complete: false, title: 't', unit: '人',
      points: [{ label: LONGER, value: 300 }, { label: '海外', value: 100 }],
    }));
    expect(html).toContain('…');
    expect(html).toContain('300人（75.0%）');
    expect(html).toContain('100人（25.0%）');
  });

  it('分組長條的類別標籤與數列名都會截斷', () => {
    const html = renderHtml(doc({
      kind: 'grouped', complete: false, title: 't',
      series: [LONG, '今年報到'],
      points: [
        { label: LONG, value: 128, values: [128, 96] },
        { label: 'Overseas', value: 232, values: [232, 180] },
      ],
    }));
    // 類別標籤（12px、寬 112）與數列名（11px、寬 126）各被截一次
    expect((html.match(/…/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

const series = (labels: string[], values: number[]): SectionChart => ({
  kind: 'line', complete: false, title: 't',
  points: labels.map((label, i) => ({ label, value: values[i] })),
});

describe('折線 x 軸抽稀', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `2024年第${i + 1}月`);
  const vals = Array.from({ length: 12 }, (_, i) => 100 + i);

  it('長標籤放不下時只畫得下的那幾個，不讓字疊在一起', () => {
    const html = renderHtml(doc(series(twelve, vals)));
    expect(xLabelCount(html)).toBeLessThan(12);
    expect(xLabelCount(html)).toBeGreaterThan(1);
  });

  it('首末一定畫得到——末點是時間序列裡讀者最先找的', () => {
    const html = renderHtml(doc(series(twelve, vals)));
    expect(html).toContain('>2024年第1月<');
    expect(html).toContain('>2024年第12月<');
  });

  it('標籤短到放得下就全部畫出來，不做無謂的抽稀', () => {
    const html = renderHtml(doc(series(['a', 'b', 'c', 'd'], [1, 2, 3, 4])));
    expect(xLabelCount(html)).toBe(4);
  });
});

describe('折線 y 軸', () => {
  it('小幅變化不被 0 基線壓平：資料範圍撐滿畫布', () => {
    const html = renderHtml(doc(series(['a', 'b', 'c'], [1020, 1035, 1028])));
    const ys = [...html.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    // 三點若以 0 為基線，1020 與 1035 的落差不到 3px，等於一條直線
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
  });

  it('軸的上下界一定標出來——截斷的軸必須是看得見的', () => {
    const html = renderHtml(doc(series(['a', 'b', 'c'], [1020, 1035, 1028])));
    expect(html).toContain('>1,035<');
    expect(html).toContain('>1,020<');
  });

  it('全部同值時不除以零，畫在中線且上下界只標一次', () => {
    const html = renderHtml(doc(series(['a', 'b', 'c'], [50, 50, 50])));
    expect(html).toContain('<svg');
    expect((html.match(/text-anchor="end"/g) ?? []).length).toBe(1);
  });

  it('含負值時上下界取實際的最小與最大', () => {
    const html = renderHtml(doc(series(['a', 'b', 'c'], [-20, 40, 10])));
    expect(html).toContain('>40<');
    expect(html).toContain('>-20<');
  });
});

/**
 * 列印與 PDF 輸出。這份 HTML 的不變式之一就是「可直接列印成 PDF」，但先前完全沒有
 * 列印規則——實測一份六節的報告，加上分頁規則後由 5 頁變成 6 頁，差的那一頁就是
 * 原本被分頁線攔腰切開、現在整塊推到下一頁的圖表。
 */
describe('列印與 PDF 輸出', () => {
  const html = (): string => renderHtml(doc({
    kind: 'bar', complete: false, title: 't',
    points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }],
  }));

  it('頁面邊界交給 @page，列印時 body 不再自行留白', () => {
    expect(html()).toContain('@page{margin:16mm 14mm}');
    expect(html()).toContain('body{max-width:none;margin:0;padding:0;font-size:11pt}');
  });

  it('圖表是一個整體，不得被分頁線切開', () => {
    // .chart 涵蓋標題、SVG 與憑證；三者被拆到不同頁比沒有圖還難讀。
    // 重點數字與目錄同理：拆頁後上半頁三張卡、下半頁一張，不成一個區塊
    expect(html()).toContain('.chart,.figures,.toc{break-inside:avoid}');
  });

  it('整張表不設 break-inside——長表被迫整塊換頁會超出頁高而被裁掉', () => {
    expect(html()).toContain('tr,li{break-inside:avoid}');
    expect(html()).not.toContain('table{break-inside:avoid}');
  });

  it('標題不得落在頁尾，與內文分家', () => {
    expect(html()).toContain('.sec>h2,h1,h3,h4{break-after:avoid}');
  });
});
