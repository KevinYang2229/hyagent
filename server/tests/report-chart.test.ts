/**
 * 報告圖表：從彙整輸出抽出的 ```chart 區塊，以及兩個 renderer 的呈現。
 *
 * 核心不變式是「圖表不得看起來比實際完整」——數值來自 top-k 檢索片段，必然是節錄，
 * 而長條圖不像散文會自己聲明範圍，所以說明文字是強制的，不是裝飾。
 */
import { extractChart } from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { ReportDoc, ReportSection } from '@/modules/report/report.types';

const block = (json: string): string => `內文段落。\n\n\`\`\`chart\n${json}\n\`\`\``;
const THREE = '{"title":"各國預登人數","unit":"人","points":[{"label":"日本","value":30},{"label":"美國","value":232},{"label":"德國","value":11}]}';

describe('extractChart', () => {
  it('抽出圖表並把區塊從內文移除', () => {
    const out = extractChart(block(THREE));
    expect(out.body).toBe('內文段落。');
    expect(out.chart?.title).toBe('各國預登人數');
    expect(out.chart?.unit).toBe('人');
    expect(out.chart?.points).toHaveLength(3);
  });

  it('沒有區塊時原樣回傳內文', () => {
    expect(extractChart('只有散文')).toEqual({ body: '只有散文' });
  });

  it('少於 3 點不成圖：兩個長條沒有比一句話多說什麼', () => {
    const out = extractChart(block('{"title":"t","points":[{"label":"a","value":1},{"label":"b","value":2}]}'));
    expect(out.chart).toBeUndefined();
    expect(out.body).toBe('內文段落。');
  });

  it('超過 12 點整個丟掉：每節只餵 top-k 片段，數十個點多半是編的', () => {
    const many = Array.from({ length: 13 }, (_, i) => `{"label":"c${i}","value":${i}}`).join(',');
    expect(extractChart(block(`{"title":"t","points":[${many}]}`)).chart).toBeUndefined();
  });

  it('非數值或空標籤的點被剔除，剔除後不足 3 點就整張丟掉', () => {
    const out = extractChart(block(
      '{"title":"t","points":[{"label":"a","value":"多"},{"label":"","value":2},{"label":"c","value":3}]}',
    ));
    expect(out.chart).toBeUndefined();
  });

  it('JSON 壞掉只丟圖表、保留散文——圖表是加分項，不該讓整節降級', () => {
    const out = extractChart(block('{壞掉的 json'));
    expect(out.chart).toBeUndefined();
    expect(out.body).toBe('內文段落。');
  });

  it('缺標題視為無效', () => {
    expect(extractChart(block('{"points":[{"label":"a","value":1},{"label":"b","value":2},{"label":"c","value":3}]}')).chart)
      .toBeUndefined();
  });
});

const chartSection: ReportSection = {
  heading: '參觀者預登',
  query: '各國預登人數',
  body: '本節說明各國預登情形。',
  sources: [{ title: 'TM 匯出.xlsx' }],
  hits: 5,
  chart: {
    complete: false,
    title: '各國預登人數',
    unit: '人',
    points: [
      { label: '日本', value: 30 },
      { label: '美國', value: 232 },
      { label: '德國', value: 11 },
    ],
  },
};

const doc = (section: ReportSection): ReportDoc => ({
  title: '展覽數據報告',
  topic: '展覽數據',
  locale: 'zh-Hant',
  generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [section],
});

describe('renderer：圖表呈現', () => {
  it('HTML 畫成 inline SVG，且不引入任何外部資源', () => {
    const html = renderHtml(doc(chartSection));
    expect(html).toContain('<svg');
    expect(html).toContain('各國預登人數');
    expect(html).toContain('232');
    // 這份 HTML 的不變式是「零外部資源、可離線開」——圖表不得破壞它
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
  });

  it('HTML 一定印出「節錄而非母體」的說明', () => {
    // 少了這句，長條圖看起來就是完整分布——這是圖表比散文危險的地方
    expect(renderHtml(doc(chartSection))).toContain('節錄');
  });

  it('Markdown 畫成表格並附同一句說明（md 沒有可靠的內嵌 SVG 支援）', () => {
    const md = renderMarkdown(doc(chartSection));
    expect(md).toContain('| 美國 | 232 |');
    expect(md).toContain('節錄');
    expect(md).not.toContain('<svg');
  });

  it('英文語系的說明也標明是 sample', () => {
    const html = renderHtml({ ...doc(chartSection), locale: 'en' });
    expect(html).toContain('sample, not the full data set');
  });

  it('沒有圖表的章節維持原樣，不生出空的圖表容器', () => {
    const plain: ReportSection = { ...chartSection, chart: undefined };
    expect(renderHtml(doc(plain))).not.toContain('<svg');
    expect(renderMarkdown(doc(plain))).not.toContain('節錄');
  });

  it('所有數值皆為 0 時不除以零，仍畫得出來', () => {
    const zero: ReportSection = {
      ...chartSection,
      chart: { complete: false, title: 't', points: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }, { label: 'c', value: 0 }] },
    };
    expect(() => renderHtml(doc(zero))).not.toThrow();
    expect(renderHtml(doc(zero))).toContain('<svg');
  });
});
