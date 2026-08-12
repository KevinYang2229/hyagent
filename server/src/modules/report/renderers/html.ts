/**
 * HTML renderer：ReportDoc → 單檔 HTML bytes。
 *
 * 零外部資源（無 CDN、無字型連結），確保離線與內網可開、可直接列印成 PDF。
 * 所有動態字串一律 escape：報告內容來自被爬取的外部網站與 LLM 輸出，屬不可信輸入。
 */
import {
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection } from '../report.types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  'body{max-width:46rem;margin:2rem auto;padding:0 1rem;',
  'font-family:system-ui,"Noto Sans TC",sans-serif;line-height:1.7;color:#1a1a1a}',
  'h1{font-size:1.6rem;margin-bottom:.25rem}',
  'h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #e5e5e5;padding-bottom:.25rem}',
  '.meta{color:#666;font-size:.85rem;margin-bottom:2rem}',
  '.notice{background:#fff8e1;border-left:3px solid #f0b429;padding:.5rem .75rem;margin:.5rem 0}',
  '.empty{color:#666}',
  'p{white-space:pre-wrap}',
  'a{color:#0b6bcb}',
].join('');

function sectionHtml(section: ReportSection, locale: string): string {
  const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
  if (section.hits === 0) {
    return `${heading}\n<p class="empty">${escapeHtml(emptySectionText(locale))}</p>`;
  }
  const notice = section.degraded
    ? `<p class="notice">${escapeHtml(degradedNoticeText(locale))}</p>\n`
    : '';
  return `${heading}\n${notice}<p>${escapeHtml(section.body)}</p>`;
}

export function renderHtml(doc: ReportDoc): string {
  const sources = dedupeSources(doc.sections);
  const sourcesBlock =
    sources.length === 0
      ? ''
      : [
          `<h2>${escapeHtml(sourcesHeading(doc.locale))}</h2>`,
          '<ul>',
          ...sources.map((s) =>
            s.url
              ? `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a></li>`
              : `<li>${escapeHtml(s.title)}</li>`,
          ),
          '</ul>',
        ].join('\n');

  return [
    '<!doctype html>',
    `<html lang="${doc.locale === 'en' ? 'en' : 'zh-Hant'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<p class="meta">${escapeHtml(doc.topic)}　${escapeHtml(doc.generatedAt)}</p>`,
    ...doc.sections.map((s) => sectionHtml(s, doc.locale)),
    sourcesBlock,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export const htmlRenderer = {
  format: 'html',
  contentType: 'text/html; charset=utf-8',
  render: (doc: ReportDoc): Buffer => Buffer.from(renderHtml(doc), 'utf8'),
};
