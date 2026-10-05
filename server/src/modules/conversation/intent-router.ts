/**
 * Intent Router：每輪判斷該把對話指派給哪個 AgentService。
 *
 * 混合式路由（token 最省）：
 *  1. 關鍵字先行 → 命中明確就回（0 額外 token）。
 *  2. 填表點黏中：僅在「疑似知識語氣」時才花一次 Haiku 二次確認；否則續留表單（0 token）。
 *  3. 模糊時才落到 Haiku 的 canonical-intent 分類器（服務目錄快取、強制精簡輸出）。
 */
import { env } from '@/config/env';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import type { RouteResult } from './agent-service.types';
import type { Session } from './conversation.types';
import { isSubmitConfirmation, listEnabledForms } from './form.agent-service';
import { serviceRegistry } from './service.registry';

// 未指定 formId 且無法路由時的預設表單（沿用原 routeIntent 行為）
const DEFAULT_FORM_ID = 'leave-request';

// 疑似「知識查詢」的語氣詞：命中才考慮把填表中途插入知識問答（觸發一次 Haiku 二次確認）。
// 過度觸發只是多一次 Haiku 呼叫、由分類器把關，故涵蓋常見「事實/聯絡/產品」提問詞。
/**
 * 填表點黏中「疑似知識提問」的逃生閘：命中才花一次 Haiku 判斷，否則 0-token 續留填表。
 *
 * 這是白名單，漏列即代表該問法會被當成填表回答吞掉。原本只涵蓋「規定/如何/有哪些」這類
 * 詢問句式，卻漏了公文查詢最常見的「誰、哪個單位、何時、名單」——「⋯填表人是誰」完全不命中，
 * 於是被請假助理婉拒。寧可多花一次分類器呼叫，也不要把真問題吞掉。
 */
const KNOWLEDGE_HINT_RE =
  /(規定|政策|辦法|制度|規章|可以嗎|可不可以|如何|怎麼|多久|幾天|幾小時|是否|說明|什麼是|是什麼|定義|標準|條件|資格|請問|電話|地址|在哪|聯絡|信箱|email|有哪些|幾號|多少|誰|哪個|哪些|哪裡|哪一|何時|名單|清單|為什麼|為何|主辦|承辦|負責)/i;

const CLASSIFY_THRESHOLD = 0.6;

/**
 * 開場表單選擇（沿用原 conversation.service.routeIntent）：
 * 以各表單 agent.keywords 命中數挑最高分表單；無命中或無訊息則回預設請假單。
 */
export function pickFormId(tenantId: string, userId: string, message?: string): string {
  const forms = listEnabledForms(tenantId, userId);
  if (forms.length === 0) return ''; // 無授權表單：僅建立一般對話，不退回請假單
  const text = message?.trim();
  let best = forms.some((f) => f.formId === DEFAULT_FORM_ID) ? DEFAULT_FORM_ID : forms[0].formId;
  let bestScore = 0;
  for (const def of forms) {
    const score = (def.agent.keywords ?? []).reduce(
      (n, kw) => (kw && text?.includes(kw) ? n + 1 : n),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = def.formId;
    }
  }
  return best;
}

/** 關鍵字先行：掃描每個服務註冊的 intents.keywords，取最高分；唯一贏家才算 confident。 */
function keywordRoute(session: Session, text: string): { serviceId: string; confident: boolean } {
  const scores = serviceRegistry.enabledFor(session.tenantId, session.userId).map((svc) => {
    const score = svc.intents(session).reduce(
      (acc, intent) =>
        acc + intent.keywords.reduce((n, kw) => (kw && text.includes(kw) ? n + 1 : n), 0),
      0,
    );
    return { serviceId: svc.id, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const [top, second] = scores;
  const confident = !!top && top.score > 0 && (!second || top.score > second.score);
  return { serviceId: top?.serviceId ?? 'form', confident };
}

/** Haiku canonical-intent 分類器：服務目錄 → 選一個 intent id → 對應 serviceId。低信心回 null。 */
async function classify(session: Session, text: string): Promise<string | null> {
  const services = serviceRegistry.enabledFor(session.tenantId, session.userId);
  const catalog = services
    .flatMap((svc) => svc.intents(session).map((i) => `- ${i.id}（服務=${svc.id}）：${i.description}`))
    .join('\n');
  const system = [
    '你是 OA 對話的意圖分類器，全程只輸出 JSON。',
    '根據使用者訊息，從下列意圖清單挑最貼近的一個：',
    catalog,
    '規則：要「填寫／申請／送出」某張表單 → 對應表單意圖；',
    '與公司/OA 相關的「想知道答案」提問，以及可能收錄在公司知識庫文件中的內容（主題不限，例如上傳文件的專業知識）→ kb.query，包含公司規章制度、額度算法、FAQ、公司資訊（電話、地址、分公司、聯絡方式、產品、服務、方案、簡介）。',
    '需要系統「代為執行操作」的任務（例如代擬並寄送 Email／通知信、或需跨多個系統/工具、多步驟才能完成）→ 選對應的 agent 意圖（如 agent.task）；這類是「請你做一件事」而非「填表」或「問答」。',
    '與公司/OA 無關、且知識庫文件也不太可能收錄的一般常識、算術、閒聊、時事，或單純打招呼、道謝、問候、問「你是誰」→ off-topic；拿不準時優先 kb.query（查無資料時知識庫會如實說明）。',
    '只輸出 {"intent":"<id、off-topic 或 none>","confidence":0~1}，不要任何其他文字。',
  ].join('\n');
  try {
    const result = await getLLMProvider(tenantStore.getTenant(session.tenantId)?.llmConfig).createMessage({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 64,
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { intent?: string; confidence?: number };
    if (!parsed.intent || parsed.intent === 'none') return null;
    if ((parsed.confidence ?? 0) < CLASSIFY_THRESHOLD) return null;
    const svc = services.find((s) => s.intents(session).some((i) => i.id === parsed.intent));
    return svc?.id ?? null;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'intent classify failed');
    return null;
  }
}

export const intentRouter = {
  async route(session: Session, text: string): Promise<RouteResult> {
    const enabled = serviceRegistry.enabledFor(session.tenantId, session.userId);
    const enabledIds = new Set(enabled.map((s) => s.id));
    // 保底：無任何啟用服務時退回第一個註冊服務（極端情況，避免 undefined）
    const fallbackId = enabled[0]?.id ?? serviceRegistry.all()[0].id;

    // 待確認的寫入動作：本輪強制回 agent，讓確認閘處理確認/取消
    if (session.pendingAction && enabledIds.has('agent')) {
      return { serviceId: 'agent', viaLLM: false };
    }

    // activeServiceId 只由「點黏服務實際處理過一輪」時寫入（runTurn）。不可預設成 'form'：
    // session 一建立 status 就是 'collecting'，若再預設 form 為擁有者，等於每個對話從第一輪
    // 就處於填表點黏中，第二輪起沒踩到知識語氣詞就被 0-token 鎖回 form——使用者體感是
    // 「只能問一題，第二題就要重開對話」。點黏必須由真實的填表行為建立，而非 session 的出生狀態。
    const activeId = session.activeServiceId;
    const active = activeId ? serviceRegistry.tryGet(activeId) : undefined;
    // 點黏只在「該服務仍為啟用」時成立——停用的服務不得因點黏繞過過濾
    const inStickyFlow =
      !!activeId &&
      !!active?.sticky &&
      enabledIds.has(activeId) &&
      (session.status === 'collecting' || session.status === 'confirming');

    if (inStickyFlow) {
      // 送出確認一律留在點黏服務，避免把「可以送嗎」誤判成知識問答
      if (isSubmitConfirmation(text)) return { serviceId: activeId, viaLLM: false };
      // 明確命中「其他非知識服務」的關鍵字（form↔agent）即使在點黏中也放行互轉：
      //  - 在 form 點黏中：「寄信給」→ 轉 agent（否則簡短送信請求被困在 form）。
      //  - 在 agent 點黏中：「我要請假」等 form 關鍵字 → 轉回 form（避免被困在無表單工具的 agent）。
      // 知識問句刻意不走關鍵字（易誤搶），改由下方 hint→classify 判斷；
      // 報告請求同理排除：報告成本是單次問答的數倍（1 次大綱 + N 次檢索 + N 次彙整 + 主題抽取），
      // 填表點黏中若讓關鍵字 0-token 直接跳轉，隨口一句帶「報告/總結/彙整」就會誤觸發整條產線，
      // 比知識問答更需要 Haiku 二次確認這層防護，不能只因為忘了列進排除清單就少了它。
      const kwSticky = keywordRoute(session, text);
      if (kwSticky.confident && enabledIds.has(kwSticky.serviceId)) {
        if (
          kwSticky.serviceId !== activeId &&
          kwSticky.serviceId !== 'knowledge' &&
          kwSticky.serviceId !== 'report'
        ) {
          return { serviceId: kwSticky.serviceId, viaLLM: false };
        }
        // 明確命中點黏服務自己的關鍵字（如首句「我要請假」）→ 0 token 續留，不進下方首問分類
        if (kwSticky.serviceId === activeId) return { serviceId: activeId, viaLLM: false };
      }
      // 對話首問不硬黏：新對話預設黏 form，但第一句常是任意主題的知識提問
      // （如上傳文件的內容「中央銀行查詢語法」），沒有語氣詞就會被困在 form 而遭婉拒。
      // 首問（本輪使用者訊息剛推入 → 長度 <=1）交給分類器判斷；之後各輪維持 0-token 點黏。
      const isFirstTurn = session.messages.length <= 1;
      // 無知識語氣且非首問 → 0 token 續留；否則花一次 Haiku 判斷（gate 過度觸發也由分類器把關）
      if (!isFirstTurn && !KNOWLEDGE_HINT_RE.test(text)) return { serviceId: activeId, viaLLM: false };
      const classified = await classify(session, text);
      return { serviceId: classified ?? activeId, viaLLM: true };
    }

    // 非點黏流程：關鍵字先行，模糊才 Haiku；fallback 一律落在啟用中的服務。
    // report 在此同樣要排除在 0-token 快徑外（理由同上方點黏分支 :144-146）：非點黏才是知識問答
    // 的主場，而報告關鍵字（報告/總結/彙整）與知識問句的用詞高度重疊，keywordRoute 只比分數、
    // 不看 intent description，會讓「上個月的出差報告要附什麼單據？」這類知識提問被 0-token
    // 誤導向成本高出數倍的報告產線（1 次主題抽取 + 1 次大綱 + N 次檢索 + N 次彙整）。
    // 改落到下方 classify，交由 Haiku 二次確認。
    const kw = keywordRoute(session, text);
    if (kw.confident && kw.serviceId !== 'report' && enabledIds.has(kw.serviceId)) {
      return { serviceId: kw.serviceId, viaLLM: false };
    }
    const classified = await classify(session, text);
    return { serviceId: classified ?? fallbackId, viaLLM: true };
  },
};
