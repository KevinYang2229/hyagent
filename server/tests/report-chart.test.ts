/**
 * 報告圖表：從彙整輸出抽出的 ```chart 區塊，以及兩個 renderer 的呈現。
 *
 * 核心不變式是「圖表不得看起來比實際完整」——數值來自 top-k 檢索片段，必然是節錄，
 * 而長條圖不像散文會自己聲明範圍，所以說明文字是強制的，不是裝飾。
 */
import { extractCharts, extractChartRefs } from '@/modules/report/report.compose';
import { renderHtml } from '@/modules/report/renderers/html';
import { renderMarkdown } from '@/modules/report/renderers/markdown';
import type { ReportDoc, ReportSection } from '@/modules/report/report.types';

const block = (json: string): string => `內文段落。\n\n\`\`\`chart\n${json}\n\`\`\``;
const THREE = '{"title":"各國預登人數","unit":"人","points":[{"label":"日本","value":30},{"label":"美國","value":232},{"label":"德國","value":11}]}';

describe('extractCharts', () => {
  it('抽出圖表並把區塊從內文移除', () => {
    const out = extractCharts(block(THREE));
    expect(out.body).toBe('內文段落。');
    expect(out.charts[0]?.title).toBe('各國預登人數');
    expect(out.charts[0]?.unit).toBe('人');
    expect(out.charts[0]?.points).toHaveLength(3);
  });

  it('沒有區塊時原樣回傳內文', () => {
    expect(extractCharts('只有散文')).toEqual({ body: '只有散文', charts: [] });
  });

  it('少於 3 點不成圖：兩個長條沒有比一句話多說什麼', () => {
    const out = extractCharts(block('{"title":"t","points":[{"label":"a","value":1},{"label":"b","value":2}]}'));
    expect(out.charts).toHaveLength(0);
    expect(out.body).toBe('內文段落。');
  });

  it('超過 12 點整個丟掉：每節只餵 top-k 片段，數十個點多半是編的', () => {
    const many = Array.from({ length: 13 }, (_, i) => `{"label":"c${i}","value":${i}}`).join(',');
    expect(extractCharts(block(`{"title":"t","points":[${many}]}`)).charts).toHaveLength(0);
  });

  it('非數值或空標籤的點被剔除，剔除後不足 3 點就整張丟掉', () => {
    const out = extractCharts(block(
      '{"title":"t","points":[{"label":"a","value":"多"},{"label":"","value":2},{"label":"c","value":3}]}',
    ));
    expect(out.charts).toHaveLength(0);
  });

  it('JSON 壞掉只丟圖表、保留散文——圖表是加分項，不該讓整節降級', () => {
    const out = extractCharts(block('{壞掉的 json'));
    expect(out.charts).toHaveLength(0);
    expect(out.body).toBe('內文段落。');
  });

  it('缺標題視為無效', () => {
    expect(extractCharts(block('{"points":[{"label":"a","value":1},{"label":"b","value":2},{"label":"c","value":3}]}')).charts)
      .toHaveLength(0);
  });
});

const chartSection: ReportSection = {
  heading: '參觀者預登',
  query: '各國預登人數',
  body: '本節說明各國預登情形。',
  sources: [{ title: 'TM 匯出.xlsx' }],
  hits: 5,
  charts: [{
    kind: 'bar' as const,
    complete: false,
    title: '各國預登人數',
    unit: '人',
    points: [
      { label: '日本', value: 30 },
      { label: '美國', value: 232 },
      { label: '德國', value: 11 },
    ],
  }],
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
    // 節錄圖掛的是虛線空心標記，細節講清楚範圍
    expect(html).toContain('>Excerpt</span>');
    expect(html).toContain('drawn from 5 retrieved excerpts');
  });

  it('沒有圖表的章節維持原樣，不生出空的圖表容器', () => {
    const plain: ReportSection = { ...chartSection, charts: undefined };
    expect(renderHtml(doc(plain))).not.toContain('<svg');
    expect(renderMarkdown(doc(plain))).not.toContain('節錄');
  });

  it('所有數值皆為 0 時不除以零，仍畫得出來', () => {
    const zero: ReportSection = {
      ...chartSection,
      charts: [{ kind: 'bar' as const, complete: false, title: 't', points: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }, { label: 'c', value: 0 }] }],
    };
    expect(() => renderHtml(doc(zero))).not.toThrow();
    expect(renderHtml(doc(zero))).toContain('<svg');
  });
});

/**
 * 實跑一份真實報告時發現的缺陷：模型在一節裡吐了 6 個 chart-ref 區塊（它想畫多張圖），
 * 而解析器用非全域 regex 只移除第一個——其餘全部以裸露的 JSON 留在內文裡給讀者看。
 */
describe('多個圖表區塊', () => {
  const refBlock = (t: string) =>
    `\`\`\`chart-ref\n{"table":"${t}","label":"國家","value":"人數"}\n\`\`\``;

  it('內文不得殘留任何區塊，且每一個有效區塊都要採用', () => {
    const out = extractChartRefs(`前段。\n\n${refBlock('a')}\n\n中段。\n\n${refBlock('b')}\n\n後段。`);
    // 一節多圖之後不再只取第一個：模型吐好幾個區塊時它是真的想畫好幾張
    expect(out.refs.map((r) => r.table)).toEqual(['a', 'b']);
    expect(out.body).not.toContain('chart-ref');
    expect(out.body).not.toContain('{"table"');
    expect(out.body).toContain('前段。');
    expect(out.body).toContain('中段。');
    expect(out.body).toContain('後段。');
  });

  it('壞掉的區塊跳過、好的照收，兩個都要從內文移除', () => {
    const out = extractChartRefs(`x\n\n\`\`\`chart-ref\n{壞\n\`\`\`\n\n${refBlock('b')}`);
    expect(out.refs.map((r) => r.table)).toEqual(['b']);
    expect(out.body).not.toContain('chart-ref');
  });

  it('空區塊只移除、不當成有效挑選', () => {
    const out = extractChartRefs('內文。\n\n```chart-ref\n```');
    expect(out.refs).toHaveLength(0);
    expect(out.body).toBe('內文。');
  });

  it('inline 圖表同樣全部採用、全部移除', () => {
    const b = (title: string) =>
      `\`\`\`chart\n{"title":"${title}","points":[{"label":"a","value":1},{"label":"b","value":2},{"label":"c","value":3}]}\n\`\`\``;
    const out = extractCharts(`前。\n\n${b('第一張')}\n\n後。\n\n${b('第二張')}`);
    expect(out.charts.map((c) => c.title)).toEqual(['第一張', '第二張']);
    expect(out.body).not.toContain('```chart');
    expect(out.body).toContain('後。');
  });

  it('chart 的解析不得誤吃 chart-ref（前者是後者的字首）', () => {
    const out = extractCharts(`內文。\n\n${refBlock('a')}`);
    expect(out.charts).toHaveLength(0);
    expect(out.body).toContain('chart-ref'); // 該由 extractChartRef 處理，不是這裡
  });
});
