/**
 * Markdown renderer：ReportDoc → .md bytes。純函式，不觸碰 IO。
 */
import {
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  safeUrl,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection } from '../report.types';

function sectionBody(section: ReportSection, locale: string): string {
  if (section.hits === 0) return emptySectionText(locale);
  if (section.degraded) return `> ${degradedNoticeText(locale)}\n\n${section.body}`;
  return section.body;
}

export function renderMarkdown(doc: ReportDoc): string {
  const lines: string[] = [`# ${doc.title}`, '', `> ${doc.topic} · ${doc.generatedAt}`, ''];

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
