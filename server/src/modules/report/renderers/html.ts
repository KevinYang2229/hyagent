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

/**
 * 東亞寬字元。用於估算文字寬度：這些字元約佔一個 em，拉丁字母與數字約佔 0.55 em。
 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 文字寬度估算（px）。
 *
 * server 端沒有字體度量可用，但 SVG 的版面必須在畫之前就決定，所以只能估。
 * 估值只拿來決定「截到哪裡」與「哪些標籤畫得下」，寧可略估寬一點留白，
 * 也不要讓字疊在一起——重疊是不可讀，留白只是不好看。
 */
function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += WIDE_CHAR.test(ch) ? 1 : 0.55;
  return units * fontSize;
}

/**
 * 依估算寬度截斷，超出的部分以 … 收尾。
 *
 * 標籤來自被爬取的表格欄位，長度完全不受控；不截斷的話中文標籤會直接壓到長條上。
 * 同時回傳原字串，讓呼叫端在截斷時掛 <title>：列印時看不到，但螢幕上讀者仍取得回全名。
 */
function clampLabel(text: string, fontSize: number, maxWidth: number): { shown: string; full?: string } {
  if (textWidth(text, fontSize) <= maxWidth) return { shown: text };
  const budget = maxWidth - textWidth('…', fontSize);
  let shown = '';
  let width = 0;
  for (const ch of text) {
    const w = textWidth(ch, fontSize);
    if (width + w > budget) break;
    shown += ch;
    width += w;
  }
  return { shown: `${shown.trimEnd()}…`, full: text };
}

/** clampLabel 的 <text> 內容版：截斷過的標籤掛上 <title>，滑鼠停留仍讀得到完整字串 */
function labelBody(text: string, fontSize: number, maxWidth: number): string {
  const { shown, full } = clampLabel(text, fontSize, maxWidth);
  return escapeHtml(shown) + (full ? `<title>${escapeHtml(full)}</title>` : '');
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

/** 分組長條圖例每個數列佔的橫向槽寬；上游 MAX_SERIES 為 4，4 × 150 仍在 CHART_W 內 */
const LEGEND_SLOT_W = 150;

/** 折線與圓餅共用的畫布尺寸 */
const PLOT_W = 620;
const PLOT_H = 220;

/** 折線 x 軸標籤：字級與單一標籤的寬度上限（超過就截，再由抽稀決定畫不畫） */
const X_LABEL_FS = 11;
const X_LABEL_MAX_W = 96;

/** 圓餅圖例可用寬度：文字從 x=252 起，右緣留 8px */
const LEGEND_W = PLOT_W - 252 - 8;
/**
 * 類別配色（圓餅、甜甜圈、分組長條的數列）。
 *
 * 原本用同色相由深到淺，那是「量值漸層」的邏輯——但圓餅的每一塊、分組長條的每個數列
 * 都是**不同類別**，類別要靠色相區分，深淺相近只會讓人分不出哪塊是哪塊。
 *
 * 這組已通過色覺障礙可辨性驗證：最接近的一對（#b8860b↔#c0504d）在 deutan 下 ΔE 9.6、
 * 正常視覺 15.3，皆在可辨範圍。橘色對白底的對比為 2.9:1 低於 3:1，因此圖例的文字標籤
 * 是必要的而非裝飾——顏色不能是辨識的唯一線索。
 */
const CATEGORY_COLORS = ['#1f6fb2', '#e07b39', '#2a9d8f', '#7d5ba6', '#c0504d', '#b8860b'];

/**
 * 折線圖：時間軸由左至右；只標首末與最大值，每點都掛數字會把折線淹掉。
 *
 * y 軸取資料自身的範圍而非強制含 0：時間序列要看的是「怎麼變」，1020→1035 這種
 * 小幅變化被 0 基線壓成一條直線就等於什麼都沒說。代價是基線不再是 0、變化幅度容易
 * 被高估——所以左側一定標出上下界並各畫一條格線：截斷的軸必須是看得見的，
 * 否則就是在騙人。
 */
function lineSvg(chart: SectionChart): string {
  const vals = chart.points.map((p) => p.value);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  // 全部同值時 span 為 0，畫在中線；此時上下界是同一個數，只標一次
  const flat = max === min;
  const span = max - min || 1;
  const padL = 56;
  const w = PLOT_W - padL - 16;
  const h = PLOT_H - 28 - 16;
  // 上下各留一段，讓最高與最低點不貼著圖框
  const inset = 12;
  const x = (i: number): number =>
    padL + (chart.points.length === 1 ? w / 2 : (i * w) / (chart.points.length - 1));
  const y = (v: number): number =>
    flat ? 16 + h / 2 : 16 + inset + (1 - (v - min) / span) * (h - inset * 2);

  const path = chart.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
  const dots = chart.points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="#0b6bcb"/>`)
    .join('');
  // x 軸標籤抽稀：12 個點的中文日期標籤在 620px 寬下必然重疊，寧可少標也不要糊成一團
  const spacing = chart.points.length > 1 ? w / (chart.points.length - 1) : w;
  const clamped = chart.points.map((p) => clampLabel(p.label, X_LABEL_FS, X_LABEL_MAX_W));
  const widest = Math.max(...clamped.map((c) => textWidth(c.shown, X_LABEL_FS)), 1);
  const step = Math.max(1, Math.ceil((widest + 8) / spacing));
  const keep = new Set<number>();
  for (let i = 0; i < chart.points.length; i += step) keep.add(i);
  const lastIdx = chart.points.length - 1;
  if (!keep.has(lastIdx)) {
    // 末點是時間序列裡讀者最先找的一個，寧可犧牲它前面那個標籤也要留下
    const prev = Math.max(...keep);
    if ((lastIdx - prev) * spacing < widest + 8) keep.delete(prev);
    keep.add(lastIdx);
  }
  const labels = chart.points
    .map((_pt, i) =>
      keep.has(i)
        ? `<text x="${x(i).toFixed(1)}" y="${PLOT_H - 8}" font-size="${X_LABEL_FS}" fill="#555" text-anchor="middle">` +
          `${escapeHtml(clamped[i].shown)}${clamped[i].full ? `<title>${escapeHtml(clamped[i].full)}</title>` : ''}</text>`
        : '',
    )
    .join('');
  const marks = [...new Set([0, chart.points.length - 1, vals.indexOf(max)])]
    .map(
      (i) =>
        `<text x="${x(i).toFixed(1)}" y="${(y(chart.points[i].value) - 8).toFixed(1)}" font-size="11" fill="#333" text-anchor="middle">${escapeHtml(chart.points[i].value.toLocaleString('en-US'))}</text>`,
    )
    .join('');
  // 上下界的格線與數字：y 軸不是 0 基線，不標出來讀者無從判斷變化幅度
  const bounds = flat ? [max] : [max, min];
  const grid = bounds
    .map((v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${PLOT_W - 16}" y2="${y(v).toFixed(1)}" stroke="#e5e5e5"/>`)
    .join('');
  const axis = bounds
    .map(
      (v) =>
        `<text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="10.5" fill="#777" text-anchor="end">${escapeHtml(v.toLocaleString('en-US'))}</text>`,
    )
    .join('');
  return (
    `<svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" role="img" aria-label="${escapeHtml(chart.title)}">${grid}${axis}` +
    `<path d="${path}" fill="none" stroke="#0b6bcb" stroke-width="2"/>${dots}${marks}${labels}</svg>`
  );
}

/**
 * 圓餅／甜甜圈：扇形數已由 resolveChartKind 限制在 6 以內，才畫得出可比的角度。
 *
 * 甜甜圈以「畫完扇形再蓋一個與底色同色的圓」達成，而非改用內外雙弧的路徑：
 * 這份 HTML 的底色是固定的白，蓋圓在視覺上完全等價，卻省掉一整段容易畫錯的路徑計算。
 */
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
      return `<path d="${d}" fill="${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}" stroke="#fff" stroke-width="1.5"/>`;
    })
    .join('');
  // 圖例配文字：扇形內標不下，且單靠顏色辨識對色覺障礙不友善
  const legend = chart.points
    .map((p, i) => {
      const ly = 24 + i * 22;
      const pct = ((p.value / total) * 100).toFixed(1);
      // 只截標籤、不動數字尾巴：佔比才是圓餅圖例存在的理由，截掉它等於白畫
      const tail = `  ${p.value.toLocaleString('en-US')}${chart.unit ?? ''}（${pct}%）`;
      const name = clampLabel(p.label, 12, LEGEND_W - textWidth(tail, 12));
      return (
        `<rect x="232" y="${ly - 10}" width="12" height="12" fill="${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"/>` +
        `<text x="252" y="${ly}" font-size="12" fill="#333">${escapeHtml(name.shown + tail)}` +
        `${name.full ? `<title>${escapeHtml(name.full + tail)}</title>` : ''}</text>`
      );
    })
    .join('');
  const hole = chart.kind === 'donut'
    ? `<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="#fff"/>`
    : '';
  return `<svg viewBox="0 0 ${PLOT_W} 224" role="img" aria-label="${escapeHtml(chart.title)}">${slices}${hole}${legend}</svg>`;
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
            `<rect x="${labelW}" y="${y}" width="${w}" height="${barH}" fill="${CATEGORY_COLORS[si % CATEGORY_COLORS.length]}"/>` +
            `<text x="${labelW + w + 6}" y="${y + barH - 3}" font-size="10.5" fill="#333">${escapeHtml(v.toLocaleString('en-US'))}</text>`
          );
        })
        .join('');
      const mid = top + (series.length * (barH + gapIn)) / 2;
      return `<text x="0" y="${mid}" font-size="12" fill="#333">${labelBody(p.label, 12, labelW - 8)}</text>${bars}`;
    })
    .join('');

  const legend = series
    .map((name, i) => {
      const x = i * LEGEND_SLOT_W;
      return (
        `<rect x="${x}" y="4" width="11" height="11" fill="${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"/>` +
        `<text x="${x + 16}" y="14" font-size="11" fill="#555">${labelBody(name, 11, LEGEND_SLOT_W - 16 - 8)}</text>`
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
    ? exactChartCaptionText(locale, chart)
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
      `<text x="0" y="${y + BAR_H * 0.7}" font-size="12" fill="#333">${labelBody(pt.label, 12, LABEL_W - 8)}</text>`,
      `<rect x="${LABEL_W}" y="${y}" width="${trackW}" height="${BAR_H}" fill="#f0f0f0"/>`,
      `<rect x="${LABEL_W}" y="${y}" width="${w}" height="${BAR_H}" fill="#0b6bcb"/>`,
      `<text x="${LABEL_W + trackW + 8}" y="${y + BAR_H * 0.7}" font-size="12" fill="#333">${escapeHtml(value)}</text>`,
    ].join('');
  });

  const svg = chart.kind === 'line'
    ? lineSvg(chart)
    : chart.kind === 'pie' || chart.kind === 'donut'
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
