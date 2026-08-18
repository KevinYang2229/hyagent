/**
 * 報告輸出格式登錄表。
 *
 * 新增一種格式 = 新增一個 renderer 檔 + 這裡加一行。路由的 format 白名單、
 * 副檔名、Content-Type、前端下載連結全部由此推導，不得在別處另寫一份格式清單——
 * 多一份就多一個會漏改的地方。
 */
import type { ReportDoc } from './report.types';
import { docxRenderer } from './renderers/docx';
import { htmlRenderer } from './renderers/html';
import { markdownRenderer } from './renderers/markdown';
import { pdfRenderer, resolveBrowserPath } from './renderers/pdf';
import { xlsxRenderer } from './renderers/xlsx';

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
export const renderers: Record<string, ReportRenderer> = {
  [markdownRenderer.format]: markdownRenderer,
  [htmlRenderer.format]: htmlRenderer,
  [docxRenderer.format]: docxRenderer,
  [xlsxRenderer.format]: xlsxRenderer,
  ...(resolveBrowserPath() ? { [pdfRenderer.format]: pdfRenderer } : {}),
};

export const REPORT_FORMATS: string[] = Object.keys(renderers);

/** 預設格式：對話與下載路由未指定 format 時使用 */
export const DEFAULT_REPORT_FORMAT = 'md';

export function isReportFormat(format: string): boolean {
  return format in renderers;
}
