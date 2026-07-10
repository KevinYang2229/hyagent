# Agent 提議寄信、經確認後送出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Agent 能協助寄信，但寄出必經使用者明確確認——LLM 只能「提議」（`email.propose`，存草稿不寄），真正送出由伺服器端確定性確認閘觸發（`email.send` 維持不暴露），LLM 無法自行寄出或被 injection 繞過。

**Architecture:** 新增 `email.propose` 工具（暴露 Agent、僅回草稿不寄）。Agent 服務 `dispatchTool` 攔截 `email.propose` 把草稿存入 `session.pendingEmail`；`handleTurn` 開頭設確認閘（pendingEmail 存在 + 本輪確認語意 → 直接 `email.send`）。因 Agent `sticky:false`，intent-router 在 `session.pendingEmail` 存在時強制路由回 agent，確認/處理後即清（無永久 trap）。

**Tech Stack:** TS/Express/Jest；既有件：[agent.agent-service.ts](../../../server/src/modules/conversation/agent.agent-service.ts)、[email.tools.ts](../../../server/src/modules/tools/email.tools.ts)、[tool-loop.ts](../../../server/src/modules/conversation/tool-loop.ts)、[intent-router.ts](../../../server/src/modules/conversation/intent-router.ts)、[conversation.types.ts](../../../server/src/modules/conversation/conversation.types.ts)。設計見 [spec](../specs/2026-07-11-agent-email-with-confirmation-design.md)。

## Global Constraints

- 語言：程式註解、訊息用繁體中文。
- 安全鐵則：`email.send` 維持**不** `agentExposed`；LLM 只能觸及 `email.propose`（不寄）。真正寄出**只**在 Agent 確認閘（伺服器端、非 LLM 判斷）。
- 所送即所存：確認閘寄的是 `session.pendingEmail`（propose 當下存的結構化草稿）。
- 未確認的 agent 輪一律清掉 `pendingEmail`（避免殘留 → 日後無關「確認」誤觸發舊信）。
- 仍需 `email:write`（租戶授予）；未授予 → Agent 的 `availableFor` 不含 `email.propose`。
- 測試以 fake LLMProvider 驅動、走 email stub、零外部依賴。
- 收尾：`cd server && npx jest` 全綠、`npm run typecheck`、`npm run build` 通過。

---

### Task 1: email.propose 工具（提議、不寄）

**Files:**
- Modify: `server/src/modules/tools/email.tools.ts`（加 `email.propose`）
- Test: `server/tests/email-propose-tool.test.ts`

**Interfaces:**
- Produces: 註冊工具 `email.propose`（`agentExposed: true`；`scopes: ['email:write']`；input `{to,subject,html}` 同 `email.send`；handler **不寄**，回 `{ proposed: true, draft: input }`）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/email-propose-tool.test.ts`:

```ts
/** email.propose：暴露給 Agent、需 email:write、回草稿但不寄（stub 無寄件）。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email.propose 工具', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('已註冊、授予 email:write 時出現在 Agent availableFor', () => {
    expect(toolRegistry.has('email.propose')).toBe(true);
    const t = tenantStore.createTenant('propose-avail');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    expect(toolRegistry.availableFor(ctx).map((x) => x.name)).toContain('email.propose');
  });

  it('invoke 回草稿但不寄出（stubSentEmails 為空）', async () => {
    const t = tenantStore.createTenant('propose-nosend');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const res = (await toolRegistry.invoke(
      'email.propose',
      { to: 'a@x.com', subject: '嗨', html: '<p>hi</p>' },
      ctx,
    )) as { proposed: boolean; draft: { to: string } };
    expect(res.proposed).toBe(true);
    expect(res.draft.to).toBe('a@x.com');
    expect(stubSentEmails).toHaveLength(0); // 沒真的寄
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

在 `server/src/modules/tools/email.tools.ts` 既有 `email.send` 註冊之後加入：

```ts
registerTool({
  id: 'email.propose',
  description: '擬一封通知信草稿（不會立即寄出）；供 Agent 出示給使用者、待其確認後才送。',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      html: { type: 'string' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  agentExposed: true,
  scopes: ['email:write'],
  // 不寄：只回草稿。實際寄出由 Agent 確認閘以 email.send 觸發。
  handler: (input: { to: string; subject: string; html: string }) =>
    Promise.resolve({ proposed: true, draft: input }),
});
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/email-propose-tool.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tools/email.tools.ts server/tests/email-propose-tool.test.ts
git commit -m "feat(tools): email.propose 工具（暴露 Agent、擬稿不寄）"
```

---

### Task 2: Session.pendingEmail + Agent 確認閘 + dispatchTool 攔截

**Files:**
- Modify: `server/src/modules/conversation/conversation.types.ts`（`Session` 加 `pendingEmail?`）
- Modify: `server/src/modules/conversation/agent.agent-service.ts`（確認閘 + dispatchTool 攔截 propose + prompt/intent 補述）
- Test: `server/tests/agent-email.test.ts`

**Interfaces:**
- Consumes: `email.propose`（Task 1）、既有 `toolRegistry`/`makeToolContext`/`runToolLoop`、`EmailSendResult`（`@/lib/email/types`）。
- Produces:
  - `Session.pendingEmail?: { to: string; subject: string; html: string }`
  - Agent `handleTurn` 確認閘：pendingEmail + 確認語意 → `email.send` 送出、清 pending、回「已寄出」；非確認 → 清 pending 後走 tool-loop。
  - `dispatchTool` 對 `email.propose`：invoke 後把 `draft` 存入 `session.pendingEmail`，回覆指示 LLM 出示草稿並徵求確認、勿宣稱已寄。

- [ ] **Step 1: 寫失敗測試**

`server/tests/agent-email.test.ts`:

```ts
/** Agent 寄信確認流程（fake LLM）：propose 存草稿不寄；確認才寄；取消不寄；email.send 不可被 Agent 直呼。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

const usage = { inputTokens: 1, outputTokens: 1 };
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}
function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's-email',
    tenantId,
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我寄信給王經理' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('Agent 寄信確認流程', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('LLM 呼 email.propose → 存草稿、不寄', async () => {
    const t = tenantStore.createTenant('agent-email-propose');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'email.propose', input: { to: 'boss@x.com', subject: '會議改期', html: '<p>...</p>' } }], stopReason: 'tool_use', usage },
      { text: '我已擬好給 boss@x.com 的信，主旨「會議改期」，確認寄出嗎？', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession(t.id);
    await agentAgentService.handleTurn(session, '幫我寄信給王經理', llm);

    expect(stubSentEmails).toHaveLength(0); // 尚未寄
    expect(session.pendingEmail?.to).toBe('boss@x.com'); // 草稿已存
  });

  it('有 pendingEmail + 使用者確認 → 伺服器端寄出、清草稿（LLM 不參與）', async () => {
    const t = tenantStore.createTenant('agent-email-confirm');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    // fake LLM 不該被呼叫到（確認走快速路徑）；給一個會 throw 的以確保沒進 loop
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: '會議改期', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, '確認', llm);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingEmail).toBeUndefined();
    expect(res.reply).toContain('已寄出');
  });

  it('有 pendingEmail + 使用者取消 → 不寄、清草稿', async () => {
    const t = tenantStore.createTenant('agent-email-cancel');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([{ text: '好的，已取消。', toolCalls: [], stopReason: 'end_turn', usage }]);
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    await agentAgentService.handleTurn(session, '不要，取消', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingEmail).toBeUndefined();
  });

  it('LLM 幻想直呼 email.send 被擋（不在 availableFor / allowlist）', async () => {
    const t = tenantStore.createTenant('agent-email-nosend');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'email.send', input: { to: 'x@x.com', subject: 's', html: '<p>x</p>' } }], stopReason: 'tool_use', usage },
      { text: '抱歉，我無法直接寄出。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession(t.id);
    await agentAgentService.handleTurn(session, '直接幫我寄', llm);
    expect(stubSentEmails).toHaveLength(0);
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string } | undefined;
    expect(tr?.content).toContain('工具不可用');
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`conversation.types.ts` 的 `Session` 介面加（`submission?` 附近）：

```ts
  /** Agent 待使用者確認的寄信草稿；確認後由確認閘以 email.send 送出，非確認的 agent 輪一律清空。 */
  pendingEmail?: { to: string; subject: string; html: string };
```

`agent.agent-service.ts`：

頂部 import 加 `import type { EmailSendResult } from '@/lib/email/types';`。

加確認/取消語意判斷（檔案內、service 之前）：

```ts
const EMAIL_CONFIRM_RE = /(確認|確定|寄出|寄|送出|可以寄|幫我寄|同意寄出|OK|ok)/;
const EMAIL_CANCEL_RE = /(不要|先不要|別|取消|不寄|暫停|改)/;
function isEmailConfirmation(text: string): boolean {
  const s = text.trim();
  if (!s || EMAIL_CANCEL_RE.test(s)) return false;
  return EMAIL_CONFIRM_RE.test(s);
}
```

`handleTurn` 改為（把 `_userText` 改成 `userText`，開頭加確認閘）：

```ts
  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });

    // 確認閘：有待確認草稿且本輪為確認語意 → 伺服器端直接寄出（LLM 全程碰不到 email.send）
    if (session.pendingEmail && isEmailConfirmation(userText)) {
      const pending = session.pendingEmail;
      session.pendingEmail = undefined;
      let reply: string;
      try {
        const r = (await toolRegistry.invoke('email.send', pending, ctx)) as EmailSendResult;
        reply = `已寄出，messageId：${r.messageId}。`;
      } catch (err) {
        reply = `寄送失敗：${(err as Error).message}`;
      }
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      logger.info({ sessionId: session.id, to: pending.to }, 'agent email sent (confirmed)');
      return { reply };
    }
    // 非確認 → 讓上一份草稿過期（避免殘留被日後無關「確認」誤觸發），再走 tool-loop（可能重新提議）
    session.pendingEmail = undefined;

    const tools = toolRegistry.availableFor(ctx);
    const allowed = new Set(tools.map((t) => t.name));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.userId, session.locale),
      tools,
      dispatchTool: async (name, input) => {
        if (!allowed.has(name)) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const result = await toolRegistry.invoke(name, input, ctx);
          // 提議寄信：存草稿、指示 LLM 出示並徵求確認，切勿宣稱已寄
          if (name === 'email.propose') {
            session.pendingEmail = (result as { draft: { to: string; subject: string; html: string } }).draft;
            return JSON.stringify({
              ok: true,
              proposed: true,
              note: '草稿已存。請把收件人、主旨、內文完整出示給使用者，並請他回覆「確認」才會寄出；切勿宣稱已寄出。',
            });
          }
          return JSON.stringify({ ok: true, result });
        } catch (err) {
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    });

    logger.info({ sessionId: session.id, toolCount: tools.length }, 'agent turn complete');
    return { reply };
  },
```

`buildSystemPrompt` 增補一行工作方式（在既有清單內加）：

```ts
    '- 需要寄信時：呼叫 email.propose 擬稿（不會立即寄出），然後把收件人、主旨、內文清楚出示給使用者，請他確認；使用者回覆「確認」後系統才會寄出。你無法自行寄出。',
```

`intents()` 的 `description` 改為涵蓋寄信，讓分類器把寄信請求路由到 agent：

```ts
        description:
          '需要操作公司系統/工具的任務，例如查詢並彙整多項資料、代擬並（經確認後）寄送通知信 Email。',
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/agent-email.test.ts` → PASS（4 tests）；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/conversation/conversation.types.ts server/src/modules/conversation/agent.agent-service.ts server/tests/agent-email.test.ts
git commit -m "feat(agent): 寄信確認閘（email.propose 擬稿→使用者確認→email.send 送出）"
```

---

### Task 3: intent-router 於 pendingEmail 時路由回 agent

**Files:**
- Modify: `server/src/modules/conversation/intent-router.ts`
- Test: `server/tests/agent-email-routing.test.ts`

**Interfaces:**
- Produces: `intentRouter.route(session, text)` 在 `session.pendingEmail` 存在且 agent 啟用時回 `{ serviceId: 'agent', viaLLM: false }`（讓確認/取消輪回到 agent 的確認閘）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/agent-email-routing.test.ts`:

```ts
/** pendingEmail 存在時，路由強制回 agent（讓確認閘收到確認/取消輪）。 */
import { intentRouter } from '@/modules/conversation/intent-router';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's', tenantId, userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', activeServiceId: 'agent', messages: [],
    createdAt: new Date().toISOString(), ...partial,
  };
}

it('有 pendingEmail → 路由回 agent（0 token）', async () => {
  const t = tenantStore.createTenant('email-route');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
  const session = makeSession(t.id, { pendingEmail: { to: 'a@x.com', subject: 's', html: '<p>x</p>' } });
  const r = await intentRouter.route(session, '確認');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false);
});

it('無 pendingEmail → 不強制 agent（一般路由）', async () => {
  const t = tenantStore.createTenant('email-route-none');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  const session = makeSession(t.id, { activeServiceId: undefined });
  const r = await intentRouter.route(session, '我要請假');
  expect(r.serviceId).not.toBe('agent'); // 應走 form（關鍵字命中）
});
```

- [ ] **Step 2: 失敗 → 實作**

在 `intent-router.ts` 的 `route()` 內，計算出 `enabled` / `enabledIds` 之後、既有點黏/關鍵字邏輯之前，插入：

```ts
    // 待確認寄信草稿：本輪強制回 agent，讓確認閘處理確認/取消（agent sticky=false，否則收不到此輪）
    if (session.pendingEmail && enabledIds.has('agent')) {
      return { serviceId: 'agent', viaLLM: false };
    }
```

> read-before-edit：確認 `route()` 內 `enabledIds` 變數名與插入位置（在 `const enabled = serviceRegistry.enabledFor(...)` 與 `enabledIds` 之後）。

- [ ] **Step 3: 綠 + 全套 + 型別 + build + commit**

Run: `cd server && npx jest tests/agent-email-routing.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤；`cd "$(git rev-parse --show-toplevel)" && npm run build` → 成功

```bash
git add server/src/modules/conversation/intent-router.ts server/tests/agent-email-routing.test.ts
git commit -m "feat(conversation): pendingEmail 時路由回 agent，確認閘方能收到確認輪"
```

---

## 完成後狀態（驗收）

- Agent 能協助寄信：LLM 呼 `email.propose` 擬稿、出示收件人/主旨/內文、請使用者確認；使用者回「確認」→ 伺服器端確認閘以 `email.send` 送出。
- 安全：LLM 無法自行寄出（`email.send` 不暴露 + 確認閘為伺服器端判斷）；未確認的 agent 輪一律清 `pendingEmail`（無殘留誤觸發）；仍需 `email:write` 授予。
- 路由：`pendingEmail` 存在時強制回 agent，確認/取消後即清（無永久 trap）。
- 全套測試綠、typecheck/build 綠。

## Self-Review 註記

- **Spec 覆蓋**：D2 確定性確認閘、D3 兩工具、D4 所送即所存、D1 不限收件人（確認閘為最後防線）。router 於 pendingEmail 強制回 agent 是 D2「確認輪要收得到」的必要配套（sticky=false 下）。
- **型別一致**：`Session.pendingEmail`、`email.propose` 的 `{proposed,draft}`、確認閘用 `EmailSendResult` 一致。
- **安全**：`email.send` 全程不 agentExposed；確認閘寄的是 `session.pendingEmail`（非 LLM 文字）；非確認輪清 pending（防日後誤觸發）。測試涵蓋 propose-不寄 / 確認-寄 / 取消-不寄 / 直呼 send-被擋。
- **已知 v1 限制**：提議後若以「無關請求」放棄，該輪被強制回 agent（無 form 工具 → 回「無法處理」），pending 隨即清空、下一輪恢復正常——一輪 hiccup，非永久 trap；為安全（不留殘留草稿）之取捨。
