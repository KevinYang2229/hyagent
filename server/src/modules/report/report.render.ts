/**
 * 報告輸出格式登錄表。
 *
 * 新增一種格式 = 新增一個 renderer 檔 + 這裡加一行。路由的 format 白名單、
 * 副檔名、Content-Type、前端下載連結全部由此推導，不得在別處另寫一份格式清單——
 * 多一份就多一個會漏改的地方。
 */
import type { ReportDoc } from './report.types';
import { markdownRenderer } from './renderers/markdown';

export interface ReportRenderer {
  /** URL 與儲存用的 key，同時是副檔名 */
  format: string;
  contentType: string;
  /** 回傳型別留 Promise，讓將來需要非同步的格式（如 headless 排版）不必改介面 */
  render(doc: ReportDoc): Buffer | Promise<Buffer>;
}

export const renderers: Record<string, ReportRenderer> = {
  [markdownRenderer.format]: markdownRenderer,
};

export const REPORT_FORMATS: string[] = Object.keys(renderers);

/** 預設格式：對話與下載路由未指定 format 時使用 */
export const DEFAULT_REPORT_FORMAT = 'md';

export function isReportFormat(format: string): boolean {
  return format in renderers;
}
