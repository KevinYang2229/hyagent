/**
 * 可插拔 Agent 服務契約。
 *
 * Form / Knowledge（未來 Workflow）各自實作此介面，掛載到 service.registry，
 * 由 intent-router 每輪判斷該把對話指派給哪個服務。分派到單一服務可讓該次 LLM
 * 呼叫只帶「該服務的 tools」，比單一大 loop 更省 token。
 */
import type { LLMProvider } from '@/lib/llm/types';
import type { Session } from './conversation.types';

export interface IntentDescriptor {
  /** 正規化意圖 ID（命名空間），如 'leave-request.apply' / 'kb.query' */
  id: string;
  /** 關鍵字先行（0 token）比對用 */
  keywords: string[];
  /** 給 Haiku 分類器目錄用的一句描述（靜態、可快取） */
  description: string;
  examples?: string[];
}

export interface AgentTurnResult {
  reply: string;
}

export interface AgentService {
  readonly id: string;
  /** 顯示名稱（admin 服務開關 UI 用） */
  readonly label: string;
  /**
   * 是否為「點黏」擁有者：進入後續留（form=true），確保填表流程不被沖掉；
   * 旁路服務為 false（knowledge），回答後不奪走目前流程。
   */
  readonly sticky: boolean;
  /** 永遠啟用：不受租戶 disabledServices 影響（範圍守門用，關掉會退回舊漏洞）。 */
  readonly alwaysEnabled?: boolean;
  /** 使用此服務所需的 scope（如 'service:form'）；未設代表不需 scope（配合 alwaysEnabled 的守門）。 */
  readonly serviceScope?: string;
  intents(session: Session): IntentDescriptor[];
  /** 處理一輪對話。使用者訊息已由上層 runTurn 推入 session.messages。 */
  handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult>;
}

export interface RouteResult {
  serviceId: string;
  intentId?: string;
  /** 是否動用了 LLM 分類器（供觀測 token 成本） */
  viaLLM: boolean;
}
