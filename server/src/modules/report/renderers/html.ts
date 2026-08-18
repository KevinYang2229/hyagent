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
import type { ReportDoc, ReportSection, SectionChart } from '../report.types';

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

/** 折線與圓餅共用的畫布尺寸 */
const PLOT_W = 620;
const PLOT_H = 220;
/** 圓餅色階：同一色相由深到淺，不用彩虹色——那會暗示不存在的分類語意 */
const PIE_SHADES = ['#0b6bcb', '#2f83d6', '#5a9be0', '#84b3ea', '#aecbf3', '#d7e3f9'];

/** 折線圖：時間軸由左至右；只標首末與最大值，每點都掛數字會把折線淹掉 */
function lineSvg(chart: SectionChart): string {
  const vals = chart.points.map((p) => p.value);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const padL = 56;
  const w = PLOT_W - padL - 16;
  const h = PLOT_H - 28 - 16;
  const x = (i: number): number =>
    padL + (chart.points.length === 1 ? w / 2 : (i * w) / (chart.points.length - 1));
  const y = (v: number): number => 16 + h - ((v - min) / span) * h;

  const path = chart.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
  const dots = chart.points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="#0b6bcb"/>`)
    .join('');
  const labels = chart.points
    .map(
      (p, i) =>
        `<text x="${x(i).toFixed(1)}" y="${PLOT_H - 8}" font-size="11" fill="#555" text-anchor="middle">${escapeHtml(p.label)}</text>`,
    )
    .join('');
  const marks = [...new Set([0, chart.points.length - 1, vals.indexOf(max)])]
    .map(
      (i) =>
        `<text x="${x(i).toFixed(1)}" y="${(y(chart.points[i].value) - 8).toFixed(1)}" font-size="11" fill="#333" text-anchor="middle">${escapeHtml(chart.points[i].value.toLocaleString('en-US'))}</text>`,
    )
    .join('');
  return (
    `<svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" role="img" aria-label="${escapeHtml(chart.title)}">` +
    `<line x1="${padL}" y1="${16 + h}" x2="${PLOT_W - 16}" y2="${16 + h}" stroke="#ddd"/>` +
    `<path d="${path}" fill="none" stroke="#0b6bcb" stroke-width="2"/>${dots}${marks}${labels}</svg>`
  );
}

/** 圓餅圖：扇形數已由 resolveChartKind 限制在 6 以內，才畫得出可比的角度 */
function pieSvg(chart: SectionChart): string {
  const total = chart.points.reduce((n, p) => n + p.value, 0);
  if (total <= 0) return '';
  const cx = 110;
  const cy = 110;
  const r = 92;
  let acc = 0;
  const slices = chart.points
    .map((p, i) => {
      const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += p.value;
      const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0);
      const y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      // 單一扇形佔滿整圓時 arc 起訖點重合、畫不出來，改用整圓路徑
      const d =
        chart.points.length === 1
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
          : `M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
      return `<path d="${d}" fill="${PIE_SHADES[i % PIE_SHADES.length]}" stroke="#fff" stroke-width="1.5"/>`;
    })
    .join('');
  // 圖例配文字：扇形內標不下，且單靠顏色辨識對色覺障礙不友善
  const legend = chart.points
    .map((p, i) => {
      const ly = 24 + i * 22;
      const pct = ((p.value / total) * 100).toFixed(1);
      const text = `${p.label}  ${p.value.toLocaleString('en-US')}${chart.unit ?? ''}（${pct}%）`;
      return (
        `<rect x="232" y="${ly - 10}" width="12" height="12" fill="${PIE_SHADES[i % PIE_SHADES.length]}"/>` +
        `<text x="252" y="${ly}" font-size="12" fill="#333">${escapeHtml(text)}</text>`
      );
    })
    .join('');
  return `<svg viewBox="0 0 ${PLOT_W} 224" role="img" aria-label="${escapeHtml(chart.title)}">${slices}${legend}</svg>`;
}

/**
 * 分組長條：同一類別下並排數列。
 *
 * 用同色相由深到淺區分數列（而非彩虹），並強制附圖例——顏色是唯一區分數列的線索，
 * 單靠色相對色覺障礙不友善，圖例的文字才是可靠的那一份。
 */
function groupedSvg(chart: SectionChart): string {
  const series = chart.series ?? [];
  const rows = chart.points.map((p) => p.values ?? [p.value]);
  const max = Math.max(...rows.flat(), 0);
  const labelW = 120;
  const trackW = CHART_W - labelW - 84;
  const barH = 14;
  const gapIn = 3;
  const gapOut = 14;
  const groupH = series.length * (barH + gapIn) + gapOut;
  const legendH = 26;
  const height = chart.points.length * groupH + legendH;

  const body = chart.points
    .map((p, gi) => {
      const top = legendH + gi * groupH;
      const bars = (p.values ?? [p.value])
        .map((v, si) => {
          const y = top + si * (barH + gapIn);
          const w = max > 0 ? Math.max(1, Math.round((v / max) * trackW)) : 0;
          return (
            `<rect x="${labelW}" y="${y}" width="${w}" height="${barH}" fill="${PIE_SHADES[si % PIE_SHADES.length]}"/>` +
            `<text x="${labelW + w + 6}" y="${y + barH - 3}" font-size="10.5" fill="#333">${escapeHtml(v.toLocaleString('en-US'))}</text>`
          );
        })
        .join('');
      const mid = top + (series.length * (barH + gapIn)) / 2;
      return `<text x="0" y="${mid}" font-size="12" fill="#333">${escapeHtml(p.label)}</text>${bars}`;
    })
    .join('');

  const legend = series
    .map((name, i) => {
      const x = i * 150;
      return (
        `<rect x="${x}" y="4" width="11" height="11" fill="${PIE_SHADES[i % PIE_SHADES.length]}"/>` +
        `<text x="${x + 16}" y="14" font-size="11" fill="#555">${escapeHtml(name)}</text>`
      );
    })
    .join('');

  return `<svg viewBox="0 0 ${CHART_W} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">${legend}${body}</svg>`;
}

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

  const svg = chart.kind === 'line'
    ? lineSvg(chart)
    : chart.kind === 'pie'
      ? pieSvg(chart)
      : chart.kind === 'grouped'
        ? groupedSvg(chart)
        : `<svg viewBox="0 0 ${CHART_W} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">${rows.join('')}</svg>`;

  return [
    '<div class="chart">',
    `<p class="chart-title">${escapeHtml(chart.title)}</p>`,
    svg,
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
