/**
 * 報告輸出格式登錄表。
 *
 * 新增一種格式 = 新增一個 renderer 檔 + 這裡加一行。路由的 format 白名單、
 * 副檔名、Content-Type、前端下載連結全部由此推導，不得在別處另寫一份格式清單——
 * 多一份就多一個會漏改的地方。
 */
import type { ReportDoc } from './report.types';
import { htmlRenderer } from './renderers/html';
import { markdownRenderer } from './renderers/markdown';
import { pdfRenderer, resolveBrowserPath } from './renderers/pdf';

export interface ReportRenderer {
  /** URL 與儲存用的 key，同時是副檔名 */
  format: string;
  contentType: string;
  /** 回傳型別留 Promise，讓將來需要非同步的格式（如 headless 排版）不必改介面 */
  render(doc: ReportDoc): Buffer | Promise<Buffer>;
}

/*
 * pdf 依賴外部的 Chromium，探測不到就不登錄。
 *
 * 與其讓 API 宣告一個必定失敗的格式，不如讓 format 白名單誠實反映這個部署實際做得到什麼：
 * 沒有瀏覽器時 ?format=pdf 得到的是 422「不支援的格式」而不是 500，前端的下載清單也不會
 * 出現一個按了就壞的連結。代價是裝好瀏覽器後要重啟才會生效——登錄表是啟動時決定的。
 */
/*
 * docx 與 xlsx 目前不對外開放：renderers/docx.ts 與 renderers/xlsx.ts 仍然保留且有測試，
 * 只是不登錄在這裡。登錄表是唯一的格式來源，少了這兩行，報告就不會產出這兩種檔案、
 * 下載清單不會列出、?format=docx 也會得到 422，不必再去前端各挖一份隱藏清單。
 * 要重新開放就把兩行加回來。
 */
export const renderers: Record<string, ReportRenderer> = {
  [markdownRenderer.format]: markdownRenderer,
  [htmlRenderer.format]: htmlRenderer,
  ...(resolveBrowserPath() ? { [pdfRenderer.format]: pdfRenderer } : {}),
};

export const REPORT_FORMATS: string[] = Object.keys(renderers);

/** 預設格式：對話與下載路由未指定 format 時使用 */
export const DEFAULT_REPORT_FORMAT = 'md';

export function isReportFormat(format: string): boolean {
  return format in renderers;
}
