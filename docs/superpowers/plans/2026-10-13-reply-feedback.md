# AI 回覆回饋機制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者可對 AI 回覆按讚／倒讚（倒讚可附原因與說明），管理員在後台依問答快照與檢索紀錄診斷、修正並追蹤處理狀態。

**Architecture:** 伺服器在每輪回覆時發 `replyId`，並把問答與檢索紀錄（trace）存進 session 的最近 20 則 `replies`；評價 API 只收 `replyId`，由伺服器從 session 複製快照寫入新的 `feedback` store（記憶體＋file／db）。前台（client、mobile 共用核心）在 AI 回覆旁加讚／倒讚，後台新增「回饋」分頁讀統計、清單與詳情。

**Tech Stack:** Express + zod + Prisma（server, jest）、Vite + React（client／admin, vitest + Testing Library）、Expo / React Native（mobile app-core, jest + @testing-library/react-native）。

**Spec:** `docs/superpowers/specs/2026-10-13-reply-feedback-design.md`

## Global Constraints

- 只保留最近 **20** 則回覆紀錄；trace 片段節錄 **300** 字。
- 評價 `rating`：`up` | `down`；`reason`：`wrong` | `not_answered` | `outdated` | `inappropriate` | `other`；`comment` trim 後 ≤ **500** 字；reason／comment **只在 down 時接受**。
- 處理說明 `resolutionNote` ≤ **200** 字；`status`：`open` | `resolved`。
- `FEEDBACK_RETENTION_DAYS` 預設 **180**，範圍 1–3650，依 `updatedAt` 清除。
- 後台清單每頁預設 **10**、上限 **50**，游標分頁；統計期間 **7／30／90** 天，預設 30。
- trace **不回傳給前台**；後台回答以純文字顯示，**不渲染 markdown**。
- server 只能 `import type` 自 `@hyagent/shared`（部署映像不帶 shared 執行期程式）。
- 每個 commit 訊息遵循專案慣例：`type(scope): 中文主旨` + 條列 body，結尾附 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- server 測試用 `npx jest <file>`（在 `server/` 下）；client／admin 用 `npx vitest run <file>`；mobile 用 `npx jest <file>`（在 `mobile/packages/app-core/` 下）。

## Review Focus

1. **改評的處理狀態**：已處理的倒讚被改成讚或重新倒讚，應回到 `open`；從 down 改 up 必須清掉 reason 與 comment。→ Task 3 測試。
2. **回覆被擠出最近 20 則後才評價**：應回 404 並提示「這則回覆已無法評價」，前台還原按鈕。→ Task 4、Task 6 測試。
3. **對話被保留政策刪除後評價仍在**：feedback 快照不得引用 session。→ Task 3 測試（快照欄位完整、刪 session 不影響）。
4. **翻頁途中有新評價**：游標以 `(createdAt, id)` 排序，新評價不得讓下一頁重複或漏掉。→ Task 5 測試。
5. **mobile 對話重開（conversationLost）後對舊訊息評價**：必須用訊息自己的 `conversationId`，不可用目前對話 id。→ Task 7 測試。

---

## File Structure

**Server**
- Modify `server/src/modules/conversation/conversation.types.ts`：`ReplyTrace`、`ReplyRecord`、`Session.replies`、`TurnResult.replyId`。
- Modify `server/src/modules/conversation/agent-service.types.ts`：`AgentTurnResult.trace`。
- Create `server/src/modules/conversation/reply-record.ts`：記錄／查找回覆、把檢索片段轉成 trace。
- Modify `server/src/modules/conversation/conversation.agent.ts`：`runTurn` 記錄回覆並回傳 `replyId`。
- Modify `server/src/modules/conversation/conversation.controller.ts`：建立對話的回應帶 `replyId`。
- Modify `server/src/modules/conversation/tool-loop.ts`：`onLLMResult` 掛勾。
- Modify `server/src/modules/conversation/agent.agent-service.ts`：工具序列與模型 trace。
- Modify `server/src/modules/knowledge/knowledge.agent-service.ts`：檢索 trace。
- Create `server/src/modules/feedback/feedback.types.ts`、`feedback.store.ts`、`feedback.schema.ts`、`feedback.controller.ts`、`feedback.admin.controller.ts`。
- Modify `server/src/modules/conversation/conversation.routes.ts`、`server/src/modules/admin/admin.routes.ts`、`server/src/modules/admin/admin.controller.ts`（租戶刪除級聯）、`server/src/index.ts`（init + 每日清除）、`server/src/config/env.ts`。
- Modify `server/prisma/schema.prisma`；Create `server/db/migrations/0020_reply_feedback.sql`。
- Modify `shared/src/index.ts`：`FeedbackRating`、`FeedbackReason`、`ReplyFeedbackInput`。

**Client**：Create `client/src/FeedbackButtons.tsx`（＋test）；Modify `client/src/api.ts`、`client/src/App.tsx`、`client/src/i18n.ts`、`client/src/index.css`。

**Mobile**：Modify `mobile/packages/app-core/src/api/types.ts`、`api/endpoints.ts`、`chat/types.ts`、`chat/chatReducer.ts`、`chat/ChatProvider.tsx`、`chat/MessageBubble.tsx`；Create `chat/FeedbackSheet.tsx`。

**Admin**：Create `admin/src/pages/tabs/FeedbackTab.tsx`（＋test）；Modify `admin/src/api.ts`、`admin/src/pages/TenantDetailPage.tsx`、`admin/src/pages/tabs/KnowledgeTab.tsx`。

**Docs**：`server/.env.example`、`DEPLOY.zeabur.md`。

---

### Task 1: 回覆紀錄與 replyId

**Files:**
- Modify: `shared/src/index.ts`（檔尾）
- Modify: `server/src/modules/conversation/conversation.types.ts`
- Modify: `server/src/modules/conversation/agent-service.types.ts:22-33`
- Create: `server/src/modules/conversation/reply-record.ts`
- Modify: `server/src/modules/conversation/conversation.agent.ts:86-115`
- Modify: `server/src/modules/conversation/conversation.controller.ts:31-43`
- Test: `server/tests/reply-record.test.ts`

**Interfaces:**
- Produces:
  - `ReplyTraceChunk { rank: number; id: string; title: string; url?: string; score?: number; excerpt: string }`
  - `ReplyTrace { model?: string; retrieval?: { query: string; poolSize: number; usedTables: boolean; chunks: ReplyTraceChunk[] }; tools?: { name: string; ok: boolean }[]; reportId?: string }`
  - `ReplyRecord { id: string; question: string; answer: string; serviceId: string; at: string; trace?: ReplyTrace }`
  - `Session.replies?: ReplyRecord[]`、`TurnResult.replyId?: string`、`AgentTurnResult.trace?: ReplyTrace`
  - `recordReply(session: Session, input: { question: string; answer: string; serviceId: string; trace?: ReplyTrace }): ReplyRecord`
  - `findReply(session: Session, replyId: string): ReplyRecord | undefined`
  - `traceChunks(chunks: KnowledgeChunk[]): ReplyTraceChunk[]`
  - `MAX_REPLY_RECORDS = 20`、`TRACE_EXCERPT_CHARS = 300`
  - shared：`FeedbackRating = 'up' | 'down'`、`FeedbackReason = 'wrong' | 'not_answered' | 'outdated' | 'inappropriate' | 'other'`、`ReplyFeedbackInput { rating: FeedbackRating; reason?: FeedbackReason; comment?: string }`

- [ ] **Step 1: Write the failing test**

`server/tests/reply-record.test.ts`：

```ts
/** 回覆紀錄：每輪 AI 回覆發 replyId，session 只留最近 20 則，trace 由服務提供。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import * as llmModule from '@/lib/llm';
import * as agent from '@/modules/conversation/conversation.agent';
import { conversationStore } from '@/modules/conversation/conversation.store';
import type { TurnResult } from '@/modules/conversation/conversation.types';
import { intentRouter } from '@/modules/conversation/intent-router';
import { findReply, MAX_REPLY_RECORDS, recordReply, traceChunks } from '@/modules/conversation/reply-record';
import { serviceRegistry } from '@/modules/conversation/service.registry';

afterEach(() => jest.restoreAllMocks());

describe('recordReply / findReply', () => {
  it('只保留最近 MAX_REPLY_RECORDS 則，最舊的被擠出', () => {
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const ids = Array.from({ length: MAX_REPLY_RECORDS + 2 }, (_, i) =>
      recordReply(session, { question: `q${i}`, answer: `a${i}`, serviceId: 'knowledge' }).id,
    );
    expect(session.replies).toHaveLength(MAX_REPLY_RECORDS);
    expect(findReply(session, ids[0])).toBeUndefined();
    expect(findReply(session, ids.at(-1)!)?.answer).toBe(`a${MAX_REPLY_RECORDS + 1}`);
  });

  it('traceChunks 標名次並把內容截成 300 字節錄', () => {
    const out = traceChunks([{ id: 'c1', title: 'T', url: 'https://x', score: 0.9, content: 'x'.repeat(400) }]);
    expect(out).toEqual([{ rank: 1, id: 'c1', title: 'T', url: 'https://x', score: 0.9, excerpt: 'x'.repeat(300) }]);
  });
});

describe('runTurn', () => {
  function stubTurn(reply: string) {
    jest.spyOn(llmModule, 'getLLMProvider').mockReturnValue({
      name: 'mock',
      createMessage: jest.fn().mockResolvedValue({ text: '[]', toolCalls: [], stopReason: 'end_turn', model: 'm', keySource: 'platform' }),
    } as never);
    jest.spyOn(intentRouter, 'route').mockResolvedValue({ serviceId: 'knowledge', viaLLM: false } as never);
    jest.spyOn(serviceRegistry, 'get').mockReturnValue({
      id: 'knowledge',
      sticky: false,
      handleTurn: jest.fn().mockResolvedValue({ reply, trace: { model: 'test-model' } }),
    } as never);
  }

  it('有回覆時記錄問答、服務與 trace，回傳 replyId', async () => {
    stubTurn('請假規定如下');
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '請假規定？');
    expect(turn.replyId).toBeDefined();
    expect(findReply(session, turn.replyId!)).toMatchObject({
      question: '請假規定？',
      answer: '請假規定如下',
      serviceId: 'knowledge',
      trace: { model: 'test-model' },
    });
  });

  it('沒有回覆文字時不記錄、不帶 replyId', async () => {
    stubTurn('');
    const session = conversationStore.create('default', 'kevin', 'leave-request');
    const turn = await agent.runTurn(session, '嗨');
    expect(turn.replyId).toBeUndefined();
    expect(session.replies ?? []).toHaveLength(0);
  });
});

it('建立對話時帶第一則訊息，回應含 replyId', async () => {
  jest.spyOn(agent, 'runTurn').mockResolvedValue({
    reply: '好的', status: 'collecting', values: {}, suggestions: [], replyId: 'r-1',
  } as TurnResult);
  const login = await request(createApp()).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  const res = await request(createApp())
    .post('/api/conversations')
    .set('Authorization', `Bearer ${login.body.data.accessToken}`)
    .send({ message: '你好' });
  expect(res.status).toBe(201);
  expect(res.body.data.replyId).toBe('r-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/reply-record.test.ts`
Expected: FAIL，`Cannot find module '@/modules/conversation/reply-record'`。

- [ ] **Step 3: Add shared types**

`shared/src/index.ts` 檔尾加：

```ts
// ---- AI 回覆回饋 ----
export type FeedbackRating = 'up' | 'down';
export type FeedbackReason = 'wrong' | 'not_answered' | 'outdated' | 'inappropriate' | 'other';
/** 使用者送出評價的內容；reason／comment 只在 down 時有效 */
export interface ReplyFeedbackInput {
  rating: FeedbackRating;
  reason?: FeedbackReason;
  comment?: string;
}
```

- [ ] **Step 4: Add server types**

`server/src/modules/conversation/conversation.types.ts`：在 `Session` 介面之前加入：

```ts
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
```

在 `Session` 介面 `pendingAction?: PendingAction;` 之後加：

```ts
  /** 最近 MAX_REPLY_RECORDS 則可評價的回覆（見 reply-record.ts） */
  replies?: ReplyRecord[];
```

在 `TurnResult` 介面 `blocks?: DisplayBlock[];` 之後加：

```ts
  /** 本則回覆的編號（可評價）；沒有回覆文字時不帶 */
  replyId?: string;
```

`server/src/modules/conversation/agent-service.types.ts`：`AgentTurnResult` 的 `blocks?: DisplayBlock[];` 之後加（並在檔頭補 `import type { ReplyTrace } from './conversation.types';`，若該檔已從 `./conversation.types` 匯入則併入同一行）：

```ts
  /** 回覆的產生紀錄（檢索片段、工具序列、模型），供回饋診斷 */
  trace?: ReplyTrace;
```

- [ ] **Step 5: Create reply-record.ts**

`server/src/modules/conversation/reply-record.ts`：

```ts
/**
 * 可評價的回覆紀錄。replyId 由伺服器發、問答由伺服器記：評價 API 只收 replyId，
 * 後台看到的一定是 AI 真正說過的話（前台送不進任意文字）。
 * 只留最近 MAX_REPLY_RECORDS 則：session 以 JSON 整包存放，trace 含片段節錄，要控制大小。
 */
import { randomUUID } from 'node:crypto';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';
import type { ReplyRecord, ReplyTrace, ReplyTraceChunk, Session } from './conversation.types';

export const MAX_REPLY_RECORDS = 20;
export const TRACE_EXCERPT_CHARS = 300;

export function recordReply(
  session: Session,
  input: { question: string; answer: string; serviceId: string; trace?: ReplyTrace },
): ReplyRecord {
  const record: ReplyRecord = {
    id: randomUUID(),
    question: input.question,
    answer: input.answer,
    serviceId: input.serviceId,
    at: new Date().toISOString(),
    ...(input.trace ? { trace: input.trace } : {}),
  };
  session.replies = [...(session.replies ?? []), record].slice(-MAX_REPLY_RECORDS);
  return record;
}

export function findReply(session: Session, replyId: string): ReplyRecord | undefined {
  return session.replies?.find((r) => r.id === replyId);
}

/** 檢索片段 → trace：留節錄而非只留 id，文件事後被改掉或刪除仍能判斷模型當時看到什麼 */
export function traceChunks(chunks: KnowledgeChunk[]): ReplyTraceChunk[] {
  return chunks.map((c, i) => ({
    rank: i + 1,
    id: c.id,
    title: c.title,
    ...(c.url ? { url: c.url } : {}),
    ...(c.score !== undefined ? { score: c.score } : {}),
    excerpt: c.content.slice(0, TRACE_EXCERPT_CHARS),
  }));
}
```

- [ ] **Step 6: Record replies in runTurn**

`server/src/modules/conversation/conversation.agent.ts`：檔頭加 `import { recordReply } from './reply-record';`。把 `runTurn` 內

```ts
  const { reply, report, pendingAction, blocks } = await service.handleTurn(session, userText, llm);
```

改為

```ts
  const { reply, report, pendingAction, blocks, trace } = await service.handleTurn(session, userText, llm);
```

並把

```ts
  const suggestions = await generateSuggestions(llm, session, reply);
  conversationStore.save(session); // flush 本輪變更（values/status/messages/submission）
  return {
    reply,
```

改為

```ts
  const suggestions = await generateSuggestions(llm, session, reply);
  // 有回覆文字才可評價；報告 id 併進 trace，後台從回饋可追到那份報告
  const replyTrace = report ? { ...(trace ?? {}), reportId: report.id } : trace;
  const record = reply
    ? recordReply(session, { question: userText, answer: reply, serviceId: service.id, trace: replyTrace })
    : undefined;
  conversationStore.save(session); // flush 本輪變更（values/status/messages/submission/replies）
  return {
    reply,
    ...(record ? { replyId: record.id } : {}),
```

- [ ] **Step 7: Return replyId from start**

`server/src/modules/conversation/conversation.controller.ts` 的 `start` 回應物件，在 `suggestions: turn?.suggestions ?? [],` 之後加：

```ts
        ...(turn?.replyId ? { replyId: turn.replyId } : {}),
```

（`sendMessage` 已回傳整個 `TurnResult`，不需改。）

- [ ] **Step 8: Run tests**

Run: `cd server && npx jest tests/reply-record.test.ts && npx tsc --noEmit -p .`
Expected: PASS（4 tests），typecheck 無錯誤。

- [ ] **Step 9: Run the full server suite**

Run: `cd server && npx jest`
Expected: 全數通過（既有測試不應受影響：`replyId` 只是新增欄位）。

- [ ] **Step 10: Commit**

```bash
git add shared/src/index.ts server/src/modules/conversation/conversation.types.ts server/src/modules/conversation/agent-service.types.ts server/src/modules/conversation/reply-record.ts server/src/modules/conversation/conversation.agent.ts server/src/modules/conversation/conversation.controller.ts server/tests/reply-record.test.ts
git commit -m "feat(conversation): AI 回覆發 replyId 並記錄可評價的問答

- 新增 ReplyRecord／ReplyTrace 型別，session 保留最近 20 則回覆
- runTurn 有回覆文字時記錄問答、服務與 trace，回傳 replyId；報告 id 併入 trace
- 建立對話帶第一則訊息時回應含 replyId
- shared 新增回饋評價型別

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 知識庫與智慧代理的 trace

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.agent-service.ts:183-258`
- Modify: `server/src/modules/conversation/tool-loop.ts`
- Modify: `server/src/modules/conversation/agent.agent-service.ts`（`handleTurn`）
- Test: `server/tests/reply-trace.test.ts`

**Interfaces:**
- Consumes: `traceChunks` (Task 1)、`ReplyTrace` (Task 1)
- Produces: `ToolLoopConfig.onLLMResult?(result: LLMResult): void`；knowledge／agent 的 `AgentTurnResult.trace`

- [ ] **Step 1: Write the failing test**

`server/tests/reply-trace.test.ts`：

```ts
/** 回覆 trace：知識庫記檢索片段與模型；智慧代理記工具序列與模型。 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: texts.length * 10 }),
  }),
}));

import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import { _setIndexForTest } from '@/modules/knowledge/retriever.staticIndex';

function makeSession(partial: Partial<Session>): Session {
  return {
    id: 's-trace', tenantId: 'trace-test', userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', messages: [], createdAt: new Date().toISOString(), ...partial,
  };
}

const usage = { inputTokens: 1, outputTokens: 1 };
const result = (over: Partial<LLMResult>): LLMResult => ({
  text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...over,
});

afterEach(() => _setIndexForTest('trace-test', null));

it('知識庫：trace 含檢索問句、候選數、片段（名次、節錄）與模型', async () => {
  const index: KnowledgeIndexFile = {
    generatedAt: '2026-07-01T00:00:00Z', model: 'test', source: 'https://example.com',
    chunks: [{ id: 'A', url: 'https://example.com/a', title: 'HyCMS', text: 'HyCMS 內容管理', visibilityScopes: ['kb:public'], vector: [1, 0, 0] }],
  };
  _setIndexForTest('trace-test', index);
  const llm: LLMProvider = { name: 'mock', createMessage: jest.fn().mockResolvedValue(result({ text: 'HyCMS 是平台' })) };
  const res = await knowledgeAgentService.handleTurn(makeSession({}), 'HyCMS 是什麼？', llm);
  expect(res.trace).toMatchObject({
    model: 'test-model',
    retrieval: { query: 'HyCMS 是什麼？', usedTables: false, chunks: [{ rank: 1, id: 'A', title: 'HyCMS', url: 'https://example.com/a', excerpt: 'HyCMS 內容管理' }] },
  });
  expect(res.trace?.retrieval?.poolSize).toBeGreaterThanOrEqual(1);
});

it('知識庫：查無資料時 chunks 為空陣列（這本身就是診斷依據）', async () => {
  const llm: LLMProvider = { name: 'mock', createMessage: jest.fn() };
  const res = await knowledgeAgentService.handleTurn(makeSession({}), '完全不相干', llm);
  expect(res.trace?.retrieval?.chunks).toEqual([]);
  expect(res.trace?.model).toBeUndefined();
});

it('智慧代理：trace 依序記錄工具名稱與成敗，以及最後一次的模型', async () => {
  let i = 0;
  const scripted = [
    result({ toolCalls: [{ id: 't1', name: 'oa_getLeaveBalance', input: { userId: 'kevin' } }], stopReason: 'tool_use' }),
    result({ toolCalls: [{ id: 't2', name: 'nope_tool', input: {} }], stopReason: 'tool_use' }),
    result({ text: '完成', model: 'final-model' }),
  ];
  const llm: LLMProvider = { name: 'fake', createMessage: async () => scripted[Math.min(i++, scripted.length - 1)] };
  const res = await agentAgentService.handleTurn(makeSession({ tenantId: 'default', activeServiceId: 'agent' }), '查特休', llm);
  expect(res.trace).toEqual({
    model: 'final-model',
    tools: [{ name: 'oa.getLeaveBalance', ok: true }, { name: 'nope_tool', ok: false }],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/reply-trace.test.ts`
Expected: FAIL，`res.trace` 為 undefined。

- [ ] **Step 3: Knowledge trace**

`server/src/modules/knowledge/knowledge.agent-service.ts`：檔頭加 `import { traceChunks } from '@/modules/conversation/reply-record';`。在 `let reply: string;` 下一行加：

```ts
    // 回饋診斷用：實際作答的模型（查無資料時沒有呼叫 LLM，維持 undefined）
    let model: string | undefined;
```

在 `usageStore.recordLLMUsage(session.tenantId, result);` 之後加：

```ts
        model = result.model;
```

把結尾的 `return { reply };` 改為：

```ts
    return {
      reply,
      trace: {
        ...(model ? { model } : {}),
        retrieval: { query, poolSize: pool.length, usedTables: tableContext !== '', chunks: traceChunks(chunks) },
      },
    };
```

- [ ] **Step 4: Tool-loop hook**

`server/src/modules/conversation/tool-loop.ts`：`ToolLoopConfig` 的 `maxIterations?: number;` 之後加：

```ts
  /** 每次 LLM 呼叫完成後通知（含收尾呼叫）；服務據此記錄 trace 用的模型名稱 */
  onLLMResult?(result: LLMResult): void;
```

`runToolLoop` 迴圈內 `usageStore.recordLLMUsage(session.tenantId, result);` 之後加 `cfg.onLLMResult?.(result);`；`wrapUp` 內 `usageStore.recordLLMUsage(session.tenantId, result);` 之後同樣加 `cfg.onLLMResult?.(result);`。

- [ ] **Step 5: Agent trace**

`server/src/modules/conversation/agent.agent-service.ts` 的 `handleTurn`：在 `let proposedThisTurn = false;` 之後加：

```ts
    // 回饋診斷用：本輪依序呼叫的工具（只記名稱與成敗）與最後一次的模型
    const toolTrace: { name: string; ok: boolean }[] = [];
    let model: string | undefined;
```

`runToolLoop(llm, session, { ... })` 的設定物件加一行 `onLLMResult: (r) => { model = r.model; },`。

`dispatchTool` 內三個出口各記一筆：
- `if (!realId) {` 區塊內，`return` 前加 `toolTrace.push({ name, ok: false });`
- 寫入提議成功（`return JSON.stringify({ ok: true, proposed: true, ...`）前加 `toolTrace.push({ name: realId, ok: true });`；「一次只能提議一個寫入動作」的 `return` 前加 `toolTrace.push({ name: realId, ok: false });`
- 讀取工具成功的 `return JSON.stringify(shown ? ...` 前加 `toolTrace.push({ name: realId, ok: true });`
- `catch (err) {` 區塊內 `return` 前加 `toolTrace.push({ name: realId, ok: false });`

最後回傳物件加：

```ts
      trace: { ...(model ? { model } : {}), ...(toolTrace.length > 0 ? { tools: toolTrace } : {}) },
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx jest tests/reply-trace.test.ts tests/agent-service.test.ts tests/knowledge-rag.test.ts tests/tool-loop.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/knowledge.agent-service.ts server/src/modules/conversation/tool-loop.ts server/src/modules/conversation/agent.agent-service.ts server/tests/reply-trace.test.ts
git commit -m "feat(conversation): 知識庫與智慧代理回覆附上診斷用 trace

- 知識庫記錄檢索問句、候選數、交給模型的片段（名次、分數、節錄）與模型
- tool-loop 新增 onLLMResult 掛勾
- 智慧代理依序記錄工具名稱與成敗，以及最後一次的模型

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 評價 store（file／db、保存期限、級聯清除）

**Files:**
- Create: `server/src/modules/feedback/feedback.types.ts`
- Create: `server/src/modules/feedback/feedback.store.ts`
- Modify: `server/prisma/schema.prisma`（檔尾）
- Create: `server/db/migrations/0020_reply_feedback.sql`
- Modify: `server/src/config/env.ts`（`REPORT_TIMEZONE` 附近）
- Modify: `server/src/index.ts`（init 與每日排程）
- Modify: `server/src/modules/admin/admin.controller.ts:230-237`（租戶刪除級聯）
- Test: `server/tests/feedback-store.test.ts`

**Interfaces:**
- Consumes: `ReplyRecord`, `ReplyTrace` (Task 1)
- Produces:
  - `FEEDBACK_REASONS`, `FeedbackReason`, `FeedbackRating`, `FeedbackStatus`, `ReplyFeedback`, `FeedbackFilter { rating?; serviceId?; reason?; status? }`, `FeedbackStats`
  - `feedbackStore.upsert(input: { tenantId: string; userId: string; sessionId: string; reply: ReplyRecord; rating: FeedbackRating; reason?: FeedbackReason; comment?: string }): ReplyFeedback`
  - `feedbackStore.remove(tenantId: string, sessionId: string, replyId: string, userId: string): void`
  - `feedbackStore.getById(tenantId: string, id: string): ReplyFeedback | undefined`
  - `feedbackStore.setStatus(tenantId: string, id: string, status: FeedbackStatus, resolutionNote?: string): ReplyFeedback | undefined`
  - `feedbackStore.list(tenantId: string, filter: FeedbackFilter, page: { before?: string; limit: number }): { items: ReplyFeedback[]; nextCursor: string | null }`
  - `feedbackStore.stats(tenantId: string, days: number, now?: number): FeedbackStats`
  - `feedbackStore.cleanupExpired(now?: number): number`, `feedbackStore.purgeTenant(tenantId)`, `feedbackStore.clear()`
  - `initFeedbackStore(): Promise<void>`, `feedbackToRow`, `feedbackFromRow`
  - `env.FEEDBACK_RETENTION_DAYS: number`

- [ ] **Step 1: Write the failing test**

`server/tests/feedback-store.test.ts`：

```ts
import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import { feedbackFromRow, feedbackStore, feedbackToRow } from '@/modules/feedback/feedback.store';

const reply = (id: string, serviceId = 'knowledge'): ReplyRecord => ({
  id, question: `q-${id}`, answer: `a-${id}`, serviceId, at: '2026-10-13T00:00:00.000Z',
  trace: { model: 'm', retrieval: { query: 'q', poolSize: 1, usedTables: false, chunks: [] } },
});
const base = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

afterEach(() => feedbackStore.clear());

describe('upsert', () => {
  it('第一次評價建立快照（問答、服務、trace），狀態 open', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'wrong', comment: '日期錯了' });
    expect(f).toMatchObject({
      tenantId: 't1', userId: 'u1', sessionId: 's1', replyId: 'r1', serviceId: 'knowledge',
      question: 'q-r1', answer: 'a-r1', rating: 'down', reason: 'wrong', comment: '日期錯了', status: 'open',
    });
    expect(f.trace?.retrieval?.chunks).toEqual([]);
  });

  it('同一人對同一則回覆只有一筆；down 改 up 清掉原因與說明', () => {
    const first = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'wrong', comment: 'x' });
    const second = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    expect(second.id).toBe(first.id);
    expect(second.reason).toBeUndefined();
    expect(second.comment).toBeUndefined();
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toHaveLength(1);
  });

  it('改評把已處理重設為 open，並清掉處理說明', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down' });
    feedbackStore.setStatus('t1', f.id, 'resolved', '已修正');
    const again = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'outdated' });
    expect(again.status).toBe('open');
    expect(again.resolutionNote).toBeUndefined();
  });

  it('改評不重抓快照：沿用第一次的問答', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    const again = feedbackStore.upsert({ ...base, reply: { ...reply('r1'), answer: '被改過的回答' }, rating: 'down' });
    expect(again.answer).toBe('a-r1');
  });

  it('不同使用者對同一則回覆各自一筆', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    feedbackStore.upsert({ ...base, userId: 'u2', reply: reply('r1'), rating: 'down' });
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toHaveLength(2);
  });
});

describe('remove / setStatus', () => {
  it('撤回刪除該筆；不存在時不丟錯', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    feedbackStore.remove('t1', 's1', 'r1', 'u1');
    feedbackStore.remove('t1', 's1', 'r1', 'u1');
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
  });

  it('setStatus 跨租戶查無回 undefined', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down' });
    expect(feedbackStore.setStatus('other', f.id, 'resolved')).toBeUndefined();
    expect(feedbackStore.setStatus('t1', f.id, 'resolved', '已補文件')).toMatchObject({ status: 'resolved', resolutionNote: '已補文件' });
  });
});

describe('list', () => {
  it('依建立時間新→舊，游標翻頁；翻頁途中新增的評價不讓下一頁重複', () => {
    for (let i = 0; i < 12; i++) feedbackStore.upsert({ ...base, reply: reply(`r${i}`), rating: 'down' });
    const p1 = feedbackStore.list('t1', {}, { limit: 10 });
    expect(p1.items[0].replyId).toBe('r11');
    feedbackStore.upsert({ ...base, reply: reply('new'), rating: 'down' });
    const p2 = feedbackStore.list('t1', {}, { before: p1.nextCursor!, limit: 10 });
    expect(p2.items.map((f) => f.replyId)).toEqual(['r1', 'r0']);
    expect(p2.nextCursor).toBeNull();
  });

  it('依評價、服務、原因、狀態篩選', () => {
    feedbackStore.upsert({ ...base, reply: reply('a', 'knowledge'), rating: 'down', reason: 'wrong' });
    feedbackStore.upsert({ ...base, reply: reply('b', 'agent'), rating: 'down', reason: 'outdated' });
    feedbackStore.upsert({ ...base, reply: reply('c', 'knowledge'), rating: 'up' });
    const ids = (f: Parameters<typeof feedbackStore.list>[1]) => feedbackStore.list('t1', f, { limit: 50 }).items.map((x) => x.replyId);
    expect(ids({ rating: 'down' })).toEqual(['b', 'a']);
    expect(ids({ serviceId: 'knowledge' })).toEqual(['c', 'a']);
    expect(ids({ reason: 'outdated' })).toEqual(['b']);
    expect(ids({ status: 'resolved' })).toEqual([]);
  });
});

describe('stats', () => {
  it('期間內的總數、讚比例來源、各服務、原因分布與待處理倒讚', () => {
    feedbackStore.upsert({ ...base, reply: reply('a', 'knowledge'), rating: 'down', reason: 'wrong' });
    feedbackStore.upsert({ ...base, reply: reply('b', 'knowledge'), rating: 'up' });
    const c = feedbackStore.upsert({ ...base, reply: reply('c', 'agent'), rating: 'down', reason: 'wrong' });
    feedbackStore.setStatus('t1', c.id, 'resolved');
    const s = feedbackStore.stats('t1', 30);
    expect(s).toMatchObject({
      days: 30, total: 3, up: 1, down: 2, openDown: 1,
      byService: { knowledge: { up: 1, down: 1 }, agent: { up: 0, down: 1 } },
    });
    expect(s.byReason.wrong).toBe(2);
    expect(s.byReason.outdated).toBe(0);
  });

  it('超出期間的不計入', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    const in40days = Date.now() + 40 * 86_400_000;
    expect(feedbackStore.stats('t1', 30, in40days).total).toBe(0);
  });
});

describe('保存期限與級聯', () => {
  it('cleanupExpired 刪除 updatedAt 早於保存期限者', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    const later = Date.now() + 181 * 86_400_000;
    expect(feedbackStore.cleanupExpired(later)).toBe(1);
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
  });

  it('purgeTenant 只清該租戶', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    feedbackStore.upsert({ ...base, tenantId: 't2', reply: reply('a'), rating: 'up' });
    feedbackStore.purgeTenant('t1');
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
    expect(feedbackStore.list('t2', {}, { limit: 50 }).items).toHaveLength(1);
  });

  it('db row round-trip 保留完整快照', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    expect(feedbackFromRow(feedbackToRow(f))).toEqual(f);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/feedback-store.test.ts`
Expected: FAIL，`Cannot find module '@/modules/feedback/feedback.store'`。

- [ ] **Step 3: Env**

`server/src/config/env.ts`：在 `REPORT_TIMEZONE` 那一行之後加：

```ts
  // AI 回覆評價（含問答快照）的保存天數，依最後更新時間計算；每日清除一次
  FEEDBACK_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
```

- [ ] **Step 4: Types**

`server/src/modules/feedback/feedback.types.ts`：

```ts
import type { FeedbackRating, FeedbackReason } from '@hyagent/shared';
import type { ReplyTrace } from '@/modules/conversation/conversation.types';

export type { FeedbackRating, FeedbackReason };

/** 執行期清單（zod 與統計用）；必須與 shared 的 FeedbackReason 一致 */
export const FEEDBACK_REASONS = ['wrong', 'not_answered', 'outdated', 'inappropriate', 'other'] as const satisfies readonly FeedbackReason[];

export type FeedbackStatus = 'open' | 'resolved';

/** 一筆評價＋評價當下的回覆快照。快照與 session 分開保存：對話被清掉後評價仍在 */
export interface ReplyFeedback {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  replyId: string;
  serviceId: string;
  question: string;
  answer: string;
  trace?: ReplyTrace;
  rating: FeedbackRating;
  reason?: FeedbackReason;
  comment?: string;
  status: FeedbackStatus;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackFilter {
  rating?: FeedbackRating;
  serviceId?: string;
  reason?: FeedbackReason;
  status?: FeedbackStatus;
}

export interface FeedbackStats {
  days: number;
  total: number;
  up: number;
  down: number;
  /** 待處理的倒讚 */
  openDown: number;
  byService: Record<string, { up: number; down: number }>;
  byReason: Record<FeedbackReason, number>;
}
```

- [ ] **Step 5: Store**

`server/src/modules/feedback/feedback.store.ts`：

```ts
/**
 * AI 回覆評價 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND），寫法同 mcp.store。
 * db 後端：每筆一列（data jsonb 整包），tenant_id／updated_at 供清除查詢；開機載回保存期限內全部。
 * 統計與篩選都在記憶體算：保存期限內的量可控，且不必為每種篩選組合建索引。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import {
  FEEDBACK_REASONS,
  type FeedbackFilter,
  type FeedbackRating,
  type FeedbackReason,
  type FeedbackStats,
  type FeedbackStatus,
  type ReplyFeedback,
} from './feedback.types';

const DAY_MS = 86_400_000;
const STORE_FILE = dataFile('oa-agent-reply-feedback.json');
const items = new Map<string, ReplyFeedback>();
/** (tenant, session, reply, user) → id：同一人對同一則回覆只有一筆 */
const byKey = new Map<string, string>();
const writeQueue = new DbWriteQueue('reply-feedback');

const keyOf = (tenantId: string, sessionId: string, replyId: string, userId: string): string =>
  JSON.stringify([tenantId, sessionId, replyId, userId]);

// ---- row 映射（db 後端用；pure，供測試 round-trip）----

export interface FeedbackDbRow {
  id: string;
  tenantId: string;
  updatedAt: Date;
  data: unknown;
}

export function feedbackToRow(f: ReplyFeedback): FeedbackDbRow {
  return { id: f.id, tenantId: f.tenantId, updatedAt: new Date(f.updatedAt), data: JSON.parse(JSON.stringify(f)) };
}

export function feedbackFromRow(row: FeedbackDbRow): ReplyFeedback {
  return row.data as ReplyFeedback;
}

// ---- 持久化 ----

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...items.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist reply feedback');
  }
}

function index(f: ReplyFeedback): void {
  items.set(f.id, f);
  byKey.set(keyOf(f.tenantId, f.sessionId, f.replyId, f.userId), f.id);
}

function unindex(f: ReplyFeedback): void {
  items.delete(f.id);
  byKey.delete(keyOf(f.tenantId, f.sessionId, f.replyId, f.userId));
}

function save(f: ReplyFeedback): void {
  index(f);
  if (env.DATA_BACKEND !== 'db') {
    persistFile();
    return;
  }
  const row = feedbackToRow(f);
  const data = row.data as Prisma.InputJsonValue;
  writeQueue.enqueue(async (db) => {
    await db.replyFeedbackRow.upsert({
      where: { id: row.id },
      create: { id: row.id, tenantId: row.tenantId, updatedAt: row.updatedAt, data },
      update: { updatedAt: row.updatedAt, data },
    });
  });
}

function removeMany(targets: ReplyFeedback[]): void {
  if (targets.length === 0) return;
  for (const f of targets) unindex(f);
  if (env.DATA_BACKEND !== 'db') {
    persistFile();
    return;
  }
  const ids = targets.map((f) => f.id);
  writeQueue.enqueue(async (db) => {
    await db.replyFeedbackRow.deleteMany({ where: { id: { in: ids } } });
  });
}

// file 後端：模組載入即同步還原
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      for (const f of JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as ReplyFeedback[]) index(f);
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore reply feedback; starting empty');
  }
}

/** db 後端的開機載入（保存期限內全部）；file 後端為 no-op。必須在開始服務請求前 await。 */
export async function initFeedbackStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const since = new Date(Date.now() - env.FEEDBACK_RETENTION_DAYS * DAY_MS);
  const rows = await db.replyFeedbackRow.findMany({ where: { updatedAt: { gte: since } } });
  for (const r of rows) index(feedbackFromRow(r));
  logger.info({ count: items.size }, 'reply feedback restored from db');
}

// ---- 游標：(createdAt, id) 編成不透明字串。用 createdAt 而非 updatedAt：改評不會讓項目在翻頁中跳位 ----

function encodeCursor(f: ReplyFeedback): string {
  return Buffer.from(`${f.createdAt}|${f.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return createdAt && id ? { createdAt, id } : undefined;
}

/** 新→舊：createdAt desc，同時間以 id desc 決定順序 */
function newerFirst(a: ReplyFeedback, b: ReplyFeedback): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function matches(f: ReplyFeedback, filter: FeedbackFilter): boolean {
  return (
    (!filter.rating || f.rating === filter.rating) &&
    (!filter.serviceId || f.serviceId === filter.serviceId) &&
    (!filter.reason || f.reason === filter.reason) &&
    (!filter.status || f.status === filter.status)
  );
}

function tenantItems(tenantId: string): ReplyFeedback[] {
  return [...items.values()].filter((f) => f.tenantId === tenantId);
}

export const feedbackStore = {
  /**
   * 建立或更新評價。快照只在第一次建立時從 ReplyRecord 複製，之後改評不重抓。
   * 改評一律回到 open：管理員處理過的倒讚若被改評，代表有新的意見要看。
   */
  upsert(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    reply: ReplyRecord;
    rating: FeedbackRating;
    reason?: FeedbackReason;
    comment?: string;
  }): ReplyFeedback {
    const now = new Date().toISOString();
    const existingId = byKey.get(keyOf(input.tenantId, input.sessionId, input.reply.id, input.userId));
    const existing = existingId ? items.get(existingId) : undefined;
    const base: ReplyFeedback = existing ?? {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      replyId: input.reply.id,
      serviceId: input.reply.serviceId,
      question: input.reply.question,
      answer: input.reply.answer,
      ...(input.reply.trace ? { trace: input.reply.trace } : {}),
      rating: input.rating,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const { reason: _r, comment: _c, resolutionNote: _n, ...rest } = base;
    const next: ReplyFeedback = {
      ...rest,
      rating: input.rating,
      ...(input.rating === 'down' && input.reason ? { reason: input.reason } : {}),
      ...(input.rating === 'down' && input.comment ? { comment: input.comment } : {}),
      status: 'open',
      updatedAt: now,
    };
    save(next);
    return next;
  },

  remove(tenantId: string, sessionId: string, replyId: string, userId: string): void {
    const id = byKey.get(keyOf(tenantId, sessionId, replyId, userId));
    const f = id ? items.get(id) : undefined;
    if (f) removeMany([f]);
  },

  getById(tenantId: string, id: string): ReplyFeedback | undefined {
    const f = items.get(id);
    return f && f.tenantId === tenantId ? f : undefined;
  },

  setStatus(tenantId: string, id: string, status: FeedbackStatus, resolutionNote?: string): ReplyFeedback | undefined {
    const f = feedbackStore.getById(tenantId, id);
    if (!f) return undefined;
    const { resolutionNote: _n, ...rest } = f;
    const next: ReplyFeedback = {
      ...rest,
      status,
      ...(resolutionNote ? { resolutionNote } : {}),
      updatedAt: new Date().toISOString(),
    };
    save(next);
    return next;
  },

  list(
    tenantId: string,
    filter: FeedbackFilter,
    { before, limit }: { before?: string; limit: number },
  ): { items: ReplyFeedback[]; nextCursor: string | null } {
    const cursor = before ? decodeCursor(before) : undefined;
    const all = tenantItems(tenantId)
      .filter((f) => matches(f, filter))
      .sort(newerFirst)
      .filter((f) => !cursor || f.createdAt < cursor.createdAt || (f.createdAt === cursor.createdAt && f.id < cursor.id));
    const page = all.slice(0, limit);
    return { items: page, nextCursor: all.length > limit ? encodeCursor(page[page.length - 1]) : null };
  },

  stats(tenantId: string, days: number, now = Date.now()): FeedbackStats {
    const since = now - days * DAY_MS;
    const stats: FeedbackStats = {
      days,
      total: 0,
      up: 0,
      down: 0,
      openDown: 0,
      byService: {},
      byReason: Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, 0])) as Record<FeedbackReason, number>,
    };
    for (const f of tenantItems(tenantId)) {
      const t = Date.parse(f.updatedAt);
      if (t < since || t > now) continue;
      stats.total += 1;
      stats[f.rating] += 1;
      const svc = (stats.byService[f.serviceId] ??= { up: 0, down: 0 });
      svc[f.rating] += 1;
      if (f.rating === 'down') {
        if (f.status === 'open') stats.openDown += 1;
        if (f.reason) stats.byReason[f.reason] += 1;
      }
    }
    return stats;
  },

  /** 刪除 updatedAt 早於保存期限者；回傳刪除筆數 */
  cleanupExpired(now = Date.now()): number {
    const cutoff = now - env.FEEDBACK_RETENTION_DAYS * DAY_MS;
    const expired = [...items.values()].filter((f) => Date.parse(f.updatedAt) < cutoff);
    removeMany(expired);
    return expired.length;
  },

  /** 刪租戶級聯清理 */
  purgeTenant(tenantId: string): void {
    removeMany(tenantItems(tenantId));
  },

  /** 清空（測試用） */
  clear(): void {
    items.clear();
    byKey.clear();
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.replyFeedbackRow.deleteMany({});
      });
      return;
    }
    persistFile();
  },
};
```

- [ ] **Step 6: Prisma model and migration**

`server/prisma/schema.prisma` 檔尾加：

```prisma
model ReplyFeedbackRow {
  id        String   @id
  tenantId  String   @map("tenant_id")
  updatedAt DateTime @map("updated_at")
  /// 整個 ReplyFeedback（評價＋問答快照＋trace）
  data      Json

  @@index([tenantId])
  @@index([updatedAt])
  @@map("reply_feedback")
}
```

`server/db/migrations/0020_reply_feedback.sql`：

```sql
-- 0020: AI 回覆評價（含問答快照）。
-- 與 server/prisma/schema.prisma 的 ReplyFeedbackRow 對應；經 Supabase SQL Editor 套用，必須早於帶此版本部署。
-- 每筆評價一列；data = ReplyFeedback 整包。updated_at 供保存期限清除（FEEDBACK_RETENTION_DAYS）。
create table if not exists reply_feedback (
  id          text primary key,
  tenant_id   text not null,
  updated_at  timestamptz not null,
  data        jsonb not null
);

create index if not exists reply_feedback_tenant_idx on reply_feedback (tenant_id);
create index if not exists reply_feedback_updated_at_idx on reply_feedback (updated_at);
```

Run: `cd server && npm run db:generate`
Expected: Prisma Client 重新產生，含 `replyFeedbackRow`。

- [ ] **Step 7: Boot, daily cleanup, tenant cascade**

`server/src/index.ts`：
- 匯入 `import { feedbackStore, initFeedbackStore } from '@/modules/feedback/feedback.store';`
- 在 `Promise.all([...])` 的 init 清單中加入 `initFeedbackStore(),`
- 在每日 `setInterval` 回呼內 `cleanupExpiredSessions()...` 之後加：

```ts
    try {
      const removed = feedbackStore.cleanupExpired();
      if (removed > 0) logger.info({ removed }, 'expired reply feedback cleaned up');
    } catch (err) {
      logger.warn({ err }, 'reply feedback cleanup failed');
    }
```

- 在 `setInterval` 之前（開機）同樣呼叫一次 `feedbackStore.cleanupExpired();`

`server/src/modules/admin/admin.controller.ts`：匯入 `import { feedbackStore } from '@/modules/feedback/feedback.store';`，在 `mcpStore.purgeTenant(id);` 之後加 `feedbackStore.purgeTenant(id);`。

- [ ] **Step 8: Run tests**

Run: `cd server && npx jest tests/feedback-store.test.ts tests/tenant-delete-cascade.test.ts && npx tsc --noEmit -p .`
Expected: PASS；typecheck 無錯誤。

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/feedback/feedback.types.ts server/src/modules/feedback/feedback.store.ts server/prisma/schema.prisma server/db/migrations/0020_reply_feedback.sql server/src/config/env.ts server/src/index.ts server/src/modules/admin/admin.controller.ts server/tests/feedback-store.test.ts
git commit -m "feat(feedback): 新增 AI 回覆評價 store

- 評價連同問答快照與 trace 存放，同一人對同一則回覆只有一筆，改評回到待處理
- 支援 file／db 後端，新增 reply_feedback 資料表與 0020 migration
- 依 FEEDBACK_RETENTION_DAYS（預設 180）每日清除，刪除租戶時級聯清除
- 提供篩選、游標分頁與期間統計

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 使用者評價 API

**Files:**
- Create: `server/src/modules/feedback/feedback.schema.ts`
- Create: `server/src/modules/feedback/feedback.controller.ts`
- Modify: `server/src/modules/conversation/conversation.routes.ts`
- Test: `server/tests/feedback-api.test.ts`

**Interfaces:**
- Consumes: `findReply` (Task 1)、`feedbackStore.upsert/remove` (Task 3)、`conversationStore.get(id, tenantId, userId)`（不存在／跨租戶 404、他人 403）
- Produces:
  - `PUT /api/conversations/:id/replies/:replyId/feedback` body `ReplyFeedbackInput` → `200 { data: { rating, reason?, comment? } }`
  - `DELETE /api/conversations/:id/replies/:replyId/feedback` → `204`
  - `replyParamSchema`, `putFeedbackSchema`, `PutFeedbackInput`

- [ ] **Step 1: Write the failing test**

`server/tests/feedback-api.test.ts`：

```ts
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { recordReply } from '@/modules/conversation/reply-record';
import { feedbackStore } from '@/modules/feedback/feedback.store';

const app = createApp();

async function tokenFor(username: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

async function setup() {
  const token = await tokenFor('kevin');
  const start = await request(app).post('/api/conversations').set('Authorization', `Bearer ${token}`).send({});
  const sessionId = start.body.data.id as string;
  const session = conversationStore.get(sessionId, 'default', 'kevin');
  const reply = recordReply(session, { question: '特休幾天？', answer: '7 天', serviceId: 'knowledge' });
  conversationStore.save(session);
  const url = `/api/conversations/${sessionId}/replies/${reply.id}/feedback`;
  return { token, sessionId, reply, url };
}

afterEach(() => feedbackStore.clear());

it('倒讚附原因與說明 → 寫入快照；回應不含快照', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`)
    .send({ rating: 'down', reason: 'wrong', comment: '  應該是 10 天  ' });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ rating: 'down', reason: 'wrong', comment: '應該是 10 天' });
  const [f] = feedbackStore.list('default', {}, { limit: 10 }).items;
  expect(f).toMatchObject({ userId: 'kevin', question: '特休幾天？', answer: '7 天', rating: 'down' });
});

it('按讚帶原因 → 422', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'up', reason: 'wrong' });
  expect(res.status).toBe(422);
});

it('說明超過 500 字 → 422', async () => {
  const { token, url } = await setup();
  const res = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'down', comment: 'x'.repeat(501) });
  expect(res.status).toBe(422);
});

it('replyId 不在對話中（含已被擠出最近 20 則）→ 404', async () => {
  const { token, sessionId } = await setup();
  const res = await request(app)
    .put(`/api/conversations/${sessionId}/replies/00000000-0000-4000-8000-000000000000/feedback`)
    .set('Authorization', `Bearer ${token}`).send({ rating: 'up' });
  expect(res.status).toBe(404);
  expect(res.body.error.message).toContain('這則回覆已無法評價');
});

it('他人的對話不能評價（與既有對話 API 一致回 403）', async () => {
  const { url } = await setup();
  const other = await tokenFor('hyweb');
  const res = await request(app).put(url).set('Authorization', `Bearer ${other}`).send({ rating: 'up' });
  expect(res.status).toBe(403);
  expect(feedbackStore.list('default', {}, { limit: 10 }).items).toEqual([]);
});

it('撤回：204，重複撤回也 204', async () => {
  const { token, url } = await setup();
  await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ rating: 'up' });
  expect((await request(app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(204);
  expect((await request(app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(204);
  expect(feedbackStore.list('default', {}, { limit: 10 }).items).toEqual([]);
});

it('未登入 → 401', async () => {
  const { url } = await setup();
  expect((await request(app).put(url).send({ rating: 'up' })).status).toBe(401);
});
```

> `kevin` 與 `hyweb` 都在 default 租戶的開發名錄（`server/src/modules/user/user.directory.ts`）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/feedback-api.test.ts`
Expected: FAIL，PUT 回 404（路由不存在）。

- [ ] **Step 3: Schema**

`server/src/modules/feedback/feedback.schema.ts`：

```ts
import { z } from 'zod';
import { idParamSchema } from '@/modules/conversation/conversation.schema';
import { FEEDBACK_REASONS } from './feedback.types';

export const replyParamSchema = idParamSchema.extend({ replyId: z.string().uuid() });

export const putFeedbackSchema = z
  .object({
    rating: z.enum(['up', 'down']),
    reason: z.enum(FEEDBACK_REASONS).optional(),
    comment: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.rating === 'down' || (b.reason === undefined && b.comment === undefined), {
    message: '只有倒讚可以附原因與說明',
    path: ['rating'],
  });

export type PutFeedbackInput = z.infer<typeof putFeedbackSchema>;
```

- [ ] **Step 4: Controller**

`server/src/modules/feedback/feedback.controller.ts`：

```ts
/**
 * 使用者評價 AI 回覆。只收 replyId：問答由伺服器從 session 的回覆紀錄取出做快照，
 * 前台送不進任意文字。對話歸屬沿用 conversationStore.get（跨租戶 404、他人 403）。
 */
import type { Request, Response } from 'express';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { findReply } from '@/modules/conversation/reply-record';
import { AppError } from '@/utils/app-error';
import type { PutFeedbackInput } from './feedback.schema';
import { feedbackStore } from './feedback.store';

function principal(req: Request): { tenantId: string; userId: string } {
  return { tenantId: req.tenant?.id ?? 'default', userId: req.user?.sub ?? '' };
}

export const feedbackController = {
  async put(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = principal(req);
    const session = conversationStore.get(String(req.params.id), tenantId, userId);
    const reply = findReply(session, String(req.params.replyId));
    if (!reply) throw AppError.notFound('這則回覆已無法評價');
    const { rating, reason, comment } = req.body as PutFeedbackInput;
    const saved = feedbackStore.upsert({
      tenantId,
      userId,
      sessionId: session.id,
      reply,
      rating,
      ...(reason ? { reason } : {}),
      ...(comment ? { comment } : {}),
    });
    res.status(200).json({
      data: {
        rating: saved.rating,
        ...(saved.reason ? { reason: saved.reason } : {}),
        ...(saved.comment ? { comment: saved.comment } : {}),
      },
    });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = principal(req);
    const session = conversationStore.get(String(req.params.id), tenantId, userId);
    feedbackStore.remove(tenantId, session.id, String(req.params.replyId), userId);
    res.status(204).end();
  },
};
```

- [ ] **Step 5: Routes**

`server/src/modules/conversation/conversation.routes.ts`：檔頭加

```ts
import { feedbackController } from '@/modules/feedback/feedback.controller';
import { putFeedbackSchema, replyParamSchema } from '@/modules/feedback/feedback.schema';
```

在 `export` 之前（其他 router 定義之後）加：

```ts
// AI 回覆評價：不呼叫 LLM，app.ts 掛載的 tenantRateLimit 已涵蓋；月配額只算對話輪次，不影響
router.put(
  '/:id/replies/:replyId/feedback',
  validate({ params: replyParamSchema, body: putFeedbackSchema }),
  asyncHandler(feedbackController.put),
);
router.delete(
  '/:id/replies/:replyId/feedback',
  validate({ params: replyParamSchema }),
  asyncHandler(feedbackController.remove),
);
```

> 注意：`/api/conversations` 在 app.ts 掛了 `tenantMonthlyQuota`。確認它只在呼叫 LLM 的路徑計數：`grep -n "increment\|messages" server/src/middlewares/tenant-quota.ts`。若它對所有請求計數或在超額時擋下所有路徑，評價在超額時也會被擋；這可接受（超額租戶本來就不能對話），不需改動，但在 Task 9 的最終報告中註明。

- [ ] **Step 6: Run tests**

Run: `cd server && npx jest tests/feedback-api.test.ts && npx tsc --noEmit -p .`
Expected: PASS（7 tests）。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/feedback/feedback.schema.ts server/src/modules/feedback/feedback.controller.ts server/src/modules/conversation/conversation.routes.ts server/tests/feedback-api.test.ts
git commit -m "feat(feedback): 新增使用者評價 AI 回覆的 API

- PUT /conversations/:id/replies/:replyId/feedback 建立或更新評價，只收 replyId，由伺服器取快照
- 只有倒讚可附原因與說明（≤500 字），按讚帶原因回 422
- 回覆不在對話中回 404，他人對話沿用既有 403
- DELETE 撤回評價，冪等回 204

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 後台回饋 API

**Files:**
- Create: `server/src/modules/feedback/feedback.admin.controller.ts`
- Modify: `server/src/modules/feedback/feedback.schema.ts`（新增後台 schema）
- Modify: `server/src/modules/admin/admin.routes.ts`
- Modify: `server/.env.example`、`DEPLOY.zeabur.md`
- Modify: `docs/superpowers/specs/2026-10-13-reply-feedback-design.md`（同步實作差異）
- Test: `server/tests/feedback-admin.test.ts`

**Interfaces:**
- Consumes: `feedbackStore.list/stats/setStatus` (Task 3)、`adminAuditTrail`（既有，PATCH 自動稽核）
- Produces:
  - `GET /api/admin/tenants/:id/feedback?rating&serviceId&reason&status&before&limit` → `{ data: { items: ReplyFeedback[]; nextCursor: string | null } }`
  - `GET /api/admin/tenants/:id/feedback/stats?days=7|30|90` → `{ data: FeedbackStats }`
  - `PATCH /api/admin/tenants/:id/feedback/:feedbackId` body `{ status: 'open'|'resolved'; resolutionNote?: string }` → `{ data: ReplyFeedback }`

- [ ] **Step 1: Write the failing test**

`server/tests/feedback-admin.test.ts`：

```ts
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { auditStore } from '@/modules/audit/audit.store';
import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import { feedbackStore } from '@/modules/feedback/feedback.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const ADMIN_KEY = 'test-admin-key-for-feedback';
const admin = { 'x-admin-key': ADMIN_KEY };
const original = env.ADMIN_API_KEY;
beforeAll(() => { (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = ADMIN_KEY; });
afterAll(() => { (env as { ADMIN_API_KEY: string }).ADMIN_API_KEY = original; });
afterEach(() => { feedbackStore.clear(); auditStore.clear(); });

const reply = (id: string): ReplyRecord => ({ id, question: `q-${id}`, answer: `a-${id}`, serviceId: 'knowledge', at: '2026-10-13T00:00:00.000Z' });
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

it('清單：篩選待處理倒讚、每頁預設 10 筆、帶游標翻頁', async () => {
  const t = tenantStore.createTenant('fb-admin-list');
  for (let i = 0; i < 12; i++) feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply(`r${i}`), rating: 'down' });
  feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('up'), rating: 'up' });
  const first = await request(app).get(`/api/admin/tenants/${t.id}/feedback`).query({ rating: 'down', status: 'open' }).set(admin);
  expect(first.status).toBe(200);
  expect(first.body.data.items).toHaveLength(10);
  const next = await request(app).get(`/api/admin/tenants/${t.id}/feedback`)
    .query({ rating: 'down', status: 'open', before: first.body.data.nextCursor }).set(admin);
  expect(next.body.data.items).toHaveLength(2);
  expect(next.body.data.nextCursor).toBeNull();
});

it('統計：days 只接受 7／30／90', async () => {
  const t = tenantStore.createTenant('fb-admin-stats');
  feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'up' });
  const ok = await request(app).get(`/api/admin/tenants/${t.id}/feedback/stats`).query({ days: 7 }).set(admin);
  expect(ok.status).toBe(200);
  expect(ok.body.data).toMatchObject({ days: 7, total: 1, up: 1 });
  expect((await request(app).get(`/api/admin/tenants/${t.id}/feedback/stats`).query({ days: 14 }).set(admin)).status).toBe(422);
});

it('PATCH 更新處理狀態並寫入稽核；跨租戶 404', async () => {
  const t = tenantStore.createTenant('fb-admin-patch');
  const other = tenantStore.createTenant('fb-admin-other');
  const f = feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'down' });
  const res = await request(app).patch(`/api/admin/tenants/${t.id}/feedback/${f.id}`).set(admin)
    .send({ status: 'resolved', resolutionNote: '已補上 2026 年請假規定' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ status: 'resolved', resolutionNote: '已補上 2026 年請假規定' });
  await flush();
  expect(auditStore.list(t.id)[0].summary).toContain(`PATCH /tenants/${t.id}/feedback/${f.id}`);
  expect((await request(app).patch(`/api/admin/tenants/${other.id}/feedback/${f.id}`).set(admin).send({ status: 'open' })).status).toBe(404);
});

it('處理說明超過 200 字 → 422', async () => {
  const t = tenantStore.createTenant('fb-admin-note');
  const f = feedbackStore.upsert({ tenantId: t.id, userId: 'u', sessionId: 's', reply: reply('a'), rating: 'down' });
  const res = await request(app).patch(`/api/admin/tenants/${t.id}/feedback/${f.id}`).set(admin).send({ status: 'resolved', resolutionNote: 'x'.repeat(201) });
  expect(res.status).toBe(422);
});

it('沒有管理憑證 → 401', async () => {
  const t = tenantStore.createTenant('fb-admin-auth');
  expect((await request(app).get(`/api/admin/tenants/${t.id}/feedback`)).status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest tests/feedback-admin.test.ts`
Expected: FAIL，GET 回 404。

- [ ] **Step 3: Admin schemas**

在 `server/src/modules/feedback/feedback.schema.ts` 檔尾加：

```ts
export const adminFeedbackListQuerySchema = z.object({
  rating: z.enum(['up', 'down']).optional(),
  serviceId: z.string().trim().min(1).max(32).optional(),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  status: z.enum(['open', 'resolved']).optional(),
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const adminFeedbackStatsQuerySchema = z.object({
  days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30),
});

export const adminFeedbackParamSchema = z.object({ id: z.string().min(1), feedbackId: z.string().uuid() });

export const patchFeedbackSchema = z
  .object({
    status: z.enum(['open', 'resolved']),
    resolutionNote: z.string().trim().max(200).optional(),
  })
  .strict();
```

- [ ] **Step 4: Admin controller**

`server/src/modules/feedback/feedback.admin.controller.ts`：

```ts
/** 後台回饋：清單、統計、處理狀態。PATCH 由 admin router 的 adminAuditTrail 自動寫稽核。 */
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import {
  adminFeedbackListQuerySchema,
  adminFeedbackStatsQuerySchema,
  patchFeedbackSchema,
} from './feedback.schema';
import { feedbackStore } from './feedback.store';

function tenantIdOf(req: Request): string {
  const id = String(req.params.id);
  if (!tenantStore.getTenant(id)) throw AppError.notFound('Tenant not found');
  return id;
}

export const feedbackAdminController = {
  async list(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { before, limit, ...filter } = adminFeedbackListQuerySchema.parse(req.query);
    res.status(200).json({ data: feedbackStore.list(tenantId, filter, { before, limit }) });
  },

  async stats(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { days } = adminFeedbackStatsQuerySchema.parse(req.query);
    res.status(200).json({ data: feedbackStore.stats(tenantId, days) });
  },

  async update(req: Request, res: Response): Promise<void> {
    const tenantId = tenantIdOf(req);
    const { status, resolutionNote } = patchFeedbackSchema.parse(req.body);
    const updated = feedbackStore.setStatus(tenantId, String(req.params.feedbackId), status, resolutionNote);
    if (!updated) throw AppError.notFound('回饋不存在');
    res.status(200).json({ data: updated });
  },
};
```

- [ ] **Step 5: Admin routes**

`server/src/modules/admin/admin.routes.ts`：檔頭加

```ts
import { feedbackAdminController } from '@/modules/feedback/feedback.admin.controller';
import {
  adminFeedbackListQuerySchema,
  adminFeedbackParamSchema,
  adminFeedbackStatsQuerySchema,
  patchFeedbackSchema,
} from '@/modules/feedback/feedback.schema';
```

在 `/tenants/:id/audit` 路由之後加（`/stats` 必須在 `/:feedbackId` 之前註冊）：

```ts
// AI 回覆回饋：統計、清單（游標分頁）、處理狀態
router.get(
  '/tenants/:id/feedback/stats',
  validate({ params: tenantParamSchema, query: adminFeedbackStatsQuerySchema }),
  asyncHandler(feedbackAdminController.stats),
);
router.get(
  '/tenants/:id/feedback',
  validate({ params: tenantParamSchema, query: adminFeedbackListQuerySchema }),
  asyncHandler(feedbackAdminController.list),
);
router.patch(
  '/tenants/:id/feedback/:feedbackId',
  validate({ params: adminFeedbackParamSchema, body: patchFeedbackSchema }),
  asyncHandler(feedbackAdminController.update),
);
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx jest tests/feedback-admin.test.ts && npx tsc --noEmit -p .`
Expected: PASS（5 tests）。

- [ ] **Step 7: Docs**

`server/.env.example`：在報告相關設定之後加：

```bash
# AI 回覆評價（含問答快照）的保存天數，依最後更新時間計算；預設 180
# FEEDBACK_RETENTION_DAYS=180
```

`DEPLOY.zeabur.md` 環境變數表，在 `REPORT_PDF_BROWSER` 那一列之前加一列：

```markdown
| `FEEDBACK_RETENTION_DAYS` | 選填 | AI 回覆評價（含問答快照，可能含個資）的保存天數，預設 `180`。db 模式需先套用 `0020_reply_feedback.sql` |
```

`docs/superpowers/specs/2026-10-13-reply-feedback-design.md` 同步三處實作差異：
- §2.1「只有 `POST /conversations/:id/messages` 產生的回覆…」改為「`POST /conversations/:id/messages` 與建立對話時帶的第一則訊息（`POST /conversations` 的 `message`）產生的回覆…」。
- §8 錯誤處理表「對話不存在、不屬於本人或租戶不符｜404」改為兩列：「對話不存在或租戶不符｜404」「對話屬於他人｜403（與既有對話 API 一致）」。
- §7.4「游標為 `(updatedAt, id)`…依 `updatedAt desc, id desc` 排序」改為「游標為 `(createdAt, id)`…依 `createdAt desc, id desc` 排序（改評不會讓項目在翻頁中跳位）」。

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/feedback/feedback.admin.controller.ts server/src/modules/feedback/feedback.schema.ts server/src/modules/admin/admin.routes.ts server/tests/feedback-admin.test.ts server/.env.example DEPLOY.zeabur.md docs/superpowers/specs/2026-10-13-reply-feedback-design.md
git commit -m "feat(admin): 新增後台回饋清單、統計與處理狀態 API

- GET /admin/tenants/:id/feedback 支援評價、服務、原因、狀態篩選與游標分頁
- GET /admin/tenants/:id/feedback/stats 提供 7／30／90 天統計
- PATCH /admin/tenants/:id/feedback/:feedbackId 更新處理狀態，由後台稽核自動記錄
- 補上 FEEDBACK_RETENTION_DAYS 文件，設計文件同步實作差異

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 網頁版評價按鈕

**Files:**
- Modify: `client/src/api.ts`（`TurnData`、新增 `setFeedback`／`clearFeedback`）
- Create: `client/src/FeedbackButtons.tsx`
- Modify: `client/src/App.tsx`（`ChatMessage`、`pushMsg`、`applyTurn`、`msg-meta`）
- Modify: `client/src/i18n.ts`（`app` 區段，中英各一份）
- Modify: `client/src/index.css`（`.msg-action` 附近）
- Test: `client/src/FeedbackButtons.test.tsx`

**Interfaces:**
- Consumes: `PUT/DELETE /api/conversations/:id/replies/:replyId/feedback` (Task 4)、shared `ReplyFeedbackInput`, `FeedbackReason`
- Produces:
  - `api.setFeedback(userId: string, convId: string, replyId: string, input: ReplyFeedbackInput): Promise<ReplyFeedbackInput>`
  - `api.clearFeedback(userId: string, convId: string, replyId: string): Promise<void>`
  - `FeedbackButtons` props：`{ convId: string; replyId: string; userId: string; value?: ReplyFeedbackInput; onChange(next: ReplyFeedbackInput | undefined): void; onError(message: string): void }`
  - `ChatMessage.replyId?: string`、`ChatMessage.convId?: string`、`ChatMessage.feedback?: ReplyFeedbackInput`

- [ ] **Step 1: Write the failing test**

`client/src/FeedbackButtons.test.tsx`：

```tsx
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplyFeedbackInput } from '@hyagent/shared';
import { FeedbackButtons } from './FeedbackButtons';
import { api } from './api';
import './i18n';

vi.mock('./api', () => ({ api: { setFeedback: vi.fn(), clearFeedback: vi.fn() } }));

function Harness({ onError = vi.fn() }: { onError?: (m: string) => void }) {
  const [value, setValue] = useState<ReplyFeedbackInput | undefined>();
  return (
    <>
      <FeedbackButtons convId="c1" replyId="r1" userId="kevin" value={value} onChange={setValue} onError={onError} />
      <output data-testid="value">{JSON.stringify(value ?? null)}</output>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.setFeedback).mockImplementation(async (_u, _c, _r, input) => input);
  vi.mocked(api.clearFeedback).mockResolvedValue(undefined);
});

describe('FeedbackButtons', () => {
  it('按讚立即送出，再按一次撤回', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '有幫助' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1', { rating: 'up' }));
    expect(screen.getByRole('button', { name: '有幫助' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '有幫助' }));
    await waitFor(() => expect(api.clearFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1'));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  it('倒讚立即記錄並展開原因面板；送出補上原因與說明', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1', { rating: 'down' }));
    fireEvent.click(screen.getByRole('radio', { name: '資料過時' }));
    fireEvent.change(screen.getByLabelText('補充說明（選填）'), { target: { value: '這是去年的版本' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenLastCalledWith('kevin', 'c1', 'r1', { rating: 'down', reason: 'outdated', comment: '這是去年的版本' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('感謝回饋')).toBeInTheDocument();
  });

  it('略過只保留倒讚', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '略過' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setFeedback).toHaveBeenCalledTimes(1);
  });

  it('送出失敗：還原狀態並回報錯誤（例如回覆已無法評價）', async () => {
    const onError = vi.fn();
    vi.mocked(api.setFeedback).mockRejectedValue(new Error('這則回覆已無法評價'));
    render(<Harness onError={onError} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有幫助' })); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('這則回覆已無法評價'));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
    expect(screen.getByRole('button', { name: '有幫助' })).toHaveAttribute('aria-pressed', 'false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/FeedbackButtons.test.tsx`
Expected: FAIL，找不到 `./FeedbackButtons`。

- [ ] **Step 3: API client**

`client/src/api.ts`：
- `TurnData` 介面 `blocks?: DisplayBlock[];` 之後加 `/** 本則回覆的編號（可評價） */ replyId?: string;`
- 檔頭 shared 匯入加入 `ReplyFeedbackInput`（若 api.ts 以 `import type { ... } from '@hyagent/shared'` 匯入，併入同一行）。
- 在 `cancelAction(...)` 方法之後加：

```ts
  /** 評價 AI 回覆（建立或更新）；伺服器依 replyId 取問答快照 */
  setFeedback(userId: string, convId: string, replyId: string, input: ReplyFeedbackInput): Promise<ReplyFeedbackInput> {
    return request<ReplyFeedbackInput>(`${BASE}/${convId}/replies/${replyId}/feedback`, {
      method: 'PUT',
      headers: headers(userId),
      body: JSON.stringify(input),
    });
  },

  /** 撤回評價（冪等） */
  async clearFeedback(userId: string, convId: string, replyId: string): Promise<void> {
    await request<void>(`${BASE}/${convId}/replies/${replyId}/feedback`, {
      method: 'DELETE',
      headers: headers(userId),
    });
  },
```

- [ ] **Step 4: i18n**

`client/src/i18n.ts`：在中文 `app` 區段 `copiedMsg: "已複製",` 之後加：

```ts
    feedbackUp: "有幫助",
    feedbackDown: "沒有幫助",
    feedbackThanks: "感謝回饋",
    feedbackPanelTitle: "哪裡不好？",
    feedbackReasonWrong: "答錯了",
    feedbackReasonNotAnswered: "沒回答到問題",
    feedbackReasonOutdated: "資料過時",
    feedbackReasonInappropriate: "內容不恰當",
    feedbackReasonOther: "其他",
    feedbackComment: "補充說明（選填）",
    feedbackSubmit: "送出",
    feedbackSkip: "略過",
```

英文 `app` 區段 `copiedMsg: "Copied",` 之後加：

```ts
    feedbackUp: "Helpful",
    feedbackDown: "Not helpful",
    feedbackThanks: "Thanks for the feedback",
    feedbackPanelTitle: "What went wrong?",
    feedbackReasonWrong: "Incorrect",
    feedbackReasonNotAnswered: "Didn't answer the question",
    feedbackReasonOutdated: "Out of date",
    feedbackReasonInappropriate: "Inappropriate",
    feedbackReasonOther: "Other",
    feedbackComment: "Details (optional)",
    feedbackSubmit: "Submit",
    feedbackSkip: "Skip",
```

- [ ] **Step 5: Component**

`client/src/FeedbackButtons.tsx`：

```tsx
/**
 * AI 回覆的讚／倒讚。樂觀更新：先改畫面再送，失敗還原並回報。
 * 倒讚立即記錄，再展開原因面板；送出把原因與說明補進同一筆，略過只保留倒讚。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackReason, ReplyFeedbackInput } from '@hyagent/shared';
import { api } from './api';

const REASONS: { value: FeedbackReason; key: string }[] = [
  { value: 'wrong', key: 'app.feedbackReasonWrong' },
  { value: 'not_answered', key: 'app.feedbackReasonNotAnswered' },
  { value: 'outdated', key: 'app.feedbackReasonOutdated' },
  { value: 'inappropriate', key: 'app.feedbackReasonInappropriate' },
  { value: 'other', key: 'app.feedbackReasonOther' },
];

const COMMENT_MAX = 500;
const THANKS_MS = 2000;

interface Props {
  convId: string;
  replyId: string;
  userId: string;
  value?: ReplyFeedbackInput;
  onChange(next: ReplyFeedbackInput | undefined): void;
  onError(message: string): void;
}

export function FeedbackButtons({ convId, replyId, userId, value, onChange, onError }: Props) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | undefined>();
  const [comment, setComment] = useState('');
  const [thanks, setThanks] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 點面板外＝略過
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPanelOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [panelOpen]);

  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  async function apply(next: ReplyFeedbackInput | undefined): Promise<boolean> {
    const previous = value;
    onChange(next);
    try {
      if (next) await api.setFeedback(userId, convId, replyId, next);
      else await api.clearFeedback(userId, convId, replyId);
      return true;
    } catch (e) {
      onChange(previous);
      onError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function clickUp() {
    setPanelOpen(false);
    if (value?.rating === 'up') {
      await apply(undefined);
      return;
    }
    if (await apply({ rating: 'up' })) setThanks(true);
  }

  async function clickDown() {
    if (value?.rating === 'down') {
      setPanelOpen(false);
      await apply(undefined);
      return;
    }
    setReason(undefined);
    setComment('');
    if (await apply({ rating: 'down' })) setPanelOpen(true);
  }

  async function submitDetail() {
    const trimmed = comment.trim();
    const next: ReplyFeedbackInput = { rating: 'down', ...(reason ? { reason } : {}), ...(trimmed ? { comment: trimmed } : {}) };
    setPanelOpen(false);
    if (await apply(next)) setThanks(true);
  }

  return (
    <span ref={wrapRef} className="feedback">
      <button
        type="button"
        className={`msg-action${value?.rating === 'up' ? ' msg-action--active' : ''}`}
        aria-label={t('app.feedbackUp')}
        title={t('app.feedbackUp')}
        aria-pressed={value?.rating === 'up'}
        onClick={() => void clickUp()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={value?.rating === 'up' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </svg>
      </button>
      <button
        type="button"
        className={`msg-action${value?.rating === 'down' ? ' msg-action--active' : ''}`}
        aria-label={t('app.feedbackDown')}
        title={t('app.feedbackDown')}
        aria-pressed={value?.rating === 'down'}
        onClick={() => void clickDown()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={value?.rating === 'down' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </svg>
      </button>
      {thanks && <span className="feedback-thanks" role="status">{t('app.feedbackThanks')}</span>}
      {panelOpen && (
        <div className="feedback-panel" role="dialog" aria-label={t('app.feedbackPanelTitle')}>
          <div className="feedback-panel-title">{t('app.feedbackPanelTitle')}</div>
          <div className="feedback-reasons" role="radiogroup">
            {REASONS.map((r) => (
              <label key={r.value} className={`feedback-reason${reason === r.value ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={`feedback-reason-${replyId}`}
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                {t(r.key)}
              </label>
            ))}
          </div>
          <input
            className="feedback-comment"
            aria-label={t('app.feedbackComment')}
            placeholder={t('app.feedbackComment')}
            value={comment}
            maxLength={COMMENT_MAX}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitDetail(); }}
          />
          <div className="feedback-panel-actions">
            <button type="button" className="feedback-skip" onClick={() => setPanelOpen(false)}>{t('app.feedbackSkip')}</button>
            <button type="button" className="feedback-submit" onClick={() => void submitDetail()}>{t('app.feedbackSubmit')}</button>
          </div>
        </div>
      )}
    </span>
  );
}
```

- [ ] **Step 6: Styles**

`client/src/index.css`：在 `.msg:hover .msg-action, .msg:focus-within .msg-action { ... }` 區塊之後加：

```css
  /* 評價鈕：已評價的那顆固定顯示（帶狀態的元素不可隱藏，理由同報告入口） */
  .msg-action--active {
    @apply text-[var(--primary-color)] opacity-100;
  }
  .feedback {
    @apply relative inline-flex items-center gap-1;
  }
  .feedback-thanks {
    @apply text-xs text-[var(--text-secondary)];
  }
  .feedback-panel {
    @apply absolute left-0 top-full z-20 mt-1 w-72 rounded-xl border border-[var(--border-color)] bg-[var(--bg-color)] p-3 text-sm shadow-lg;
  }
  .feedback-panel-title {
    @apply mb-2 font-medium text-[var(--text-primary)];
  }
  .feedback-reasons {
    @apply mb-2 flex flex-wrap gap-1.5;
  }
  .feedback-reason {
    @apply cursor-pointer rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-secondary)];
  }
  .feedback-reason input {
    @apply sr-only;
  }
  .feedback-reason.is-selected {
    @apply border-[var(--primary-color)] text-[var(--primary-color)];
  }
  .feedback-comment {
    @apply mb-2 w-full rounded-lg border border-[var(--border-color)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--text-primary)];
  }
  .feedback-panel-actions {
    @apply flex justify-end gap-2;
  }
  .feedback-skip {
    @apply cursor-pointer rounded-lg px-3 py-1 text-[var(--text-secondary)];
  }
  .feedback-submit {
    @apply cursor-pointer rounded-lg bg-[var(--primary-color)] px-3 py-1 text-white;
  }
```

> 執行前確認 client 有 `--bg-color` 變數：`grep -n "\-\-bg-color" client/src/index.css ui/src/styles.css`。若不存在，改用氣泡背景所用的變數（`grep -n "bubble-agent" -A3 client/src/index.css` 查看）。

- [ ] **Step 7: Wire into App.tsx**

`client/src/App.tsx`：
1. 匯入：`import { FeedbackButtons } from './FeedbackButtons';`，並把 `ReplyFeedbackInput` 加進 `@hyagent/shared` 的型別匯入。
2. `ChatMessage` 介面 `blocks?: DisplayBlock[];` 之後加：

```ts
  /** 可評價回覆的編號與所屬對話（對話重開後仍評價到原對話） */
  replyId?: string;
  convId?: string;
  /** 目前的評價（樂觀更新） */
  feedback?: ReplyFeedbackInput;
```

3. `pushMsg` 改為多一個選填參數：

```ts
  function pushMsg(role: Role, text: string, suggestions?: string[], reportId?: string, pendingAction?: PendingActionView, blocks?: DisplayBlock[], reply?: { replyId: string; convId: string }) {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role, text, suggestions, reportId, pendingAction, blocks, ...(reply ?? {}), at: Date.now() },
    ]);
  }
```

4. `applyTurn` 內 `if (data.reply) pushMsg('agent', ...)` 改為：

```ts
    const turnConvId = data.id ?? sessionId ?? convId;
    if (data.reply) {
      pushMsg('agent', data.reply, data.suggestions, data.report?.id, data.pendingAction, data.blocks,
        data.replyId && turnConvId ? { replyId: data.replyId, convId: turnConvId } : undefined);
    }
```

5. 新增更新單則訊息評價的函式（放在 `copyMsg` 附近）：

```ts
  function setMsgFeedback(id: number, feedback: ReplyFeedbackInput | undefined) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback } : m)));
  }
```

6. 在 `msg-meta` 內複製按鈕的 `</button>` 之後、`{m.role === 'user' && (` 之前加：

```tsx
                    {m.role === 'agent' && m.replyId && m.convId && authUser && (
                      <FeedbackButtons
                        convId={m.convId}
                        replyId={m.replyId}
                        userId={authUser.id}
                        value={m.feedback}
                        onChange={(next) => setMsgFeedback(m.id, next)}
                        onError={(message) => setError(message)}
                      />
                    )}
```

> `setError` 為 App 現有的錯誤提示 setter；先確認名稱：`grep -n "const \[error, setError\]\|setErr(" client/src/App.tsx | head -3`，用實際存在的那一個。`authUser.id` 為 `Applicant.id`；訪客模式若 `authUser` 為 null，改用 App 傳給 `api.sendMessage` 的同一個 userId 變數（`grep -n "api.sendMessage(" client/src/App.tsx` 查看第一個參數）。

- [ ] **Step 8: Run tests**

Run: `cd client && npx vitest run && npx tsc --noEmit -p . && npx eslint src/FeedbackButtons.tsx src/App.tsx`
Expected: 全部 PASS；typecheck 無錯誤；lint 只有 App.tsx 既有的兩個 react-hooks 警告。

- [ ] **Step 9: Commit**

```bash
git add client/src/api.ts client/src/FeedbackButtons.tsx client/src/FeedbackButtons.test.tsx client/src/App.tsx client/src/i18n.ts client/src/index.css
git commit -m "feat(client): AI 回覆新增讚／倒讚評價

- 有 replyId 的回覆在複製鈕旁顯示讚與倒讚，已評價者固定顯示
- 倒讚展開原因與補充說明面板，可送出或略過；再按一次撤回
- 樂觀更新，失敗還原並提示錯誤
- 新增中英文文案與面板樣式

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 行動 App 評價（app-core）

**Files:**
- Modify: `mobile/packages/app-core/src/api/types.ts:10-18`
- Modify: `mobile/packages/app-core/src/api/endpoints.ts`
- Modify: `mobile/packages/app-core/src/chat/types.ts`
- Modify: `mobile/packages/app-core/src/chat/chatReducer.ts`
- Modify: `mobile/packages/app-core/src/chat/ChatProvider.tsx`
- Create: `mobile/packages/app-core/src/chat/FeedbackSheet.tsx`
- Modify: `mobile/packages/app-core/src/chat/MessageBubble.tsx`
- Test: `mobile/packages/app-core/src/chat/chatReducer.test.ts`、`ChatProvider.test.tsx`、`MessageBubble.test.tsx`（各加案例）

**Interfaces:**
- Consumes: Task 4 API；shared `ReplyFeedbackInput`, `FeedbackReason`
- Produces:
  - `TurnData.replyId?: string`
  - agent `ChatMessage` 新增 `replyId?: string; conversationId?: string; feedback?: ReplyFeedbackInput`
  - `ChatAction` 新增 `{ type: 'feedbackSet'; messageId: string; feedback?: ReplyFeedbackInput }`
  - `endpoints.setFeedback(convId: string, replyId: string, input: ReplyFeedbackInput): Promise<ReplyFeedbackInput>`、`endpoints.clearFeedback(convId: string, replyId: string): Promise<void>`
  - `ChatContextValue.rate(messageId: string, next: ReplyFeedbackInput | undefined): Promise<boolean>`（成功 true；失敗已還原並回 false）
  - `useChatOptional(): ChatContextValue | null`
  - `FeedbackSheet` props：`{ visible: boolean; onSubmit(detail: { reason?: FeedbackReason; comment?: string }): void; onSkip(): void }`

- [ ] **Step 1: Write the failing tests**

在 `mobile/packages/app-core/src/chat/chatReducer.test.ts` 檔尾加：

```ts
describe('評價', () => {
  it('turnReceived 帶入 replyId 與所屬對話 id', () => {
    const s = chatReducer(initialChatState, { type: 'turnReceived', conversationId: 'c1', turn: { status: 'collecting', reply: '答', replyId: 'r1' } });
    expect(s.messages[0]).toMatchObject({ role: 'agent', replyId: 'r1', conversationId: 'c1' });
  });

  it('feedbackSet 只改目標訊息；undefined 代表撤回', () => {
    let s = chatReducer(initialChatState, { type: 'turnReceived', conversationId: 'c1', turn: { status: 'collecting', reply: '答', replyId: 'r1' } });
    const id = s.messages[0].id;
    s = chatReducer(s, { type: 'feedbackSet', messageId: id, feedback: { rating: 'down', reason: 'wrong' } });
    expect(s.messages[0]).toMatchObject({ feedback: { rating: 'down', reason: 'wrong' } });
    s = chatReducer(s, { type: 'feedbackSet', messageId: id, feedback: undefined });
    expect(s.messages[0]).not.toHaveProperty('feedback');
  });
});
```

（若該測試檔尚未匯入 `chatReducer`／`initialChatState`，於檔頭加 `import { chatReducer, initialChatState } from './chatReducer';`。）

在 `ChatProvider.test.tsx` 的 `describe('ChatProvider', () => {` 區塊內加：

```ts
  it('rate 以訊息自己的對話 id 送出；對話重開後評價舊訊息仍送到原對話', async () => {
    const api = fakeApi({
      sendMessage: jest.fn(async (_id: string, m: string) => ({ status: 'collecting', reply: `回覆：${m}`, replyId: 'r-old' })),
      startConversation: jest.fn(async () => ({ id: 'c1', status: 'collecting', reply: null })),
      setFeedback: jest.fn(async (_c: string, _r: string, input: unknown) => input),
    } as never);
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('查庫存'); });
    const msg = result.current.chat.state.messages.find((m) => m.role === 'agent' && 'replyId' in m && m.replyId === 'r-old')!;
    await act(async () => { await result.current.chat.rate(msg.id, { rating: 'up' }); });
    expect(api.setFeedback).toHaveBeenCalledWith('c1', 'r-old', { rating: 'up' });
    expect(result.current.chat.state.messages.find((m) => m.id === msg.id)).toMatchObject({ feedback: { rating: 'up' } });
  });

  it('rate 失敗時還原並回 false', async () => {
    const api = fakeApi({
      sendMessage: jest.fn(async () => ({ status: 'collecting', reply: '答', replyId: 'r1' })),
      startConversation: jest.fn(async () => ({ id: 'c1', status: 'collecting', reply: null })),
      setFeedback: jest.fn(async () => { throw new ApiError('這則回覆已無法評價', 404); }),
    } as never);
    const { result } = await setup(api);
    await act(async () => { await result.current.chat.send('你好'); });
    await act(async () => { await result.current.chat.send('再問'); });
    const msg = result.current.chat.state.messages.find((m) => m.role === 'agent' && 'replyId' in m && m.replyId)!;
    let ok = true;
    await act(async () => { ok = await result.current.chat.rate(msg.id, { rating: 'down' }); });
    expect(ok).toBe(false);
    expect(result.current.chat.state.messages.find((m) => m.id === msg.id)).not.toHaveProperty('feedback');
  });
```

> 先確認 `ApiError` 的建構子參數順序：`grep -n "constructor" mobile/packages/app-core/src/api/errors.ts`，依實際簽名調整 `new ApiError(...)`。

在 `MessageBubble.test.tsx` 檔尾加：

```tsx
import { ChatContextForTest } from './ChatProvider';

describe('評價按鈕', () => {
  function renderWithChat(message: ChatMessage, rate = jest.fn().mockResolvedValue(true)) {
    return render(
      <ChatContextForTest.Provider value={{ rate } as never}>
        <MessageBubble message={message} showSuggestions={false} onSuggestion={jest.fn()} onEdit={jest.fn()} />
      </ChatContextForTest.Provider>,
    );
  }

  it('有 replyId 的 AI 回覆顯示讚／倒讚；按讚呼叫 rate', async () => {
    const rate = jest.fn().mockResolvedValue(true);
    await renderWithChat({ id: 'a1', role: 'agent', text: '答', replyId: 'r1', conversationId: 'c1', at: 0 }, rate);
    await act(async () => { await fireEvent.press(screen.getByLabelText('有幫助')); });
    expect(rate).toHaveBeenCalledWith('a1', { rating: 'up' });
  });

  it('倒讚後開啟原因面板，送出補上原因', async () => {
    const rate = jest.fn().mockResolvedValue(true);
    await renderWithChat({ id: 'a1', role: 'agent', text: '答', replyId: 'r1', conversationId: 'c1', at: 0 }, rate);
    await act(async () => { await fireEvent.press(screen.getByLabelText('沒有幫助')); });
    expect(rate).toHaveBeenLastCalledWith('a1', { rating: 'down' });
    await fireEvent.press(screen.getByLabelText('答錯了'));
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出回饋')); });
    expect(rate).toHaveBeenLastCalledWith('a1', { rating: 'down', reason: 'wrong' });
  });

  it('沒有 replyId 或不在 ChatProvider 內時不顯示評價', async () => {
    await render(<MessageBubble message={{ id: 'a1', role: 'agent', text: '答', replyId: 'r1', at: 0 }} showSuggestions={false} onSuggestion={jest.fn()} onEdit={jest.fn()} />);
    expect(screen.queryByLabelText('有幫助')).toBeNull();
    await renderWithChat({ id: 'a2', role: 'agent', text: '答', at: 0 });
    expect(screen.queryByLabelText('有幫助')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile/packages/app-core && npx jest src/chat/chatReducer.test.ts src/chat/ChatProvider.test.tsx src/chat/MessageBubble.test.tsx`
Expected: FAIL（型別錯誤或 `rate is not a function`／找不到 `ChatContextForTest`）。

- [ ] **Step 3: API types and endpoints**

`api/types.ts` 的 `TurnData` 在 `blocks?: DisplayBlock[];` 之後加 `/** 本則回覆的編號（可評價） */ replyId?: string;`。

`api/endpoints.ts`：檔頭加 `import type { ReplyFeedbackInput } from '@hyagent/shared';`，在 `cancelAction` 之後加：

```ts
    /** 評價 AI 回覆（建立或更新）；伺服器依 replyId 取問答快照 */
    setFeedback: (convId: string, replyId: string, input: ReplyFeedbackInput) =>
      api.request<ReplyFeedbackInput>(`/conversations/${convId}/replies/${replyId}/feedback`, { method: 'PUT', json: input }),
    /** 撤回評價（冪等，回 204） */
    clearFeedback: (convId: string, replyId: string) =>
      api.request<void>(`/conversations/${convId}/replies/${replyId}/feedback`, { method: 'DELETE' }),
```

- [ ] **Step 4: Chat types and reducer**

`chat/types.ts`：檔頭匯入改為 `import type { DisplayBlock, PendingActionView, ReplyFeedbackInput } from '@hyagent/shared';`，agent 那一行改為：

```ts
  | { id: string; role: 'agent'; text: string; blocks?: DisplayBlock[]; suggestions?: string[]; replyId?: string; conversationId?: string; feedback?: ReplyFeedbackInput; at: number }
```

`chat/chatReducer.ts`：
- `ChatAction` 聯集加 `| { type: 'feedbackSet'; messageId: string; feedback?: ReplyFeedbackInput }`，檔頭加 `import type { ReplyFeedbackInput } from '@hyagent/shared';`
- `turnReceived` 的新訊息改為：

```ts
      const convId = action.conversationId ?? state.conversationId ?? undefined;
      const messages: ChatMessage[] = t.reply
        ? [...state.messages, {
            id: nextId(), role: 'agent', text: t.reply, blocks: t.blocks, suggestions: t.suggestions,
            // 評價要送到這則回覆所屬的對話：對話重開後 state.conversationId 會變
            ...(t.replyId && convId ? { replyId: t.replyId, conversationId: convId } : {}),
            at: Date.now(),
          }]
        : state.messages;
```

並把 return 中的 `conversationId: action.conversationId ?? state.conversationId` 維持不變。
- `switch` 加：

```ts
    case 'feedbackSet':
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId || m.role !== 'agent') return m;
          const { feedback: _old, ...rest } = m;
          return action.feedback ? { ...rest, feedback: action.feedback } : rest;
        }),
      };
```

- [ ] **Step 5: ChatProvider.rate and optional context**

`chat/ChatProvider.tsx`：
- 檔頭加 `import type { ReplyFeedbackInput } from '@hyagent/shared';`
- `ChatContextValue` 加：

```ts
  /** 評價 AI 回覆；undefined＝撤回。樂觀更新，失敗還原並回 false。 */
  rate(messageId: string, next: ReplyFeedbackInput | undefined): Promise<boolean>;
```

- 在 `cancel` 之後加：

```ts
  const rate = useCallback(
    async (messageId: string, next: ReplyFeedbackInput | undefined): Promise<boolean> => {
      const msg = stateRef.current.messages.find((m) => m.id === messageId);
      if (!msg || msg.role !== 'agent' || !msg.replyId || !msg.conversationId) return false;
      const previous = msg.feedback;
      dispatch({ type: 'feedbackSet', messageId, feedback: next });
      try {
        if (next) await api.setFeedback(msg.conversationId, msg.replyId, next);
        else await api.clearFeedback(msg.conversationId, msg.replyId);
        return true;
      } catch {
        dispatch({ type: 'feedbackSet', messageId, feedback: previous });
        return false;
      }
    },
    [api],
  );
```

- `value` 的 `useMemo` 物件與相依陣列都加入 `rate`。
- 檔尾加：

```ts
/** MessageBubble 用：不在 ChatProvider 內（如預覽頁）時回 null，評價按鈕不顯示 */
export function useChatOptional(): ChatContextValue | null {
  return useContext(ChatContext);
}

/** 測試用：直接提供 context 值 */
export const ChatContextForTest = ChatContext;
```

- [ ] **Step 6: FeedbackSheet**

`chat/FeedbackSheet.tsx`：

```tsx
/** 倒讚後的原因面板（底部彈出）。原因與說明都可略過。 */
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FeedbackReason } from '@hyagent/shared';
import { useAppBranding } from '@hyagent/app-core/branding/AppBranding';
import { colors, radius, space } from '@hyagent/app-core/theme/tokens';

const REASONS: { value: FeedbackReason; label: string }[] = [
  { value: 'wrong', label: '答錯了' },
  { value: 'not_answered', label: '沒回答到問題' },
  { value: 'outdated', label: '資料過時' },
  { value: 'inappropriate', label: '內容不恰當' },
  { value: 'other', label: '其他' },
];

export function FeedbackSheet({
  visible,
  onSubmit,
  onSkip,
}: {
  visible: boolean;
  onSubmit(detail: { reason?: FeedbackReason; comment?: string }): void;
  onSkip(): void;
}) {
  const { accent = colors } = useAppBranding();
  const [reason, setReason] = useState<FeedbackReason | undefined>();
  const [comment, setComment] = useState('');

  function close(submit: boolean) {
    const trimmed = comment.trim();
    if (submit) onSubmit({ ...(reason ? { reason } : {}), ...(trimmed ? { comment: trimmed } : {}) });
    else onSkip();
    setReason(undefined);
    setComment('');
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => close(false)}>
      <Pressable style={styles.backdrop} onPress={() => close(false)} accessibilityLabel="略過回饋" />
      <View style={styles.sheet}>
        <Text style={styles.title}>哪裡不好？</Text>
        <View style={styles.reasons}>
          {REASONS.map((r) => {
            const selected = reason === r.value;
            return (
              <Pressable
                key={r.value}
                accessibilityRole="radio"
                accessibilityLabel={r.label}
                accessibilityState={{ selected }}
                onPress={() => setReason(selected ? undefined : r.value)}
                style={[styles.reason, selected && { borderColor: accent.primary, backgroundColor: accent.primarySoft }]}
              >
                <Text style={[styles.reasonText, selected && { color: accent.primaryDark }]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          style={styles.input}
          placeholder="補充說明（選填）"
          accessibilityLabel="補充說明"
          value={comment}
          onChangeText={setComment}
          maxLength={500}
        />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="略過" onPress={() => close(false)} style={styles.skip}>
            <Text style={styles.skipText}>略過</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="送出回饋" onPress={() => close(true)} style={[styles.submit, { backgroundColor: accent.primary }]}>
            <Text style={styles.submitText}>送出</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.md },
  title: { fontSize: 17, fontWeight: '600', color: colors.text },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  reason: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  reasonText: { fontSize: 15, color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 44, fontSize: 15, color: colors.text },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  skip: { paddingHorizontal: space.lg, minHeight: 44, justifyContent: 'center' },
  skipText: { fontSize: 15, color: colors.textMuted },
  submit: { paddingHorizontal: space.lg, minHeight: 44, justifyContent: 'center', borderRadius: radius.md },
  submitText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
```

> 先確認 `radius.md` 與 `accent.primary` 存在：`grep -n "md:\|pill:" mobile/packages/app-core/src/theme/tokens.ts`、`grep -n "primary" mobile/packages/app-core/src/branding/AppBranding.tsx | head`；不存在就改用該檔已有的鍵（如 `radius.lg`、`accent.primaryDark`）。

- [ ] **Step 7: MessageBubble buttons**

`chat/MessageBubble.tsx`：
- 匯入 `import { useChatOptional } from './ChatProvider';`、`import { FeedbackSheet } from './FeedbackSheet';`
- 元件內 `const [copied, setCopied] = useState(false);` 之後加：

```tsx
  const chat = useChatOptional();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 只有伺服器發了 replyId、且在 ChatProvider 內的 AI 回覆可以評價
  const feedback = message.role === 'agent' && message.replyId && chat ? message.feedback : undefined;
  const canRate = message.role === 'agent' && !!message.replyId && !!chat;

  async function rateUp() {
    await chat!.rate(message.id, feedback?.rating === 'up' ? undefined : { rating: 'up' });
  }
  async function rateDown() {
    if (feedback?.rating === 'down') {
      await chat!.rate(message.id, undefined);
      return;
    }
    if (await chat!.rate(message.id, { rating: 'down' })) setSheetOpen(true);
  }
  const rating = canRate ? (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="有幫助" accessibilityState={{ selected: feedback?.rating === 'up' }} style={styles.action} onPress={() => void rateUp()}>
        <Ionicons name={feedback?.rating === 'up' ? 'thumbs-up' : 'thumbs-up-outline'} size={20} color={accent.primaryDark} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="沒有幫助" accessibilityState={{ selected: feedback?.rating === 'down' }} style={styles.action} onPress={() => void rateDown()}>
        <Ionicons name={feedback?.rating === 'down' ? 'thumbs-down' : 'thumbs-down-outline'} size={20} color={accent.primaryDark} />
      </Pressable>
      <FeedbackSheet
        visible={sheetOpen}
        onSkip={() => setSheetOpen(false)}
        onSubmit={(detail) => {
          setSheetOpen(false);
          void chat!.rate(message.id, { rating: 'down', ...detail });
        }}
      />
    </>
  ) : null;
```

- AI 回覆分支的 `meta` 列改為：

```tsx
        <View style={styles.meta}>
          <Text style={styles.time}>{time(message.at)}</Text>
          {actions}
          {rating}
        </View>
```

- [ ] **Step 8: Run tests**

Run: `cd mobile/packages/app-core && npx jest && npx tsc --noEmit -p .`
Expected: 全部 PASS；typecheck 無錯誤（若 app-core 無獨立 tsconfig，改在 `mobile/` 執行 `npx tsc --noEmit -p apps/store`）。

- [ ] **Step 9: Commit**

```bash
git add mobile/packages/app-core/src/api/types.ts mobile/packages/app-core/src/api/endpoints.ts mobile/packages/app-core/src/chat/types.ts mobile/packages/app-core/src/chat/chatReducer.ts mobile/packages/app-core/src/chat/ChatProvider.tsx mobile/packages/app-core/src/chat/FeedbackSheet.tsx mobile/packages/app-core/src/chat/MessageBubble.tsx mobile/packages/app-core/src/chat/chatReducer.test.ts mobile/packages/app-core/src/chat/ChatProvider.test.tsx mobile/packages/app-core/src/chat/MessageBubble.test.tsx
git commit -m "feat(mobile): AI 回覆新增讚／倒讚評價

- 回覆記錄 replyId 與所屬對話，對話重開後仍評價到原對話
- ChatProvider 新增 rate，樂觀更新，失敗還原
- MessageBubble 動作列常駐讚／倒讚，倒讚開啟原因面板
- 三個 App 透過共用核心一併適用

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 後台「回饋」分頁

**Files:**
- Modify: `admin/src/api.ts`
- Create: `admin/src/pages/tabs/FeedbackTab.tsx`
- Modify: `admin/src/pages/TenantDetailPage.tsx:32-56,107-128`
- Modify: `admin/src/pages/tabs/KnowledgeTab.tsx:57-58`（以網址參數預填檢索測試）
- Test: `admin/src/pages/tabs/FeedbackTab.test.tsx`

**Interfaces:**
- Consumes: Task 5 後台 API
- Produces:
  - admin `api.listFeedback(id: string, filter: FeedbackFilterQuery, before?: string): Promise<FeedbackPage>`
  - admin `api.getFeedbackStats(id: string, days: 7 | 30 | 90): Promise<FeedbackStats>`
  - admin `api.updateFeedback(id: string, feedbackId: string, body: { status: 'open' | 'resolved'; resolutionNote?: string }): Promise<FeedbackItem>`
  - `diagnose(f: FeedbackItem): string | null`（FeedbackTab 內匯出，供測試）
  - `FeedbackTab` props：`{ tenantId: string; onError(e: unknown): void; onTestRetrieval(question: string, asUserId: string): void }`
  - KnowledgeTab 讀網址參數 `q`、`as` 作為檢索測試的初始問題與身分

- [ ] **Step 1: Write the failing test**

`admin/src/pages/tabs/FeedbackTab.test.tsx`：

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackTab, { diagnose } from './FeedbackTab';
import { api, type FeedbackItem } from '../../api';

vi.mock('../../api', () => ({ api: { listFeedback: vi.fn(), getFeedbackStats: vi.fn(), updateFeedback: vi.fn() } }));

const item = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: 'f1', tenantId: 't1', userId: 'staff-001', sessionId: 's1', replyId: 'r1', serviceId: 'knowledge',
  question: '特休幾天？', answer: '**7 天**', rating: 'down', reason: 'wrong', status: 'open',
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
  trace: { model: 'm', retrieval: { query: '特休幾天？', poolSize: 3, usedTables: false, chunks: [{ rank: 1, id: 'c', title: '請假規定', url: 'https://x/leave', score: 0.82, excerpt: '特休依年資…' }] } },
  ...over,
});

let fireIntersect: () => void = () => {};
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe() { fireIntersect = () => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never); }
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.mocked(api.getFeedbackStats).mockResolvedValue({
    days: 30, total: 4, up: 2, down: 2, openDown: 1,
    byService: { knowledge: { up: 2, down: 2 } },
    byReason: { wrong: 1, not_answered: 0, outdated: 1, inappropriate: 0, other: 0 },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('diagnose', () => {
  it('知識庫查無片段 → 沒檢索到資料', () => {
    expect(diagnose(item({ trace: { retrieval: { query: 'q', poolSize: 0, usedTables: false, chunks: [] } } }))).toMatch(/沒檢索到資料/);
  });
  it('資料過時優先於答錯', () => {
    expect(diagnose(item({ reason: 'outdated' }))).toMatch(/資料可能過時/);
  });
  it('答錯且有片段 → 有檢索到資料', () => {
    expect(diagnose(item())).toMatch(/有檢索到資料/);
  });
  it('其他情況不顯示', () => {
    expect(diagnose(item({ reason: 'other' }))).toBeNull();
    expect(diagnose(item({ serviceId: 'agent', trace: undefined }))).toBeNull();
  });
});

describe('FeedbackTab', () => {
  it('預設篩選待處理倒讚，顯示統計與清單；捲到底帶游標載下一頁', async () => {
    vi.mocked(api.listFeedback)
      .mockResolvedValueOnce({ items: [item()], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ items: [item({ id: 'f2', question: '加班費怎麼算？' })], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    await screen.findByText('特休幾天？');
    expect(api.listFeedback).toHaveBeenCalledWith('t1', { rating: 'down', status: 'open' }, undefined);
    expect(screen.getByText('待處理 1')).toBeInTheDocument();
    await act(async () => fireIntersect());
    await screen.findByText('加班費怎麼算？');
    expect(api.listFeedback).toHaveBeenLastCalledWith('t1', { rating: 'down', status: 'open' }, 'cur1');
  });

  it('詳情：回答以純文字顯示、列出檢索片段與判斷；可用這題測試檢索', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    const onTestRetrieval = vi.fn();
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={onTestRetrieval} />);
    fireEvent.click(await screen.findByText('特休幾天？'));
    expect(screen.getByText('**7 天**')).toBeInTheDocument(); // 不渲染 markdown
    expect(screen.getByText('請假規定')).toBeInTheDocument();
    expect(screen.getByText(/有檢索到資料/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用這題測試檢索' }));
    expect(onTestRetrieval).toHaveBeenCalledWith('特休幾天？', 'staff-001');
  });

  it('標為已處理附說明', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    vi.mocked(api.updateFeedback).mockResolvedValue(item({ status: 'resolved', resolutionNote: '已補文件' }));
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    fireEvent.click(await screen.findByText('特休幾天？'));
    fireEvent.change(screen.getByLabelText('處理說明'), { target: { value: '已補文件' } });
    fireEvent.click(screen.getByRole('button', { name: '標為已處理' }));
    await waitFor(() => expect(api.updateFeedback).toHaveBeenCalledWith('t1', 'f1', { status: 'resolved', resolutionNote: '已補文件' }));
  });

  it('切換篩選重新載入第一頁', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    await screen.findByText('沒有符合條件的回饋。');
    fireEvent.change(screen.getByLabelText('評價'), { target: { value: '' } });
    await waitFor(() => expect(api.listFeedback).toHaveBeenLastCalledWith('t1', { status: 'open' }, undefined));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd admin && npx vitest run src/pages/tabs/FeedbackTab.test.tsx`
Expected: FAIL，找不到 `./FeedbackTab`。

- [ ] **Step 3: Admin API client**

`admin/src/api.ts`：在 `AuditPage` 介面之後加：

```ts
export type FeedbackReasonKey = 'wrong' | 'not_answered' | 'outdated' | 'inappropriate' | 'other';

export interface FeedbackTraceChunk { rank: number; id: string; title: string; url?: string; score?: number; excerpt: string }

export interface FeedbackItem {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  replyId: string;
  serviceId: string;
  question: string;
  answer: string;
  trace?: {
    model?: string;
    retrieval?: { query: string; poolSize: number; usedTables: boolean; chunks: FeedbackTraceChunk[] };
    tools?: { name: string; ok: boolean }[];
    reportId?: string;
  };
  rating: 'up' | 'down';
  reason?: FeedbackReasonKey;
  comment?: string;
  status: 'open' | 'resolved';
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackPage { items: FeedbackItem[]; nextCursor: string | null }

export interface FeedbackStats {
  days: number;
  total: number;
  up: number;
  down: number;
  openDown: number;
  byService: Record<string, { up: number; down: number }>;
  byReason: Record<FeedbackReasonKey, number>;
}

export interface FeedbackFilterQuery {
  rating?: 'up' | 'down';
  serviceId?: string;
  reason?: FeedbackReasonKey;
  status?: 'open' | 'resolved';
}

function feedbackQuery(filter: FeedbackFilterQuery, before?: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  if (before) params.set('before', before);
  const s = params.toString();
  return s ? `?${s}` : '';
}
```

在 `api` 物件 `getPlatformAudit` 之後加：

```ts
  listFeedback: (id: string, filter: FeedbackFilterQuery, before?: string) =>
    req<FeedbackPage>('GET', `/admin/tenants/${id}/feedback${feedbackQuery(filter, before)}`),
  getFeedbackStats: (id: string, days: 7 | 30 | 90) =>
    req<FeedbackStats>('GET', `/admin/tenants/${id}/feedback/stats?days=${days}`),
  updateFeedback: (id: string, feedbackId: string, body: { status: 'open' | 'resolved'; resolutionNote?: string }) =>
    req<FeedbackItem>('PATCH', `/admin/tenants/${id}/feedback/${feedbackId}`, body),
```

- [ ] **Step 4: FeedbackTab**

`admin/src/pages/tabs/FeedbackTab.tsx`：

```tsx
/**
 * 租戶的 AI 回覆回饋：統計、可篩選的清單（每頁 10 筆、無限捲動）、詳情（問答、檢索紀錄、判斷、處理狀態）。
 * 回答一律以純文字顯示：後台不需要排版，也不讓回答裡的連結或圖片被渲染。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type FeedbackFilterQuery, type FeedbackItem, type FeedbackReasonKey, type FeedbackStats } from '../../api';

const REASON_LABEL: Record<FeedbackReasonKey, string> = {
  wrong: '答錯了',
  not_answered: '沒回答到問題',
  outdated: '資料過時',
  inappropriate: '內容不恰當',
  other: '其他',
};
const SERVICE_LABEL: Record<string, string> = { knowledge: '知識庫', agent: '智慧代理', form: '表單', report: '報告' };
const serviceLabel = (id: string): string => SERVICE_LABEL[id] ?? id;

const SCROLL_MAX_HEIGHT = 480;
const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', boxShadow: 'inset 0 -1px 0 var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, background: 'var(--card-bg)' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };
const tdNowrap: CSSProperties = { ...td, whiteSpace: 'nowrap' };

/** 一行初步判斷：依序套用第一條成立者（見設計文件 §7.3） */
export function diagnose(f: FeedbackItem): string | null {
  const chunks = f.trace?.retrieval?.chunks;
  if (f.serviceId === 'knowledge' && chunks && chunks.length === 0) {
    return '沒檢索到資料：知識庫可能缺這份內容，或提問者沒有權限看到';
  }
  if (f.reason === 'outdated') return '資料可能過時：請更新下列來源';
  if (f.reason === 'wrong' && chunks && chunks.length > 0) {
    return '有檢索到資料：請確認片段內容是否正確，或是模型理解錯誤';
  }
  return null;
}

type RatingFilter = '' | 'up' | 'down';
type StatusFilter = '' | 'open' | 'resolved';

export default function FeedbackTab({
  tenantId,
  onError,
  onTestRetrieval,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
  onTestRetrieval: (question: string, asUserId: string) => void;
}) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [rating, setRating] = useState<RatingFilter>('down');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [serviceId, setServiceId] = useState('');
  const [reason, setReason] = useState<'' | FeedbackReasonKey>('');
  const [rows, setRows] = useState<FeedbackItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  const loadingRef = useRef(false);

  const filter: FeedbackFilterQuery = {
    ...(rating ? { rating } : {}),
    ...(status ? { status } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(reason ? { reason } : {}),
  };
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    api.getFeedbackStats(tenantId, days).then(setStats).catch(onError);
  }, [tenantId, days, onError]);

  useEffect(() => {
    const gen = ++genRef.current;
    loadingRef.current = false;
    setRows(null);
    setCursor(null);
    setOpenId(null);
    api
      .listFeedback(tenantId, JSON.parse(filterKey) as FeedbackFilterQuery, undefined)
      .then((page) => {
        if (gen !== genRef.current) return;
        setRows(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (gen === genRef.current) onError(e);
      });
  }, [tenantId, filterKey, onError]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    const gen = genRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await api.listFeedback(tenantId, JSON.parse(filterKey) as FeedbackFilterQuery, cursor);
      if (gen !== genRef.current) return;
      setRows((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (gen === genRef.current) onError(e);
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [cursor, tenantId, filterKey, onError]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!cursor || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root: scrollRef.current, rootMargin: '0px 0px 80px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  async function updateStatus(f: FeedbackItem, next: 'open' | 'resolved') {
    try {
      const trimmed = note.trim();
      const updated = await api.updateFeedback(tenantId, f.id, { status: next, ...(trimmed ? { resolutionNote: trimmed } : {}) });
      setRows((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? prev);
      setNote('');
      api.getFeedbackStats(tenantId, days).then(setStats).catch(onError);
    } catch (e) {
      onError(e);
    }
  }

  const open = rows?.find((r) => r.id === openId);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">回饋統計</div>
            <div className="card-desc">使用者對 AI 回覆的評價。倒讚請點開查看當時的檢索紀錄，修正後標為已處理。</div>
          </div>
          <select className="input" aria-label="統計期間" value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}>
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </div>
        <div className="card-body">
          {!stats ? (
            <div className="row-sub">載入中…</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 14 }}>
              <div>評價 <strong>{stats.total}</strong></div>
              <div>讚 <strong>{stats.total ? Math.round((stats.up / stats.total) * 100) : 0}%</strong></div>
              <div className={stats.openDown > 0 ? 'badge badge-warn' : 'badge'}>{`待處理 ${stats.openDown}`}</div>
              <div>
                {Object.entries(stats.byService).map(([svc, c]) => (
                  <span key={svc} style={{ marginRight: 12 }}>{`${serviceLabel(svc)} 👍${c.up} 👎${c.down}`}</span>
                ))}
              </div>
              <div>
                {(Object.keys(REASON_LABEL) as FeedbackReasonKey[]).map((r) => (
                  <span key={r} style={{ marginRight: 12 }}>{`${REASON_LABEL[r]} ${stats.byReason[r]}`}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">回饋清單</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <select className="input" aria-label="評價" value={rating} onChange={(e) => setRating(e.target.value as RatingFilter)}>
              <option value="">全部評價</option>
              <option value="down">倒讚</option>
              <option value="up">讚</option>
            </select>
            <select className="input" aria-label="處理狀態" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="">全部狀態</option>
              <option value="open">待處理</option>
              <option value="resolved">已處理</option>
            </select>
            <select className="input" aria-label="服務" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">全部服務</option>
              {Object.entries(SERVICE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select className="input" aria-label="原因" value={reason} onChange={(e) => setReason(e.target.value as '' | FeedbackReasonKey)}>
              <option value="">全部原因</option>
              {(Object.keys(REASON_LABEL) as FeedbackReasonKey[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
        {/* 上方不留 padding：sticky 表頭只會貼到 padding 內緣（同 AuditTab） */}
        <div ref={scrollRef} className="card-body" style={{ overflow: 'auto', maxHeight: SCROLL_MAX_HEIGHT, paddingTop: 0 }}>
          {!rows ? (
            <div className="row-sub" style={{ paddingTop: 16 }}>載入中…</div>
          ) : rows.length === 0 ? (
            <div className="row-sub" style={{ paddingTop: 16 }}>沒有符合條件的回饋。</div>
          ) : (
            <>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
                <thead>
                  <tr>
                    <th style={th}>時間</th>
                    <th style={th}>使用者</th>
                    <th style={th}>服務</th>
                    <th style={th}>評價</th>
                    <th style={th}>問題</th>
                    <th style={th}>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} onClick={() => { setOpenId(f.id === openId ? null : f.id); setNote(f.resolutionNote ?? ''); }} style={{ cursor: 'pointer', background: f.id === openId ? 'var(--hover-bg, rgba(0,0,0,0.03))' : undefined }}>
                      <td style={tdNowrap}>{new Date(f.createdAt).toLocaleString()}</td>
                      <td style={tdNowrap}>{f.userId}</td>
                      <td style={tdNowrap}>{serviceLabel(f.serviceId)}</td>
                      <td style={tdNowrap}>{f.rating === 'up' ? '👍' : `👎 ${f.reason ? REASON_LABEL[f.reason] : ''}`}</td>
                      <td style={{ ...td, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.question}</td>
                      <td style={tdNowrap}>{f.status === 'open' ? '待處理' : '已處理'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
              <div className="row-sub" style={{ textAlign: 'center', padding: 8 }} aria-live="polite">
                {loading ? '載入中…' : cursor ? '' : '已顯示全部回饋'}
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">回饋詳情</div>
            <button type="button" className="btn" onClick={() => onTestRetrieval(open.question, open.userId)}>用這題測試檢索</button>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 12, fontSize: 14 }}>
            {diagnose(open) && <div className="badge badge-warn" style={{ justifySelf: 'start' }}>{diagnose(open)}</div>}
            <div><div className="row-sub">問題</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.question}</div></div>
            <div><div className="row-sub">回答</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.answer}</div></div>
            {open.comment && <div><div className="row-sub">使用者說明</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.comment}</div></div>}
            {open.trace?.retrieval && (
              <div>
                <div className="row-sub">{`檢索紀錄（問句：${open.trace.retrieval.query}；候選 ${open.trace.retrieval.poolSize} 筆${open.trace.retrieval.usedTables ? '；含資料表' : ''}）`}</div>
                {open.trace.retrieval.chunks.length === 0 ? (
                  <div>沒有交給模型的片段。</div>
                ) : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                    <tbody>
                      {open.trace.retrieval.chunks.map((c) => (
                        <tr key={c.rank}>
                          <td style={tdNowrap}>{`#${c.rank}`}</td>
                          <td style={tdNowrap}>{c.score !== undefined ? c.score.toFixed(3) : '—'}</td>
                          <td style={td}>
                            <div>{c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a> : c.title}</div>
                            <div className="row-sub" style={{ whiteSpace: 'pre-wrap' }}>{c.excerpt}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {open.trace?.tools && <div><div className="row-sub">呼叫的工具</div><div>{open.trace.tools.map((t) => `${t.name}${t.ok ? '' : '（失敗）'}`).join(' → ')}</div></div>}
            {open.trace?.model && <div className="row-sub">{`模型：${open.trace.model}`}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="input" aria-label="處理說明" placeholder="處理說明（選填）" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
              {open.status === 'open' ? (
                <button type="button" className="btn btn-primary" onClick={() => void updateStatus(open, 'resolved')}>標為已處理</button>
              ) : (
                <button type="button" className="btn" onClick={() => void updateStatus(open, 'open')}>重新開啟</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

> 確認 admin 既有的按鈕與 badge class 名稱：`grep -n "\.btn\b\|\.btn-primary\|\.badge-warn" admin/src/*.css | head`；若名稱不同，改用實際存在的 class。

- [ ] **Step 5: Tab wiring and KnowledgeTab prefill**

`admin/src/pages/TenantDetailPage.tsx`：
- 匯入 `import FeedbackTab from './tabs/FeedbackTab';`
- `TabKey` 型別加入 `'feedback'`（若是由 `TABS` 推導則免），`TABS` 在 `{ key: 'audit', label: '稽核' }` 之前加 `{ key: 'feedback', label: '回饋' },`
- 在 `{tab === 'audit' && ...}` 之前加：

```tsx
          {tab === 'feedback' && (
            <FeedbackTab
              tenantId={tenant.id}
              onError={handleErr}
              onTestRetrieval={(question, asUserId) => setSearchParams({ tab: 'knowledge', q: question, as: asUserId }, { replace: true })}
            />
          )}
```

`admin/src/pages/tabs/KnowledgeTab.tsx`：
- 匯入 `import { useSearchParams } from 'react-router-dom';`
- 把

```ts
  const [question, setQuestion] = useState("");
  const [asUserId, setAsUserId] = useState(""); // 試查身分：留空＝以管理者身分（見 test()）
```

改為

```ts
  // 從回饋分頁「用這題測試檢索」帶入：?q=問題&as=提問者，預填後由管理員按下測試
  const [searchParams] = useSearchParams();
  const [question, setQuestion] = useState(searchParams.get("q") ?? "");
  const [asUserId, setAsUserId] = useState(searchParams.get("as") ?? ""); // 試查身分：留空＝以管理者身分（見 test()）
  const testCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (searchParams.get("q")) testCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [searchParams]);
```

- 在「測試查詢」那張卡片（`<div className="card-title">測試查詢</div>` 所在的 `className="card"` 外層 div）加上 `ref={testCardRef}`。
- 確認 `useRef`、`useEffect` 已在該檔的 react 匯入中，沒有就補上。

- [ ] **Step 6: Run tests**

Run: `cd admin && npx vitest run && npx tsc --noEmit -p . && npx eslint src/pages/tabs/FeedbackTab.tsx src/pages/TenantDetailPage.tsx src/pages/tabs/KnowledgeTab.tsx src/api.ts`
Expected: 全部 PASS；typecheck、lint 無錯誤。

- [ ] **Step 7: Commit**

```bash
git add admin/src/api.ts admin/src/pages/tabs/FeedbackTab.tsx admin/src/pages/tabs/FeedbackTab.test.tsx admin/src/pages/TenantDetailPage.tsx admin/src/pages/tabs/KnowledgeTab.tsx
git commit -m "feat(admin): 新增租戶「回饋」分頁

- 統計：期間切換、讚比例、各服務讚倒讚、原因分布與待處理數
- 清單：預設待處理倒讚，可依評價、狀態、服務、原因篩選，每頁 10 筆無限捲動
- 詳情：問答純文字顯示、檢索片段與初步判斷、處理狀態與說明
- 「用這題測試檢索」以提問者身分預填知識庫檢索測試

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 全面驗證

**Files:** 無新增；僅執行與修正。

- [ ] **Step 1: Full test suites**

Run（各自在 repo 根目錄執行）：

```bash
(cd server && npx jest) && (cd client && npx vitest run) && (cd admin && npx vitest run) && (cd mobile/packages/app-core && npx jest)
```

Expected: 全部通過。

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck 無錯誤；lint 只剩分支開始前就存在的 `server/tests/confirm-form.test.ts:126` error 與既有 warnings。

- [ ] **Step 3: Manual check in the running app**

本機 server、client、admin 皆已啟動時：
1. client 問一題知識庫問題 → 回覆旁 hover 出現 👍／👎；按 👎 → 面板出現，選「資料過時」並送出 → 顯示「感謝回饋」。
2. admin 該租戶「回饋」分頁 → 統計「待處理 1」，清單出現該題；點開看到回答純文字、檢索片段、判斷「資料可能過時」。
3. 按「用這題測試檢索」→ 切到知識庫分頁，檢索測試已預填問題與身分。
4. 回到回饋分頁標為已處理 → 「稽核」分頁出現 `PATCH /tenants/<id>/feedback/<feedbackId>`。

- [ ] **Step 4: Report**

回報：各套件測試數、lint 狀態、手動檢查結果，以及 Task 4 Step 5 關於月配額的確認結果。
