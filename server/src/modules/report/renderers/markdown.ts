/**
 * Markdown renderer：ReportDoc → .md bytes。純函式，不觸碰 IO。
 */
import {
  chartCaptionText,
  exactChartCaptionText,
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  formatReportTimestamp,
  normalizeSectionBody,
  safeUrl,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection, SectionChart } from '../report.types';

function sectionBody(section: ReportSection, locale: string): string {
  if (section.hits === 0) return emptySectionText(locale);
  // 內文是 LLM 產生的 Markdown，標題層級要先正規化到章節（##）底下
  const body = normalizeSectionBody(section.body, section.heading);
  const tables = (section.charts ?? []).map((chart) => chartTable(section, chart, locale));
  const withChart = tables.length > 0 ? [body, ...tables].join('\n\n') : body;
  if (section.degraded) return `> ${degradedNoticeText(locale)}\n\n${withChart}`;
  return withChart;
}

/**
 * Markdown 沒有可靠的內嵌 SVG 支援（各 viewer 行為不一），所以畫成表格。
 * 表格反而更誠實：數字原樣可讀、可複製核對，不會有「長條看起來差不多」的失真。
 */
function chartTable(section: ReportSection, chart: SectionChart, locale: string): string {
  // complete 與否的可信度差很多，說明必須分開講，不能用同一句帶過
  const caption = chart.complete
    ? exactChartCaptionText(locale, chart)
    : chartCaptionText(locale, chart.points.length, section.hits);
  // 分組長條有多個數列，表格要跟著多開幾欄，否則等於只呈現第一個數列
  const cols = chart.kind === 'grouped' && chart.series?.length ? chart.series : [chart.unit ?? ''];
  const cells = (pt: { value: number; values?: number[] }): string =>
    (chart.kind === 'grouped' ? (pt.values ?? [pt.value]) : [pt.value])
      .map((v) => v.toLocaleString('en-US'))
      .join(' | ');
  return [
    `**${chart.title}**`,
    '',
    `| | ${cols.join(' | ')} |`,
    `| --- | ${cols.map(() => '---:').join(' | ')} |`,
    ...chart.points.map((pt) => `| ${pt.label} | ${cells(pt)} |`),
    '',
    `_${caption}_`,
  ].join('\n');
}

export function renderMarkdown(doc: ReportDoc): string {
  const lines: string[] = [`# ${doc.title}`, '', `> ${doc.topic} · ${formatReportTimestamp(doc.generatedAt)}`, ''];

  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, '', sectionBody(section, doc.locale), '');
  }

  const sources = dedupeSources(doc.sections);
  if (sources.length > 0) {
    lines.push(`## ${sourcesHeading(doc.locale)}`, '');
    for (const source of sources) {
      const validUrl = safeUrl(source.url);
      lines.push(validUrl ? `- [${source.title}](${validUrl})` : `- ${source.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export const markdownRenderer = {
  format: 'md',
  contentType: 'text/markdown; charset=utf-8',
  render: (doc: ReportDoc): Buffer => Buffer.from(renderMarkdown(doc), 'utf8'),
};
