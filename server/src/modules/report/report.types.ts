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

/** 圖表的一個資料點 */
export interface ChartPoint {
  label: string;
  value: number;
}

/**
 * 該節的長條圖。**只在參考資料本身就是一組可比較的數列時才會有**。
 *
 * 刻意只支援長條（量值比較）：這批資料的問題形態是「各國多少人」「各年度多少家」，
 * 長條就答得完。折線是另一套 mark 規格，等真的有時間序列需求再加，不預先擴張。
 *
 * 這裡的數值是 LLM 從檢索片段裡讀出來的，而檢索只取 top-k——所以它必然是**節錄而非母體**。
 * renderer 有義務把這件事標在圖上（見 report.strings 的 chartCaptionText）：
 * 散文說「根據檢索到的資料」讀者知道是節錄，長條圖不會這樣說話，它隱含「這就是全部」。
 */
export interface SectionChart {
  title: string;
  /** 數值的單位（人數、家數…），標在資料點旁 */
  unit?: string;
  points: ChartPoint[];
  /**
   * true = 數字由程式從結構化表的完整資料列算出；false = LLM 從檢索片段讀出的節錄。
   * renderer 依此決定說明文字——兩者的可信度差很多，不能用同一句話帶過。
   */
  complete: boolean;
  /** complete 時的出處（檔名／工作表），供讀者回頭核對 */
  sourceLabel?: string;
  /** complete 時：表的總列數。points 若少於它，代表只取了前幾名 */
  totalRows?: number;
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
  /** 該節材料構成一組數列時的長條圖；不符條件時不存在 */
  chart?: SectionChart;
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
