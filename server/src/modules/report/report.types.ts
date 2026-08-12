/**
 * 報告模組的資料模型。
 *
 * ReportDoc 刻意與輸出格式無關：renderer 只做「結構化資料 → bytes」，
 * 新增格式不必回頭改彙整流程。
 */

/** 大綱中的一節：標題 + 用來檢索該節材料的查詢句 */
export interface OutlineSection {
  heading: string;
  /** 必須是可獨立檢索的完整問句，不是標題的複製 */
  query: string;
}

export interface Outline {
  title: string;
  sections: OutlineSection[];
}

/** 一節的來源引用 */
export interface SectionSource {
  title: string;
  url?: string;
}

/** 彙整完成的一節 */
export interface ReportSection {
  heading: string;
  query: string;
  /** 彙整後內文；hits=0 時為空字串，固定語句由 renderer 補（各格式語系一致） */
  body: string;
  sources: SectionSource[];
  /** 檢索命中數，0 代表該節查無資料 */
  hits: number;
  /** 該節彙整 LLM 失敗、已降級為片段列表；renderer 必須標註出來 */
  degraded?: boolean;
}

export interface ReportDoc {
  title: string;
  /** 使用者原始主題，保留於報告表頭供讀者對照 */
  topic: string;
  locale: string;
  generatedAt: string;
  sections: ReportSection[];
}

/**
 * job 狀態。empty 獨立於 done 與 failed：流程全跑完、沒出錯，但所有節都零命中。
 * 併進 done 會給一個空報告的下載連結，併進 failed 則謊稱系統故障——
 * 兩者都讓使用者分不清「知識庫沒資料」還是「系統壞了」。
 */
export type ReportStatus =
  | 'queued'
  | 'outlining'
  | 'composing'
  | 'done'
  | 'empty'
  | 'failed';

export interface ReportJob {
  id: string;
  tenantId: string;
  userId: string;
  topic: string;
  status: ReportStatus;
  /** 大綱節數；outlining 完成後才有值 */
  totalSections?: number;
  doneSections: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
