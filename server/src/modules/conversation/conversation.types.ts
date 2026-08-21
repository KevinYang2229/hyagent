import type { ReportRef, SessionStatus, SubmissionInfo } from '@hyagent/shared';
import type { LLMMessage } from '@/lib/llm/types';
import type { FormValues } from '@/modules/form/form.types';

export type { SessionStatus, SubmissionInfo };

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
  /** Agent 待使用者確認的寄信草稿；確認後由確認閘以 email.send 送出，非確認的 agent 輪一律清空。 */
  pendingEmail?: { to: string; subject: string; html: string };
  createdAt: string;
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
}
