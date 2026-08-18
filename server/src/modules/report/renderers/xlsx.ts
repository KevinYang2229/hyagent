/**
 * XLSX renderer：ReportDoc → 試算表。
 *
 * 試算表裡沒有散文的位置，硬塞只會得到一堆沒人讀的長字串。真正值得放進來的是
 * **圖表背後的數據**——那份資料我們完整握有（SectionChart 帶著 points、series、unit、
 * 出處與節錄方式），讀者拿到就能自己往下分析。
 *
 * 數值一律以「數字」而非字串寫入：寫成字串的話 Excel 不會加總也不會排序，
 * 那就失去了把它做成試算表的唯一理由。
 */
import { Workbook } from 'exceljs';
import {
  chartCaptionText,
  chartItemHeader,
  chartValueHeader,
  exactChartCaptionText,
  formatReportTimestamp,
  sectionsSheetTitle,
  summaryHeaderRow,
} from '../report.strings';
import type { ReportDoc, ReportSection, SectionChart } from '../report.types';

/** Excel 的工作表名限制：≤31 字、不得含 : \ / ? * [ ]、不得重複、不得為空 */
function sheetName(title: string, used: Set<string>): string {
  const cleaned = title.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  let name = cleaned || 'chart';
  // 重名時加序號；截斷後的名字很容易撞在一起（同一批表的標題前 31 字往往相同）
  for (let n = 2; used.has(name); n += 1) {
    const suffix = ` (${n})`;
    name = `${cleaned.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

function captionOf(section: ReportSection, chart: SectionChart, locale: string): string {
  return chart.complete
    ? exactChartCaptionText(locale, chart)
    : chartCaptionText(locale, chart.points.length, section.hits);
}

/** 章節總表：一份報告有哪幾節、各自問了什麼、命中多少、圖畫在哪張工作表 */
function addSummary(book: Workbook, doc: ReportDoc, names: Map<ReportSection, string[]>): void {
  const sheet = book.addWorksheet(sectionsSheetTitle(doc.locale));
  sheet.addRow([doc.title]).font = { bold: true, size: 14 };
  sheet.addRow([`${doc.topic} · ${formatReportTimestamp(doc.generatedAt)}`]);
  sheet.addRow([]);
  sheet.addRow(summaryHeaderRow(doc.locale)).font = { bold: true };
  for (const section of doc.sections) {
    sheet.addRow([
      section.heading,
      section.query,
      section.hits,
      (names.get(section) ?? []).join('、'),
      section.sources.map((s) => s.title).join('、'),
    ]);
  }
  sheet.columns = [{ width: 28 }, { width: 34 }, { width: 10 }, { width: 30 }, { width: 40 }];
}

/** 單張圖的資料表：標題、出處說明、表頭、資料列 */
function addChartSheet(book: Workbook, chart: SectionChart, caption: string, name: string, locale: string): void {
  const sheet = book.addWorksheet(name);
  sheet.addRow([chart.title]).font = { bold: true, size: 12 };
  // 出處與「完整或節錄」跟著數據走：離開報告本文之後，這句話是唯一的脈絡
  sheet.addRow([caption]);
  sheet.addRow([]);

  const grouped = chart.kind === 'grouped' && chart.series?.length;
  const valueCols = grouped ? (chart.series as string[]) : [chart.unit?.trim() || chartValueHeader(locale)];
  sheet.addRow([chartItemHeader(locale), ...valueCols]).font = { bold: true };

  for (const point of chart.points) {
    const values = grouped ? (point.values ?? [point.value]) : [point.value];
    sheet.addRow([point.label, ...values]);
  }
  sheet.columns = [{ width: 26 }, ...valueCols.map(() => ({ width: 16 }))];
  // 表頭以上凍結，資料列多時捲動仍看得到欄名
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
}

export async function renderXlsx(doc: ReportDoc): Promise<Buffer> {
  const book = new Workbook();
  book.created = new Date(doc.generatedAt);

  const used = new Set<string>();
  const names = new Map<ReportSection, string[]>();
  const pending: { chart: SectionChart; caption: string; name: string }[] = [];
  for (const section of doc.sections) {
    for (const chart of section.charts ?? []) {
      const name = sheetName(chart.title, used);
      names.set(section, [...(names.get(section) ?? []), name]);
      pending.push({ chart, caption: captionOf(section, chart, doc.locale), name });
    }
  }

  // 總表放最前面：它是目錄，讀者打開檔案第一眼該看到的是全貌
  addSummary(book, doc, names);
  for (const item of pending) addChartSheet(book, item.chart, item.caption, item.name, doc.locale);

  return Buffer.from(await book.xlsx.writeBuffer());
}

export const xlsxRenderer = {
  format: 'xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  render: renderXlsx,
};
