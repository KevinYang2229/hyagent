/**
 * 可插拔 Agent 服務契約。
 *
 * Form / Knowledge（未來 Workflow）各自實作此介面，掛載到 service.registry，
 * 由 intent-router 每輪判斷該把對話指派給哪個服務。分派到單一服務可讓該次 LLM
 * 呼叫只帶「該服務的 tools」，比單一大 loop 更省 token。
 */
import type { DisplayBlock, PendingActionView, ReportRef } from '@hyagent/shared';
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
  /**
   * 本回合啟動的報告；前端據此顯示進度與下載連結。
   * 命名不做泛化的 artifact——目前只有這一種產出物，泛化會憑空多一層而沒有第二個使用者。
   */
  report?: ReportRef;
  /** 本回合產生的待確認寫入動作（僅 agent 服務會帶） */
  pendingAction?: PendingActionView;
  /** 本回合工具結果產生的畫面區塊（依序接在回覆文字之後呈現） */
  blocks?: DisplayBlock[];
}

export interface AgentService {
  readonly id: string;
  /** 顯示名稱（admin 服務開關 UI 用） */
  readonly label: string;
  /** Skill 層級一句話描述（admin Skill Library 頁與對外展示用） */
  readonly description: string;
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

/** 意圖靜態摘要（SkillDescriptor 用；不含 runtime 欄位） */
export interface SkillIntentSummary {
  id: string;
  description: string;
  keywords: string[];
}

/**
 * 對外可序列化的 Skill 描述——Skill 契約的正式形狀。
 * admin Skill Library 頁的資料來源；未來 Bundle（角色 → skill 集合）掛載於此。
 */
export interface SkillDescriptor {
  id: string;
  label: string;
  description: string;
  /** 是否為流程擁有者（進入後點黏，如填表） */
  sticky: boolean;
  /** 恆啟用（守門類，不受租戶停用影響） */
  alwaysEnabled: boolean;
  /** 使用所需 scope；未設＝不需（配合 alwaysEnabled） */
  requiredScope?: string;
  /** 意圖清單（form 類依租戶啟用表單而異，故 describe 需帶租戶視角） */
  intents: SkillIntentSummary[];
}

export interface RouteResult {
  serviceId: string;
  intentId?: string;
  /** 是否動用了 LLM 分類器（供觀測 token 成本） */
  viaLLM: boolean;
}
