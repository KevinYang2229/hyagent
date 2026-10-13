import type { DisplayBlock, PendingActionView, ReportRef, SessionStatus, SubmissionInfo } from '@hyagent/shared';
import type { LLMMessage } from '@/lib/llm/types';
import type { FormValues } from '@/modules/form/form.types';
import type { PendingAction } from './pending-action';

export type { SessionStatus, SubmissionInfo };

/** 交給模型的檢索片段（回饋診斷用）；excerpt 為內容前 TRACE_EXCERPT_CHARS 字 */
export interface ReplyTraceChunk {
  rank: number;
  id: string;
  title: string;
  url?: string;
  score?: number;
  excerpt: string;
}

/** 單則回覆的產生紀錄：只在伺服器與後台使用，不回傳前台 */
export interface ReplyTrace {
  model?: string;
  retrieval?: { query: string; poolSize: number; usedTables: boolean; chunks: ReplyTraceChunk[] };
  /** 依呼叫順序；只記工具名稱與成敗，不記輸入 */
  tools?: { name: string; ok: boolean }[];
  reportId?: string;
}

/** 可被評價的 AI 回覆：由伺服器記錄，評價時據此建立快照，前台無法偽造內容 */
export interface ReplyRecord {
  id: string;
  question: string;
  answer: string;
  serviceId: string;
  at: string;
  trace?: ReplyTrace;
}

export interface Session {
  id: string;
  /** 所屬租戶；多租戶資料隔離的關鍵。未帶 key 的舊請求為 'default'（向後相容） */
  tenantId: string;
  userId: string;
  formId: string;
  values: FormValues;
  status: SessionStatus;
  /** 目前「點黏」的服務 id（form）；未設時 router 視為 'form'（向後相容舊 session） */
  activeServiceId?: string;
  /** 回覆語系（由前端 UI 語言決定，如 'en' / 'zh-TW'）；未設時 agent 預設繁中 */
  locale?: string;
  /** 給 LLM 的逐字稿（含 tool_use / tool_result 區塊） */
  messages: LLMMessage[];
  submission?: SubmissionInfo;
  /** Agent 提議、待使用者確認的寫入動作；確認後由後端執行，非確認的下一輪、過期或新提議即失效。 */
  pendingAction?: PendingAction;
  /** 最近 MAX_REPLY_RECORDS 則可評價的回覆（見 reply-record.ts） */
  replies?: ReplyRecord[];
  createdAt: string;
  updatedAt?: string;
}

export interface TurnResult {
  reply: string;
  status: SessionStatus;
  values: FormValues;
  submission?: SubmissionInfo;
  /** 給前端 UI 的建議回覆（使用者最可能的接續回應），best-effort，可能為空 */
  suggestions: string[];
  /** 本回合啟動的報告（僅 report 服務會帶） */
  report?: ReportRef;
  /** 本回合產生的待確認寫入動作（前端畫確認卡片） */
  pendingAction?: PendingActionView;
  /** 本回合的畫面區塊（表格等）；不寫入對話歷史 */
  blocks?: DisplayBlock[];
  /** 本則回覆的編號（可評價）；沒有回覆文字時不帶 */
  replyId?: string;
}
