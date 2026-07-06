# OA Agent 範圍守門 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 OA agent 對「與公司/OA 無關」的問題（如圓周率）禮貌婉拒並引導回服務範圍，而非照答。

**Architecture:** 新增 `assistant` 守門服務（`sticky:false` 旁路、永遠啟用），統一處理「基本客套」與「離題婉拒」。分類器 prompt 追加 `off-topic` 輸出，離題被判 `off-topic` 後經既有服務目錄映射自動路由到 assistant（route() 結構不動）。並修正 rerank 尊重 reranker 取捨，作為知識庫防禦縱深。

**Tech Stack:** TypeScript、Node、Jest（ts-jest）、Anthropic SDK（既有 `LLMProvider` 抽象）。

## Global Constraints

- 全程繁體中文回覆；英文 locale（`normalizeLocale(session.locale) === 'en'`）回英文——沿用既有 locale 判斷。
- 旁路服務**不得**觸碰 `session.values` / `session.status`（僅 push 逐字稿）。
- 測試框架 Jest；測試檔放 `server/tests/*.test.ts`；LLM 一律以 `jest.mock('@/lib/llm')` 或直接傳 mock `createMessage` 隔離，不真打 API。
- 服務註冊順序須保持 `form → knowledge → assistant`（`enabledFor` 首個仍為 form，維持既有 fallback 行為）。
- 測試指令從 repo 根目錄執行：`npm --prefix server test -- <路徑>`。

---

### Task 1: assistant 守門服務 + 註冊（永遠啟用）

**Files:**
- Create: `server/src/modules/conversation/assistant.agent-service.ts`
- Modify: `server/src/modules/conversation/agent-service.types.ts`（`AgentService` 加 `alwaysEnabled?`）
- Modify: `server/src/modules/conversation/service.registry.ts`（註冊 + `enabledFor` 尊重 `alwaysEnabled`）
- Test: `server/tests/assistant-guard.test.ts`

**Interfaces:**
- Consumes：`LLMProvider`（`@/lib/llm/types`）、`normalizeLocale`（`@/lib/locale`）、`listEnabledForms`（`./form.agent-service`，回 `Definition[]`，每筆有 `.data.title` 與 `.agent.description`）。
- Produces：`assistantAgentService: AgentService`，`id:'assistant'`、`sticky:false`、`alwaysEnabled:true`、`intents()` 回單一 `{ id:'off-topic', keywords:[], description }`。

- [ ] **Step 1: 在 `AgentService` 介面加 `alwaysEnabled?`**

於 `server/src/modules/conversation/agent-service.types.ts` 的 `AgentService` 介面，`sticky` 之後加一行：

```ts
  readonly sticky: boolean;
  /** 永遠啟用：不受租戶 disabledServices 影響（範圍守門用，關掉會退回舊漏洞）。 */
  readonly alwaysEnabled?: boolean;
```

- [ ] **Step 2: 寫失敗測試 `server/tests/assistant-guard.test.ts`**

```ts
/**
 * assistant 守門服務：離題/客套統一入口。
 * 驗證：旁路作答不觸碰 form 狀態、en locale 走英文 prompt、且守門服務永遠啟用。
 */
import type { Session } from '@/modules/conversation/conversation.types';
import { assistantAgentService } from '@/modules/conversation/assistant.agent-service';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: 'guard-test',
    userId: 'HYW103',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'form',
    messages: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('assistantAgentService', () => {
  it('離題輸入回婉拒，且不觸碰 session.values / status', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      text: '不好意思，這超出我的服務範圍，我可以協助表單申請或公司資訊。',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const session = makeSession({ values: { leaveType: 'annual' }, status: 'collecting' });
    const before = JSON.stringify(session.values);

    const res = await assistantAgentService.handleTurn(session, '圓周率是多少？', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);

    expect(res.reply).toContain('服務範圍');
    expect(JSON.stringify(session.values)).toBe(before);
    expect(session.status).toBe('collecting');
    expect(session.activeServiceId).toBe('form');
    expect(session.messages.at(-1)?.role).toBe('assistant');
  });

  it('en locale 使用英文 system prompt', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      text: 'Sorry, that is outside my scope.',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const session = makeSession({ locale: 'en' });
    await assistantAgentService.handleTurn(session, 'what is pi', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);
    const sys = mockCreate.mock.calls[0][0].system as string;
    expect(sys).toContain('English');
  });

  it('LLM 失敗時回靜態婉拒（不丟例外）', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('boom'));
    const session = makeSession();
    const res = await assistantAgentService.handleTurn(session, '講個笑話', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);
    expect(res.reply).toContain('服務範圍');
    expect(session.messages.at(-1)?.role).toBe('assistant');
  });
});

describe('serviceRegistry.enabledFor', () => {
  it('assistant 守門服務永遠啟用，無法被 disabledServices 關閉', () => {
    const t = tenantStore.createTenant('guard-always-on');
    tenantStore.updateTenant(t.id, { disabledServices: ['assistant'] });
    const ids = serviceRegistry.enabledFor(t.id).map((s) => s.id);
    expect(ids).toContain('assistant');
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `npm --prefix server test -- tests/assistant-guard.test.ts`
Expected: FAIL（`assistant.agent-service` 尚未建立 / 無法解析模組）

- [ ] **Step 4: 建立 `assistant.agent-service.ts`**

```ts
/**
 * Assistant 守門服務：把守「可回答範圍」的唯一出口。
 *
 * 統一處理兩種「非表單、非知識」情境：
 *  - 基本客套（打招呼、道謝、問候、問你是誰）→ 友善簡短回應並介紹能力。
 *  - 離題（與公司/OA 無關的一般常識、算術、閒聊）→ 禮貌婉拒並引導回服務範圍。
 * sticky=false：旁路服務，回答後不奪走流程，且刻意不觸碰 session.values / status。
 * intents() 回一個 off-topic 描述供分類器目錄使用；alwaysEnabled 讓此服務永遠啟用。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { normalizeLocale } from '@/lib/locale';
import { logger } from '@/lib/logger';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { listEnabledForms } from './form.agent-service';

function guardSystem(tenantId: string, locale?: string): string {
  const forms = listEnabledForms(tenantId)
    .map((d) => d.data.title ?? d.agent.description)
    .filter(Boolean);
  if (normalizeLocale(locale) === 'en') {
    const caps = forms.length
      ? `form applications (e.g. ${forms.join(', ')}) and company information`
      : 'form applications and company information';
    return [
      `You are the company OA assistant. You only help with ${caps}. Respond entirely in English.`,
      'Rules:',
      '- If the user is greeting, thanking, or asking who you are: reply briefly and warmly, and state what you can help with.',
      '- If the user asks anything unrelated to the company or forms (general knowledge, math, chit-chat, news): politely decline, say it is outside your scope, and steer them to a form or company question.',
      '- Keep replies to 2-3 sentences. Never actually answer the off-topic question.',
    ].join('\n');
  }
  const caps = forms.length
    ? `公司表單申請（例如：${forms.join('、')}）與公司相關資訊`
    : '公司表單申請與公司相關資訊';
  return [
    `你是公司 OA 系統的助理，只協助${caps}。全程使用繁體中文。`,
    '規則：',
    '- 若使用者是打招呼、道謝、問候或問「你是誰」：簡短友善回應，並說明你能協助什麼。',
    '- 若使用者問的是與公司/表單無關的一般問題（常識、算術、閒聊、時事等）：禮貌婉拒，說明超出你的服務範圍，並引導他改問表單或公司相關問題。',
    '- 回覆精簡（2-3 句內），切勿真的回答離題問題的內容。',
  ].join('\n');
}

/** LLM 失敗時的靜態婉拒（含關鍵字「服務範圍」，與測試一致）。 */
function staticReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'I can only help with company form applications and company information — both outside that scope I cannot assist. What would you like to do?'
    : '不好意思，這超出我的服務範圍；我可以協助公司表單申請與公司相關資訊，請問需要什麼協助呢？';
}

export const assistantAgentService: AgentService = {
  id: 'assistant',
  label: '客套與範圍守門',
  sticky: false,
  alwaysEnabled: true,

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'off-topic',
        keywords: [],
        description:
          '與公司/OA 無關的一般問題（常識、算術、閒聊、時事等），或單純打招呼、道謝、問候、問「你是誰」等客套',
      },
    ];
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    let reply: string;
    try {
      const result = await llm.createMessage({
        system: guardSystem(session.tenantId, session.locale),
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        maxTokens: 256,
      });
      reply = result.text || staticReply(session.locale);
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, 'assistant guard reply failed');
      reply = staticReply(session.locale);
    }
    // 旁路：只留逐字稿，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    return { reply };
  },
};
```

- [ ] **Step 5: 註冊服務並讓 `enabledFor` 尊重 `alwaysEnabled`**

於 `server/src/modules/conversation/service.registry.ts`：

import 區塊（`formAgentService` import 之後）加：

```ts
import { assistantAgentService } from './assistant.agent-service';
```

register 區塊（`register(knowledgeAgentService);` 之後）加：

```ts
register(assistantAgentService);
```

`enabledFor` 內的 filter 改為（讓 alwaysEnabled 服務不受 disabledServices 影響）：

```ts
  enabledFor(tenantId: string): AgentService[] {
    const disabled = new Set(tenantStore.getTenant(tenantId)?.disabledServices ?? []);
    return [...registry.values()].filter((s) => s.alwaysEnabled || !disabled.has(s.id));
  },
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm --prefix server test -- tests/assistant-guard.test.ts`
Expected: PASS（4 個測試全綠）

- [ ] **Step 7: typecheck**

Run: `npm --prefix server run typecheck`
Expected: 無錯誤

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/conversation/assistant.agent-service.ts \
        server/src/modules/conversation/agent-service.types.ts \
        server/src/modules/conversation/service.registry.ts \
        server/tests/assistant-guard.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 新增 assistant 範圍守門服務

離題/客套統一由旁路的 assistant 服務處理，永遠啟用不可被租戶關閉。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 分類器加入 off-topic 判斷

**Files:**
- Modify: `server/src/modules/conversation/intent-router.ts:72-79`（`classify` 的 system prompt）
- Test: `server/tests/intent-router.test.ts`（新增 2 個案例）

**Interfaces:**
- Consumes：Task 1 的 `assistantAgentService`（其 `intents()` 回 `off-topic`，已在 `serviceRegistry` 永遠啟用；`classify` 建立目錄與映射時自動涵蓋）。
- Produces：`classify` 對離題/客套輸入回 `'assistant'`（經 `services.find(...off-topic...)` 映射），使 `route()` 既有 `classified ?? fallback/activeId` 邏輯自然導向 assistant。route() 結構不改。

- [ ] **Step 1: 在 `intent-router.test.ts` 新增失敗測試（鎖定 prompt 內容）**

Task 1 註冊 assistant 後，`classify` 已能把 `off-topic` 映射到 assistant，故「路由結果」測試在改 prompt 前就會綠——不能當紅綠驅動。真正屬於本 Task 的行為是「分類器 prompt 指示模型輸出 off-topic」。於 `describe('intentRouter.route', ...)` 內、既有案例之後插入這個**會失敗**的測試：

```ts
  it('分類器 system prompt 指示模型對離題/客套輸出 off-topic', async () => {
    // 全新 session 即 collecting/form（點黏）；「多少」命中 KNOWLEDGE_HINT_RE → 進 classify
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    await intentRouter.route(makeSession(), '圓周率是多少？');
    const sys = mockCreate.mock.calls[0][0].system as string;
    expect(sys).toContain('off-topic');
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm --prefix server test -- tests/intent-router.test.ts`
Expected: FAIL（目前 `classify` 的 system prompt 未含 `off-topic` 字樣，`expect(sys).toContain('off-topic')` 不通過）

- [ ] **Step 3: 修改 `classify` 的 system prompt**

於 `server/src/modules/conversation/intent-router.ts` 的 `classify`，把原本這三行：

```ts
    '規則：要「填寫／申請／送出」某張表單 → 對應表單意圖；',
    '任何「想知道答案」的提問 → kb.query，包含公司規章制度、額度算法、FAQ，以及公司本身資訊（電話、地址、分公司、聯絡方式、產品、服務、方案、簡介）。',
    '只輸出 {"intent":"<id 或 none>","confidence":0~1}，不要任何其他文字。',
```

改為：

```ts
    '規則：要「填寫／申請／送出」某張表單 → 對應表單意圖；',
    '與公司/OA 相關的「想知道答案」提問 → kb.query，包含公司規章制度、額度算法、FAQ，以及公司本身資訊（電話、地址、分公司、聯絡方式、產品、服務、方案、簡介）。',
    '與公司/OA 無關的一般常識、算術、閒聊、時事，或單純打招呼、道謝、問候、問「你是誰」→ off-topic。',
    '只輸出 {"intent":"<id、off-topic 或 none>","confidence":0~1}，不要任何其他文字。',
```

（`classify` 的解析與映射不需改：`off-topic` 非 `none`、通過門檻後由既有 `services.find((s) => s.intents(session).some((i) => i.id === parsed.intent))` 映射到 assistant。）

- [ ] **Step 4: 執行測試確認 prompt 測試通過**

Run: `npm --prefix server test -- tests/intent-router.test.ts`
Expected: PASS（Step 1 的 `off-topic` prompt 測試轉綠；原有 8 案例仍全綠）

- [ ] **Step 5: 補整合回歸測試（驗證 off-topic → assistant 端到端串通）**

於同一 `describe('intentRouter.route', ...)` 內、Step 1 測試之後插入：

```ts
  it('填表中離題（含疑問語氣觸發 hint）→ off-topic → 指派 assistant 守門', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.95}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession(), '圓周率是多少？');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.serviceId).toBe('assistant');
    expect(r.viaLLM).toBe(true);
  });

  it('非點黏流程離題 → off-topic → 指派 assistant 守門', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession({ status: 'submitted' }), '幫我查一下天氣');
    expect(r.serviceId).toBe('assistant');
  });
```

Run: `npm --prefix server test -- tests/intent-router.test.ts`
Expected: PASS（這兩個整合案例因 Task 1 已註冊 assistant 而通過；一併確認「分類信心低於門檻 → 退回 form」「Haiku 判表單意圖 → 續留 form」仍綠）

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/conversation/intent-router.ts server/tests/intent-router.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 分類器加入 off-topic 判斷導向守門

離題/客套經分類器判為 off-topic，映射到 assistant 守門服務婉拒。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: rerank 尊重取捨（知識庫防禦縱深）

**Files:**
- Modify: `server/src/modules/knowledge/rerank.ts:44-50`（移除補回剔除片段）
- Test: `server/tests/knowledge-rerank.test.ts`

**Interfaces:**
- Consumes：`rerankChunks(query: string, chunks: KnowledgeChunk[], topK: number): Promise<KnowledgeChunk[]>`；`env.KNOWLEDGE_RERANK` 預設 true；候選數需 > topK 才觸發重排。
- Produces：`rerankChunks` 成功解析時只回 reranker 選中的片段（不再把剔除片段補回 slice）；reranker 回空陣列 → 回 `[]`（交由 `knowledgeAgentService` 顯示「查無相關資料」）。模型解析失敗/關閉時維持既有 fallback（回 `chunks.slice(0, topK)`）。

- [ ] **Step 1: 寫失敗測試 `server/tests/knowledge-rerank.test.ts`**

```ts
/**
 * rerank 尊重 reranker 取捨：只回選中片段、剔除者不補回；全數剔除回空。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { rerankChunks } from '@/modules/knowledge/rerank';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const chunks: KnowledgeChunk[] = [
  { id: '0', title: 'A', content: 'aaa' },
  { id: '1', title: 'B', content: 'bbb' },
  { id: '2', title: 'C', content: 'ccc' },
];

function mockRerank(text: string) {
  (getLLMProvider as jest.Mock).mockReturnValue({
    name: 'mock',
    createMessage: jest.fn().mockResolvedValue({ text, toolCalls: [], stopReason: 'end_turn' }),
  });
}

describe('rerankChunks', () => {
  it('只回傳 reranker 選中的片段，不把剔除片段補回', async () => {
    mockRerank('[0]'); // 3 候選、topK=2，但 reranker 只選 0
    const out = await rerankChunks('q', chunks, 2);
    expect(out.map((c) => c.id)).toEqual(['0']); // 不補到 2 筆
  });

  it('reranker 判定全數不相關（回空陣列）→ 回空', async () => {
    mockRerank('[]');
    const out = await rerankChunks('q', chunks, 2);
    expect(out).toEqual([]);
  });

  it('模型輸出無法解析（無陣列）→ 維持既有 fallback：回 top-k', async () => {
    mockRerank('抱歉我不確定');
    const out = await rerankChunks('q', chunks, 2);
    expect(out.map((c) => c.id)).toEqual(['0', '1']);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm --prefix server test -- tests/knowledge-rerank.test.ts`
Expected: FAIL（前兩案：目前會把剔除片段補回，`[0]` 會被補成 `['0','2']`；`[]` 會被補成 `['0','1']`）

- [ ] **Step 3: 移除補回剔除片段的邏輯**

於 `server/src/modules/knowledge/rerank.ts`，把 `try` 內原本這段：

```ts
    const order = JSON.parse(match[0]) as unknown[];
    const picked = order
      .filter((n): n is number => typeof n === 'number' && n >= 0 && n < chunks.length)
      .map((n) => chunks[n]);
    // 模型漏選的補在後面，確保不因重排丟失候選
    const seen = new Set(picked);
    const merged = [...picked, ...chunks.filter((c) => !seen.has(c))];
    return merged.slice(0, topK);
```

改為（尊重 reranker 取捨：只回選中片段；全數剔除即回空）：

```ts
    const order = JSON.parse(match[0]) as unknown[];
    const picked = order
      .filter((n): n is number => typeof n === 'number' && n >= 0 && n < chunks.length)
      .map((n) => chunks[n]);
    // 尊重 reranker 取捨：判為不相關而省略的片段不補回（避免不相關內容硬進作答 LLM）。
    // reranker 全數剔除 → 回空，交由上層顯示「查無相關資料」。
    return picked.slice(0, topK);
```

（`if (!match) return chunks.slice(0, topK)` 與 catch 的 fallback 皆維持不變——僅在模型輸出無法解析/失敗時才回 top-k。）

- [ ] **Step 4: 執行測試確認通過**

Run: `npm --prefix server test -- tests/knowledge-rerank.test.ts`
Expected: PASS（3 案全綠）

- [ ] **Step 5: 回歸既有知識庫測試**

Run: `npm --prefix server test -- tests/knowledge-rag.test.ts`
Expected: PASS（`knowledge-rag.test.ts` 的向量檢索與綜合作答不受影響）

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/rerank.ts server/tests/knowledge-rerank.test.ts
git commit -m "$(cat <<'EOF'
fix(knowledge): rerank 尊重取捨，不把不相關片段補回

reranker 剔除的片段不再補回 slice；全數剔除回空，避免離題查詢硬答。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 全套回歸與收尾

**Files:** 無（僅驗證）

- [ ] **Step 1: 全套測試**

Run: `npm --prefix server test`
Expected: 全綠（含既有 intent-router / knowledge-rag / service-enabled 等）

- [ ] **Step 2: typecheck 與 lint**

Run: `npm --prefix server run typecheck && npm --prefix server run lint`
Expected: 無錯誤

- [ ] **Step 3: 手動端到端驗證（選用，需可跑 dev server）**

啟動後對話輸入「圓周率是多少」，預期得到婉拒＋引導，而非 3.14159；輸入公司知識問題（如既有 FAQ）仍正常作答；填表流程（請假）不受影響。

---

## 已知限制（交付時告知）

點黏（填表中）流程僅在訊息命中 `KNOWLEDGE_HINT_RE`（含「多少/什麼是/如何…」等疑問語氣）時才會進分類器。**純閒聊指令**（如「講個笑話」，不含疑問語氣詞）在填表途中會續留 form、由 form LLM 回覆——本計劃範圍（4 檔）內不處理。問句型離題（圓周率、天氣多少…）皆會被守門攔下。若需完整涵蓋，後續可加一行 form system prompt 範圍限制（另開小改動）。
