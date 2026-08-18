/**
 * HTML renderer：ReportDoc → 單檔 HTML bytes。
 *
 * 零外部資源（無 CDN、無字型連結），確保離線與內網可開、可直接列印成 PDF。
 * 所有動態字串一律 escape：報告內容來自被爬取的外部網站與 LLM 輸出，屬不可信輸入。
 */
import MarkdownIt from 'markdown-it';
import { normalizeLocale } from '@/lib/locale';
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
import type { ReportDoc, ReportSection } from '../report.types';

/**
 * 章節內文的 Markdown → HTML 轉換器。
 *
 * `html: false`（預設）是這裡的安全支點：原始碼中的 raw HTML 會被 escape 而非放行，
 * 因此不需要另外接 sanitizer，「任何 raw HTML 都活不下來」這個不變式依然成立。
 * markdown-it 內建的 validateLink 也會擋掉 javascript: / vbscript: / file: 等 scheme。
 * linkify 關閉：不要把知識庫內文裡的裸網址自動變成可點連結。
 */
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });

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
  // 內文標題由 normalizeSectionBody 保證從 h3 起跳，巢狀在章節的 h2 底下
  'h3{font-size:1.05rem;margin-top:1.5rem;margin-bottom:.25rem}',
  'h4,h5,h6{font-size:1rem;margin-top:1.25rem;margin-bottom:.25rem}',
  '.meta{color:#666;font-size:.85rem;margin-bottom:2rem}',
  '.notice{background:#fff8e1;border-left:3px solid #f0b429;padding:.5rem .75rem;margin:.5rem 0}',
  '.empty{color:#666}',
  // 內文改由 markdown-it 產生真正的區塊標籤，不再需要 pre-wrap 保留換行
  'p{margin:.75rem 0}',
  'ul,ol{margin:.75rem 0;padding-left:1.5rem}',
  'li{margin:.25rem 0}',
  'blockquote{margin:.75rem 0;padding-left:.75rem;border-left:3px solid #e5e5e5;color:#555}',
  'code{background:#f5f5f5;padding:.1rem .3rem;border-radius:3px;font-size:.9em}',
  'pre{background:#f5f5f5;padding:.75rem;border-radius:4px;overflow-x:auto}',
  'pre code{background:none;padding:0}',
  'table{border-collapse:collapse;margin:.75rem 0}',
  'th,td{border:1px solid #e5e5e5;padding:.35rem .6rem;text-align:left}',
  'a{color:#0b6bcb}',
  // 圖表：純 SVG，無腳本無外部資源，離線與列印皆可
  '.chart{margin:1.25rem 0}',
  '.chart-title{font-weight:600;margin:0 0 .5rem}',
  '.chart-cap{color:#666;font-size:.8rem;margin:.4rem 0 0}',
  '.chart svg{max-width:100%;height:auto;display:block}',
].join('');

/** 長條圖列高與版面常數；SVG 座標系與這些數字一致 */
const BAR_H = 22;
const BAR_GAP = 8;
const LABEL_W = 150;
const VALUE_W = 76;
const CHART_W = 620;

/**
 * 長條圖 → inline SVG。
 *
 * 手寫 SVG 而非引第三方圖表庫：這份 HTML 的不變式是「零外部資源、可離線開、可直接列印」，
 * 而長條圖只需要矩形與文字，不值得為它破壞那個不變式。
 * 每條都直接標數值——長度只給得出概略比例，讀者要核對的是數字。
 */
function chartSvg(section: ReportSection, locale: string): string {
  const chart = section.chart;
  if (!chart) return '';
  // complete 與否的可信度差很多，說明必須分開講，不能用同一句帶過
  const caption = chart.complete
    ? exactChartCaptionText(locale, chart.points.length, chart.totalRows ?? chart.points.length, chart.sourceLabel ?? '')
    : chartCaptionText(locale, chart.points.length, section.hits);
  const max = Math.max(...chart.points.map((pt) => pt.value), 0);
  const trackW = CHART_W - LABEL_W - VALUE_W;
  const height = chart.points.length * (BAR_H + BAR_GAP);

  const rows = chart.points.map((pt, i) => {
    const y = i * (BAR_H + BAR_GAP);
    // max 為 0（全部是 0）時不除以零，直接畫成空軌
    const w = max > 0 ? Math.max(1, Math.round((pt.value / max) * trackW)) : 0;
    const value = pt.value.toLocaleString('en-US') + (chart.unit ? ` ${chart.unit}` : '');
    return [
      `<text x="0" y="${y + BAR_H * 0.7}" font-size="12" fill="#333">${escapeHtml(pt.label)}</text>`,
      `<rect x="${LABEL_W}" y="${y}" width="${trackW}" height="${BAR_H}" fill="#f0f0f0"/>`,
      `<rect x="${LABEL_W}" y="${y}" width="${w}" height="${BAR_H}" fill="#0b6bcb"/>`,
      `<text x="${LABEL_W + trackW + 8}" y="${y + BAR_H * 0.7}" font-size="12" fill="#333">${escapeHtml(value)}</text>`,
    ].join('');
  });

  return [
    '<div class="chart">',
    `<p class="chart-title">${escapeHtml(chart.title)}</p>`,
    `<svg viewBox="0 0 ${CHART_W} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">`,
    rows.join(''),
    '</svg>',
    `<p class="chart-cap">${escapeHtml(caption)}</p>`,
    '</div>',
  ].join('');
}

function sectionHtml(section: ReportSection, locale: string): string {
  const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
  if (section.hits === 0) {
    return `${heading}\n<p class="empty">${escapeHtml(emptySectionText(locale))}</p>`;
  }
  const notice = section.degraded
    ? `<p class="notice">${escapeHtml(degradedNoticeText(locale))}</p>\n`
    : '';
  // 內文是 Markdown：先把標題層級正規化到章節（h2）底下，再交給 markdown-it 轉標籤。
  // 這裡不能用 escapeHtml——那會讓 ## 與 ** 原樣顯示，正是本來的 bug。
  const body = markdown.render(normalizeSectionBody(section.body, section.heading));
  return `${heading}\n${notice}${body.trim()}${chartSvg(section, locale)}`;
}

export function renderHtml(doc: ReportDoc): string {
  const sources = dedupeSources(doc.sections);
  const sourcesBlock =
    sources.length === 0
      ? ''
      : [
          `<h2>${escapeHtml(sourcesHeading(doc.locale))}</h2>`,
          '<ul>',
          ...sources.map((s) => {
            const validUrl = safeUrl(s.url);
            return validUrl
              ? `<li><a href="${escapeHtml(validUrl)}">${escapeHtml(s.title)}</a></li>`
              : `<li>${escapeHtml(s.title)}</li>`;
          }),
          '</ul>',
        ].join('\n');

  const normalizedLocale = normalizeLocale(doc.locale);
  return [
    '<!doctype html>',
    `<html lang="${normalizedLocale === 'en' ? 'en' : 'zh-Hant'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<p class="meta">${escapeHtml(doc.topic)} · ${escapeHtml(formatReportTimestamp(doc.generatedAt))}</p>`,
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
