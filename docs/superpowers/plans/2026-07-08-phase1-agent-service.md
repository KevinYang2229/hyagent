# Phase 1：Agent 服務（機制先行，只接安全工具）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第四個對話服務「Agent」——把「該使用者有權限、且被允許暴露」的工具交給 LLM 自選，靠既有 tool-loop 多輪往返完成開放式任務；第一版只暴露唯讀安全工具（`oa.getLeaveBalance`），送單仍走 Form。

**Architecture:** 兩層改動。(1) Tool Registry 新增 `availableFor(ctx): LLMTool[]`，只回「`agentExposed` 且 scope 允許」的工具，並在 `ToolDef` 加安全預設旗標 `agentExposed`。(2) 新增 `agent.agent-service.ts`（`AgentService` 契約），`handleTurn` 以 `availableFor` 取工具、用 `runToolLoop` 驅動；`dispatchTool` 只放行 `availableFor` 清單內的工具（LLM 幻想出別的工具名也呼叫不到，送單等寫入動作因此不會被 Agent 觸發），工具錯誤回傳為 tool_result 讓 LLM 自行修正而非中斷整輪。註冊進 `service.registry`（最後一個），Intent Router 無需改碼。

**Tech Stack:** TypeScript (NodeNext)、Express、Jest + ts-jest。路徑別名 `@/` → `server/src/`。既有可重用件：[tool-loop.ts](../../../server/src/modules/conversation/tool-loop.ts)（`runToolLoop`）、[toolRegistry](../../../server/src/modules/tools/tool.registry.ts)、[AgentService 契約](../../../server/src/modules/conversation/agent-service.types.ts)。

## Global Constraints

- 語言：程式註解與訊息用繁體中文，與現有檔案一致。
- 測試框架：Jest，測試檔放 `server/tests/*.test.ts`，跑法 `cd server && npx jest <file>`。
- 錯誤處理：`AppError.*`（`@/utils/app-error`）。
- 安全鐵則（本階段核心）：Agent 只能取用並執行 `agentExposed === true` 的工具。`agentExposed` 為安全預設——未標＝不暴露。`oa.submitForm`（寫入）本階段**不**標 `agentExposed`；只有 `oa.getLeaveBalance`（唯讀）標記暴露。
- 向後相容：新增服務不得破壞既有行為。`agent` 服務必須註冊在 `form/knowledge/assistant` **之後**（保留 router fallback `enabled[0]='form'` 與 `serviceRegistry.all()[0]='form'`）。`agent` 的 `intents().keywords` 必須為空陣列（避免關鍵字路由誤搶既有服務）。
- 收尾驗收：`cd server && npx jest` 全綠、根目錄 `npm run typecheck` 通過。
- 不改動 `intent-router.ts`、`tool-loop.ts`、`conversation.service.ts`、任何連接器或 `oa.submitForm` 的行為。

---

### Task 1: Tool Registry 新增 `availableFor` + `agentExposed` 安全旗標

**Files:**
- Modify: `server/src/modules/tools/tool.types.ts`（`ToolDef` 加 `readonly agentExposed?: boolean`）
- Modify: `server/src/modules/tools/tool.registry.ts`（加 `availableFor`；import `LLMTool`）
- Modify: `server/src/modules/tools/oa.tools.ts`（`oa.getLeaveBalance` 加 `agentExposed: true`）
- Test: `server/tests/tool-available.test.ts`

**Interfaces:**
- Consumes: `LLMTool`（`@/lib/llm/types`：`{ name: string; description: string; inputSchema: Record<string, unknown> }`）、既有 `ToolContext`/`ToolDef`、`hasScopes`（registry 內部）、registry 內部 `Entry { tool: ToolDef; validate }`（見現有 `tool.registry.ts`）。
- Produces: `toolRegistry.availableFor(ctx: ToolContext): LLMTool[]` — 回傳「`tool.agentExposed === true` 且 `hasScopes(ctx.scopes, tool.scopes)`」的工具，映射為 `{ name: tool.id, description: tool.description, inputSchema: tool.inputSchema }`。

- [ ] **Step 1: 寫失敗測試**

`server/tests/tool-available.test.ts`:

```ts
/**
 * toolRegistry.availableFor：只回「agentExposed 且 scope 允許」的工具，映射為 LLMTool。
 * 安全預設：未標 agentExposed 的工具（含 oa.submitForm）一律不暴露給 Agent。
 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import { makeToolContext } from '@/modules/tools/tool.context';
import type { ToolContext } from '@/modules/tools/tool.types';
import '@/modules/tools/oa.tools'; // 副作用註冊 OA 工具

describe('toolRegistry.availableFor', () => {
  it('只回傳 agentExposed 且 scope 允許的工具，並映射為 LLMTool', () => {
    const tools = toolRegistry.availableFor(makeToolContext({ tenantId: 'default', userId: 'kevin' }));
    const names = tools.map((t) => t.name);
    expect(names).toContain('oa.getLeaveBalance'); // 唯讀、已暴露
    expect(names).not.toContain('oa.submitForm'); // 寫入、未暴露
    const bal = tools.find((t) => t.name === 'oa.getLeaveBalance');
    expect(bal?.description).toBe('查詢某使用者各假別的剩餘時數。');
    expect(bal?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('未標 agentExposed 的工具一律不暴露（安全預設）', () => {
    registerTool({
      id: 'test.hidden',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: [],
      handler: async () => 'ok',
    });
    const tools = toolRegistry.availableFor({ tenantId: 't', userId: 'u', scopes: ['*'] });
    expect(tools.map((t) => t.name)).not.toContain('test.hidden');
  });

  it('scope 不足時排除 agentExposed 工具', () => {
    registerTool({
      id: 'test.needsScope',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['special:read'],
      agentExposed: true,
      handler: async () => 'ok',
    });
    const wild: ToolContext = { tenantId: 't', userId: 'u', scopes: ['*'] };
    expect(toolRegistry.availableFor(wild).map((t) => t.name)).toContain('test.needsScope');
    const limited: ToolContext = { tenantId: 't', userId: 'u', scopes: ['oa:read'] };
    expect(toolRegistry.availableFor(limited).map((t) => t.name)).not.toContain('test.needsScope');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/tool-available.test.ts`
Expected: FAIL（`toolRegistry.availableFor is not a function`）

- [ ] **Step 3: 加 `agentExposed` 到 ToolDef**

在 `server/src/modules/tools/tool.types.ts` 的 `ToolDef` 介面內、`handler` 之前加入：

```ts
  /**
   * 是否可暴露給自主 Agent 由 LLM 自選（安全預設：未標＝不暴露）。
   * 只有唯讀/安全工具應 opt-in；送單等有副作用的工具在明確啟用前一律不暴露，
   * 避免 LLM 自行執行寫入動作。
   */
  readonly agentExposed?: boolean;
```

- [ ] **Step 4: 加 `availableFor` 到 toolRegistry**

在 `server/src/modules/tools/tool.registry.ts`：

頂部 import 區加入：

```ts
import type { LLMTool } from '@/lib/llm/types';
```

在 `toolRegistry` 物件內（`invoke` 之後）加入方法：

```ts
  /**
   * Agent 專用：列出「agentExposed 且 ctx.scopes 允許」的工具，映射為 LLMTool 供 LLM 自選。
   * 未標 agentExposed 的工具（含寫入工具）不會出現，是本層的安全邊界。
   */
  availableFor(ctx: ToolContext): LLMTool[] {
    const tools: LLMTool[] = [];
    for (const { tool } of registry.values()) {
      if (!tool.agentExposed) continue;
      if (!hasScopes(ctx.scopes, tool.scopes)) continue;
      tools.push({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema });
    }
    return tools;
  },
```

- [ ] **Step 5: 把 `oa.getLeaveBalance` 標記為可暴露**

在 `server/src/modules/tools/oa.tools.ts` 的 `oa.getLeaveBalance` 註冊物件內，於 `scopes: ['oa:read'],` 之後加一行：

```ts
  agentExposed: true,
```

（`oa.submitForm` 維持不標——寫入工具本階段不暴露給 Agent。）

- [ ] **Step 6: 跑測試確認通過**

Run: `cd server && npx jest tests/tool-available.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 7: 全套 + 型別（確認未回歸）**

Run: `cd server && npx jest`
Expected: 全數 PASS（既有 tool-registry / oa-tools 等不受影響）

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/tools/tool.types.ts server/src/modules/tools/tool.registry.ts server/src/modules/tools/oa.tools.ts server/tests/tool-available.test.ts
git commit -m "feat(tools): availableFor 列出可暴露給 Agent 的工具 + agentExposed 安全旗標"
```

---

### Task 2: Agent 服務 + 註冊為第四個服務

**Files:**
- Create: `server/src/modules/conversation/agent.agent-service.ts`
- Modify: `server/src/modules/conversation/service.registry.ts`（import + `register(agentAgentService)`，放在最後）
- Modify: `server/tests/service-enabled.test.ts`（啟用服務集合斷言加入 `'agent'`）
- Test: `server/tests/agent-service.test.ts`

**Interfaces:**
- Consumes: `AgentService`/`AgentTurnResult`/`IntentDescriptor`（`./agent-service.types`）、`Session`（`./conversation.types`）、`runToolLoop`（`./tool-loop`）、`makeToolContext`/`toolRegistry`（`@/modules/tools`）、`languageDirective`（`@/lib/locale`）、`LLMProvider`（`@/lib/llm/types`）、Task 1 的 `toolRegistry.availableFor`。
- Produces: `export const agentAgentService: AgentService`（`id: 'agent'`, `label: '智慧代理'`, `sticky: true`, `intents()` 回一個 `agent.task` 描述、keywords 為空, `handleTurn` 用 availableFor + runToolLoop）。

> 註（sticky 語意）：`sticky: true` 依藍圖 D4 設定，但目前 `intent-router` 的點黏閘以 form 狀態（collecting/confirming）為條件，唯讀 Agent 不設這些狀態，故第一版 stickiness 實際不作用——v1 的 Agent 任務為單輪自足，可接受；多輪 Agent 狀態留待後續（有 Calendar/Email 的多步驟任務時）再處理。

- [ ] **Step 1: 寫失敗測試**

`server/tests/agent-service.test.ts`:

```ts
/**
 * Agent 服務：以 fake LLMProvider 驅動 tool-loop，驗證
 * (1) LLM 自選工具→實際 invoke→回覆；(2) 安全允許清單擋下未暴露的寫入工具；(3) 註冊為第四服務。
 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import type { Session } from '@/modules/conversation/conversation.types';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's-agent',
    tenantId: 'default',
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我查特休還剩多少' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

const usage = { inputTokens: 1, outputTokens: 1 };

function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

function lastToolResult(session: Session): string | undefined {
  const block = session.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  return block && block.type === 'tool_result' ? block.content : undefined;
}

describe('agentAgentService', () => {
  it('LLM 選擇 oa.getLeaveBalance → 實際 invoke → 回覆最終文字', async () => {
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'oa.getLeaveBalance', input: { userId: 'kevin' } }], stopReason: 'tool_use', usage },
      { text: '你的特休查詢已完成。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession();
    const res = await agentAgentService.handleTurn(session, '幫我查特休還剩多少', llm);

    expect(res.reply).toBe('你的特休查詢已完成。');
    expect(lastToolResult(session)).toContain('"ok":true'); // 工具確實被執行
  });

  it('LLM 呼叫未暴露的寫入工具（oa.submitForm）被允許清單擋下，不會真的送出', async () => {
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'oa.submitForm', input: { formId: 'x', oa: {}, source: {} } }], stopReason: 'tool_use', usage },
      { text: '抱歉，我無法直接送出表單。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession();
    const res = await agentAgentService.handleTurn(session, '直接幫我送假單', llm);

    expect(lastToolResult(session)).toContain('工具不可用');
    expect(JSON.stringify(session.messages)).not.toContain('STUB-'); // 沒有任何送出單號
    expect(res.reply).toBe('抱歉，我無法直接送出表單。');
  });

  it('已註冊為服務且提供 agent.task 意圖（keywords 為空）', () => {
    expect(serviceRegistry.get('agent')).toBe(agentAgentService);
    const intents = agentAgentService.intents(makeSession());
    expect(intents.map((i) => i.id)).toContain('agent.task');
    expect(intents.every((i) => i.keywords.length === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/agent-service.test.ts`
Expected: FAIL（`Cannot find module '@/modules/conversation/agent.agent-service'`）

- [ ] **Step 3: 建立 Agent 服務**

`server/src/modules/conversation/agent.agent-service.ts`:

```ts
/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：dispatchTool 只放行 availableFor 清單內的工具；LLM 即使幻想出別的工具名也呼叫不到
 * （送單等寫入動作因此不會被 Agent 觸發）。工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=true 依藍圖設定；目前 router 的點黏閘以 form 狀態為條件，唯讀 Agent 尚不觸發（見 plan 註）。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { languageDirective } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { runToolLoop } from './tool-loop';

function buildSystemPrompt(locale?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是公司 OA 系統的智慧代理，協助使用者完成需要操作公司系統的任務。${languageDirective(locale)}`,
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    '工作方式：',
    '- 只能使用提供給你的工具；沒有合適工具時，據實說明目前無法完成，不要捏造結果或假裝已完成。',
    '- 需要時可連續呼叫多個工具，依回傳結果決定下一步，完成後用簡潔中文回覆使用者。',
    '- 工具回傳錯誤時，向使用者說明狀況或改用其他方式，不要重複無效呼叫。',
    '- 只處理與公司 OA 相關的任務；與公司無關的一般問題請禮貌婉拒。',
  ].join('\n');
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  sticky: true,

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'agent.task',
        keywords: [],
        description:
          '需要一次操作多個公司系統/工具、且多步驟才能完成的複合任務（例如同時查詢並彙整多項資料）',
      },
    ];
  },

  async handleTurn(session: Session, _userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });
    const tools = toolRegistry.availableFor(ctx);
    const allowed = new Set(tools.map((t) => t.name));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.locale),
      tools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具，LLM 幻想出別的名字一律擋下
        if (!allowed.has(name)) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const result = await toolRegistry.invoke(name, input, ctx);
          return JSON.stringify({ ok: true, result });
        } catch (err) {
          // 工具錯誤（權限/驗證/連接器）回傳給 LLM 自行修正，不中斷整輪
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    });

    logger.info({ sessionId: session.id, toolCount: tools.length }, 'agent turn complete');
    return { reply };
  },
};
```

- [ ] **Step 4: 註冊為第四個服務（放最後）**

在 `server/src/modules/conversation/service.registry.ts`：

import 區加入（與既有 service import 並列）：

```ts
import { agentAgentService } from './agent.agent-service';
```

在既有 `register(assistantAgentService);` **之後**加入（務必最後，保留 fallback `enabled[0]='form'`）：

```ts
register(agentAgentService);
```

- [ ] **Step 5: 更新既有 service-enabled 斷言（因新增服務）**

在 `server/tests/service-enabled.test.ts`，把第一個斷言的期望陣列由 `['assistant', 'form', 'knowledge']` 改為含 `'agent'`（保持字母排序）：

```ts
  expect(serviceRegistry.enabledFor(t.id).map((s) => s.id).sort()).toEqual([
    'agent',
    'assistant',
    'form',
    'knowledge',
  ]);
```

並把停用 knowledge 後的斷言由 `['assistant', 'form']` 改為：

```ts
  expect(serviceRegistry.enabledFor(t.id).map((s) => s.id).sort()).toEqual(['agent', 'assistant', 'form']);
```

- [ ] **Step 6: 跑新測試確認通過**

Run: `cd server && npx jest tests/agent-service.test.ts tests/service-enabled.test.ts`
Expected: PASS（agent-service 3 tests + service-enabled 2 tests）

- [ ] **Step 7: 全套 + 型別（收尾驗收：零既有回歸）**

Run: `cd server && npx jest`
Expected: 全數 PASS（特別確認 `intent-router.test.ts` 仍綠——agent keywords 為空、分類器測試以 mock 驅動，不受影響）

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/conversation/agent.agent-service.ts server/src/modules/conversation/service.registry.ts server/tests/agent-service.test.ts server/tests/service-enabled.test.ts
git commit -m "feat(agent): 新增 Agent 服務（LLM 自選工具）並註冊為第四個對話服務"
```

---

## 完成後狀態（Phase 1 驗收）

- 四個平行服務就位：form / knowledge / assistant / **agent**。
- Agent 機制完整：`availableFor`（scope + agentExposed 過濾）→ `runToolLoop`（LLM 自選）→ `dispatchTool`（允許清單守門 + 錯誤回饋）。
- 安全性可驗證：LLM 呼叫未暴露的 `oa.submitForm` 被擋、不會送出（測試涵蓋）。
- 第一版能力＝唯讀（`oa.getLeaveBalance`）；送單仍走 Form。
- 零既有回歸：`npx jest` 全綠、`typecheck` 通過；Intent Router 未改碼（僅多一個服務進分類器目錄）。
- 為 Phase 2 留好 seam：接了 Email/Calendar 工具並標 `agentExposed` 後，Agent 能做的事自然變多，服務碼不必再改。

## Self-Review 註記

- **Spec 覆蓋**：對應藍圖 §6.4（Agent 重用 tool-loop、availableFor+invoke、LLM 自選）、§4.2（availableFor）、§8 Phase 1（用既有 OA 工具、跨步驟可跑）。「只接安全工具」以 `agentExposed` 安全預設落地並由測試把關。
- **型別一致**：`availableFor(ctx): LLMTool[]`、`ToolDef.agentExposed?`、`agentAgentService: AgentService` 跨 Task 一致；`LLMTool`/`LLMResult`/`Session`/`IntentDescriptor` 皆取自既有型別。
- **無 placeholder**：每步含完整程式碼；既有測試更新（service-enabled）給了逐字前後值。
- **向後相容風險**：新增 enabled 服務會改變 `serviceRegistry.enabledFor` 集合 → 已於 Task 2 Step 5 明確更新唯一硬斷言該集合的測試；`agent` 註冊在最後 + keywords 空，保留 router fallback 與關鍵字路由行為。
