# Workflow：查簽核/我的申請/催辦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 員工可在對話中問「我的假單簽到哪了？」「我有哪些申請？」並接「幫我催一下」——由既有 Agent 以兩個身分綁定的唯讀工具回答；催辦複用 email.propose→確認→寄出。

**Architecture:** ①每租戶 submissions store（送出時在 `resolveSubmit` 漏斗 best-effort 記錄）②兩個唯讀工具 `oa.listMyRequests`/`oa.getApprovalStatus`（agentExposed、`oa:read`、身分綁 ctx；進度以 `computeApprovals` 查詢時重算）③Agent 關鍵字＋prompt 接線。設計見 [spec](../specs/2026-07-11-workflow-approval-query-design.md)。

**Tech Stack:** TS/Express/Jest。既有件：[form-submit.registry.ts](../../../server/src/modules/conversation/form-submit.registry.ts)（`resolveSubmit` 包裝、`notifyOnSubmit` 樣板）、[approvals.ts](../../../server/src/modules/form/approvals.ts)（`stepDefs`/`computeApprovals`）、[form.registry.ts](../../../server/src/modules/form/form.registry.ts)（`tryGetDefinition`）、[data-dir.ts](../../../server/src/lib/data-dir.ts)（`dataFile`）、[oa.tools.ts](../../../server/src/modules/tools/oa.tools.ts)、[agent.agent-service.ts](../../../server/src/modules/conversation/agent.agent-service.ts)。

## Global Constraints

- 語言：程式註解、訊息用繁體中文。
- 身分綁定鐵則：兩工具一律以 `ctx.userId`/`ctx.tenantId` 為準；`listMyRequests` 不收 userId；`getApprovalStatus` 必驗擁有者，非本人回「查無」（不拋錯，讓 LLM 好好回話）。
- 記錄為旁路：store 記錄失敗**不得影響送出**（try/catch 吞掉，比照 notifyOnSubmit）。
- 唯讀工具不標 `audit`；催辦走既有 email.propose 流程，零新機制。
- 測試用新建租戶（隔離已就緒）；`ApprovalStep = {name, type, status: 'current'|'pending'|'approved'|'rejected'}`。
- 收尾：`cd server && npx jest` 全綠、`npm run typecheck`、`npm run build` 通過。

---

### Task 1: submissions store + 送出時記錄

**Files:**
- Create: `server/src/modules/workflow/submission.store.ts`
- Modify: `server/src/modules/conversation/form-submit.registry.ts`（`resolveSubmit` 包裝層加 best-effort 記錄）
- Test: `server/tests/submission-store.test.ts`

**Interfaces:**
- Produces:
  - `interface SubmissionRecord { oaRequestId: string; formId: string; formTitle: string; userId: string; submittedAt: string }`
  - `submissionStore.record(tenantId, rec)`（每租戶上限 200 捨最舊 + 持久化）
  - `submissionStore.listByUser(tenantId, userId, limit=10): SubmissionRecord[]`（新→舊、只回該 userId）
  - `submissionStore.find(tenantId, oaRequestId): SubmissionRecord | undefined`
  - `submissionStore.clear()`（測試）

- [ ] **Step 1: 寫失敗測試**

`server/tests/submission-store.test.ts`:

```ts
/** submissions store：record/listByUser（新→舊、只回本人）/find/上限捨舊/租戶隔離；送出漏斗會記錄且失敗不影響送出。 */
import { submissionStore, type SubmissionRecord } from '@/modules/workflow/submission.store';
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

function rec(partial: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    oaRequestId: `R-${Math.random().toString(36).slice(2, 8)}`,
    formId: 'leave-request', formTitle: '請假申請', userId: 'kevin',
    submittedAt: new Date().toISOString(), ...partial,
  };
}

describe('submissionStore', () => {
  afterEach(() => submissionStore.clear());

  it('listByUser 新→舊、只回本人；find 可查', () => {
    const a = rec({ userId: 'kevin' });
    const b = rec({ userId: 'kevin' });
    const c = rec({ userId: 'hyweb' });
    submissionStore.record('t1', a);
    submissionStore.record('t1', b);
    submissionStore.record('t1', c);
    const list = submissionStore.listByUser('t1', 'kevin');
    expect(list.map((r) => r.oaRequestId)).toEqual([b.oaRequestId, a.oaRequestId]);
    expect(submissionStore.find('t1', c.oaRequestId)?.userId).toBe('hyweb');
    expect(submissionStore.listByUser('t2', 'kevin')).toHaveLength(0); // 租戶隔離
  });

  it('每租戶上限 200 捨最舊', () => {
    for (let i = 0; i < 210; i++) submissionStore.record('t3', rec({ oaRequestId: `R-${i}` }));
    expect(submissionStore.find('t3', 'R-0')).toBeUndefined();
    expect(submissionStore.find('t3', 'R-209')).toBeTruthy();
  });
});

describe('送出漏斗記錄', () => {
  afterEach(() => submissionStore.clear());

  it('通用送出成功後留下紀錄（含 formTitle）', async () => {
    const t = tenantStore.createTenant('sub-record');
    const submit = resolveSubmit('outing-registration');
    // outing 必填最小值（與 form-submit-notify.test 同款；實作時 READ 該測試取值）
    const values = { /* 由實作者複製 form-submit-notify.test 的 validOutingValues 內容 */ } as Record<string, unknown>;
    const result = await submit(t.id, 'kevin', values);
    const found = submissionStore.find(t.id, result.oaRequestId);
    expect(found).toBeTruthy();
    expect(found?.userId).toBe('kevin');
    expect(found?.formTitle).toBeTruthy();
  });

  it('store 記錄拋錯不影響送出（best-effort）', async () => {
    const t = tenantStore.createTenant('sub-record-fail');
    const spy = jest.spyOn(submissionStore, 'record').mockImplementation(() => { throw new Error('磁碟爆了'); });
    try {
      const submit = resolveSubmit('outing-registration');
      const values = { /* 同上 */ } as Record<string, unknown>;
      const result = await submit(t.id, 'kevin', values);
      expect(result.oaRequestId).toBeTruthy(); // 送出照常成功
    } finally {
      spy.mockRestore();
    }
  });
});
```

> 實作者：兩處 `values` 請 READ `server/tests/form-submit-notify.test.ts` 內 outing 的最小合法值照抄（該測試已驗證能通過驗證）。

- [ ] **Step 2: 失敗 → 實作**

`server/src/modules/workflow/submission.store.ts`:

```ts
/**
 * 「我的申請」紀錄（每租戶）：送出成功時由 form-submit 漏斗記一筆，
 * 供 oa.listMyRequests / oa.getApprovalStatus 跨對話查詢。
 * in-memory + dataFile 持久化、每租戶保留最近 200 筆。旁路性質——記錄失敗不得影響送出。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';

export interface SubmissionRecord {
  oaRequestId: string;
  formId: string;
  /** 記錄當下的表單標題（表單之後改名/刪除仍可顯示） */
  formTitle: string;
  userId: string;
  submittedAt: string;
}

const MAX_PER_TENANT = 200;
const STORE_FILE = dataFile('oa-agent-submissions.json');
const byTenant = new Map<string, SubmissionRecord[]>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...byTenant.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist submissions');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, SubmissionRecord[]][];
    for (const [k, v] of raw) byTenant.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore submissions; starting empty');
}

export const submissionStore = {
  record(tenantId: string, rec: SubmissionRecord): void {
    const arr = byTenant.get(tenantId) ?? [];
    arr.push(rec);
    if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT);
    byTenant.set(tenantId, arr);
    persist();
  },
  /** 該使用者的申請（新→舊，最多 limit 筆） */
  listByUser(tenantId: string, userId: string, limit = 10): SubmissionRecord[] {
    const arr = byTenant.get(tenantId) ?? [];
    return arr.filter((r) => r.userId === userId).reverse().slice(0, limit);
  },
  find(tenantId: string, oaRequestId: string): SubmissionRecord | undefined {
    return (byTenant.get(tenantId) ?? []).find((r) => r.oaRequestId === oaRequestId);
  },
  clear(): void {
    byTenant.clear();
    persist();
  },
};
```

`form-submit.registry.ts`：頂部加 import（`tryGetDefinition` 自 `@/modules/form/form.registry`——READ 現有 import 行，`getDefinition` 已在即加名；`submissionStore` 自 `@/modules/workflow/submission.store`）。加函式（`notifyOnSubmit` 旁）：

```ts
/** 送出成功後 best-effort 記入「我的申請」（供跨對話查簽核）；失敗吞掉，不影響送出。 */
function recordSubmission(
  tenantId: string,
  userId: string,
  formId: string,
  submission: FormSubmission,
): void {
  try {
    const formTitle = tryGetDefinition(tenantId, formId)?.data.title ?? formId;
    submissionStore.record(tenantId, {
      oaRequestId: submission.oaRequestId,
      formId,
      formTitle,
      userId,
      submittedAt: submission.submittedAt,
    });
  } catch (err) {
    logger.info({ err, formId, userId }, '申請紀錄寫入略過');
  }
}
```

並在 `resolveSubmit` 的包裝內、`notifyOnSubmit` 之前加一行：

```ts
    recordSubmission(tenantId, userId, formId, result);
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/submission-store.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/workflow/submission.store.ts server/src/modules/conversation/form-submit.registry.ts server/tests/submission-store.test.ts
git commit -m "feat(workflow): 我的申請 store + 送出漏斗 best-effort 記錄"
```

---

### Task 2: 兩個唯讀查詢工具（身分綁定）

**Files:**
- Modify: `server/src/modules/tools/oa.tools.ts`（加 `oa.listMyRequests`/`oa.getApprovalStatus` + `currentStepSummary` helper）
- Test: `server/tests/workflow-tools.test.ts`

**Interfaces:**
- Consumes: `submissionStore`（Task 1）、`tryGetDefinition`（form.registry）、`stepDefs`/`computeApprovals`（approvals）。
- Produces: 兩工具皆 `scopes:['oa:read']`、`agentExposed:true`、不標 audit。
  - `oa.listMyRequests` input `{}` → `{ requests: [{oaRequestId, formTitle, submittedAt, current}] }`
  - `oa.getApprovalStatus` input `{oaRequestId}` → 本人有此單：`{found:true, formTitle, submittedAt, approvals:[{name,status}]}`；查無/非本人：`{found:false, message}`；表單定義已刪：`{found:true, ..., approvals:null, note}`。

- [ ] **Step 1: 寫失敗測試**

`server/tests/workflow-tools.test.ts`:

```ts
/** 查簽核工具：身分綁 ctx（只能查自己的）、進度查詢時重算、agentExposed。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { submissionStore } from '@/modules/workflow/submission.store';

function seed(tenantId: string, userId: string, oaRequestId: string) {
  submissionStore.record(tenantId, {
    oaRequestId, formId: 'leave-request', formTitle: '請假申請',
    userId, submittedAt: new Date().toISOString(),
  });
}

describe('查簽核工具', () => {
  afterEach(() => submissionStore.clear());

  it('兩工具已註冊且 agentExposed（oa:read 為 BASE，全員可見）', () => {
    const t = tenantStore.createTenant('wf-avail');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const names = toolRegistry.availableFor(ctx).map((x) => x.name);
    expect(names).toContain('oa.listMyRequests');
    expect(names).toContain('oa.getApprovalStatus');
  });

  it('listMyRequests 只回呼叫者本人的申請，含目前關卡摘要', async () => {
    const t = tenantStore.createTenant('wf-list');
    seed(t.id, 'kevin', 'R-K1');
    seed(t.id, 'hyweb', 'R-H1');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.listMyRequests', {}, ctx)) as {
      requests: { oaRequestId: string; current: string }[];
    };
    expect(out.requests.map((r) => r.oaRequestId)).toEqual(['R-K1']); // 不含他人的 R-H1
    expect(out.requests[0].current).toBeTruthy();
  });

  it('getApprovalStatus：本人可查（回關卡列表）', async () => {
    const t = tenantStore.createTenant('wf-status');
    seed(t.id, 'kevin', 'R-K2');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.getApprovalStatus', { oaRequestId: 'R-K2' }, ctx)) as {
      found: boolean; approvals: { name: string; status: string }[];
    };
    expect(out.found).toBe(true);
    expect(out.approvals.length).toBeGreaterThan(0);
    expect(['current', 'pending', 'approved']).toContain(out.approvals[0].status);
  });

  it('getApprovalStatus：他人的單號回查無（不洩漏）', async () => {
    const t = tenantStore.createTenant('wf-cross');
    seed(t.id, 'hyweb', 'R-H2');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const out = (await toolRegistry.invoke('oa.getApprovalStatus', { oaRequestId: 'R-H2' }, ctx)) as {
      found: boolean;
    };
    expect(out.found).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`oa.tools.ts`：頂部加 import：

```ts
import { computeApprovals, stepDefs } from '@/modules/form/approvals';
import { tryGetDefinition } from '@/modules/form/form.registry';
import { submissionStore, type SubmissionRecord } from '@/modules/workflow/submission.store';
```

檔尾加：

```ts
/** 目前關卡摘要：查詢時以當下時間重算（Demo 時間推演；真 OA 之後改由連接器查）。 */
function currentStepSummary(tenantId: string, rec: SubmissionRecord): string {
  const def = tryGetDefinition(tenantId, rec.formId);
  if (!def) return '—';
  const approvals = computeApprovals(stepDefs(def), rec.submittedAt);
  if (approvals.length === 0) return '無簽核關卡';
  const cur = approvals.find((a) => a.status === 'current');
  return cur ? `${cur.name}（待審）` : '已全部核准';
}

registerTool({
  id: 'oa.listMyRequests',
  description: '列出你（目前登入使用者）送出過的申請及各自的目前簽核關卡。',
  inputSchema: { type: 'object', additionalProperties: false },
  scopes: ['oa:read'],
  agentExposed: true,
  handler: async (_input, ctx) => {
    const records = submissionStore.listByUser(ctx.tenantId, ctx.userId, 10);
    return {
      requests: records.map((r) => ({
        oaRequestId: r.oaRequestId,
        formTitle: r.formTitle,
        submittedAt: r.submittedAt,
        current: currentStepSummary(ctx.tenantId, r),
      })),
    };
  },
});

registerTool({
  id: 'oa.getApprovalStatus',
  description: '查詢你本人某一筆申請（以單號指定）的完整簽核關卡進度。',
  inputSchema: {
    type: 'object',
    properties: { oaRequestId: { type: 'string' } },
    required: ['oaRequestId'],
    additionalProperties: false,
  },
  scopes: ['oa:read'],
  agentExposed: true,
  handler: async (input: { oaRequestId: string }, ctx) => {
    const rec = submissionStore.find(ctx.tenantId, input.oaRequestId);
    // 身分綁定：查無或非本人一律回「查無」，不洩漏他人單據存在與否
    if (!rec || rec.userId !== ctx.userId) {
      return { found: false, message: '查無此申請（單號可能有誤，或非您本人的申請）。' };
    }
    const def = tryGetDefinition(ctx.tenantId, rec.formId);
    if (!def) {
      return {
        found: true, formTitle: rec.formTitle, submittedAt: rec.submittedAt,
        approvals: null, note: '表單定義已不存在，僅剩送出紀錄、無法取得關卡明細。',
      };
    }
    const approvals = computeApprovals(stepDefs(def), rec.submittedAt);
    return {
      found: true, formTitle: rec.formTitle, submittedAt: rec.submittedAt,
      approvals: approvals.map((a) => ({ name: a.name, status: a.status })),
    };
  },
});
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/workflow-tools.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tools/oa.tools.ts server/tests/workflow-tools.test.ts
git commit -m "feat(tools): oa.listMyRequests / oa.getApprovalStatus（身分綁定、agentExposed）"
```

---

### Task 3: Agent 接線（關鍵字 + prompt）

**Files:**
- Modify: `server/src/modules/conversation/agent.agent-service.ts`（keywords + system prompt 工作方式）
- Test: `server/tests/workflow-routing.test.ts`

**Interfaces:**
- Produces: `agent.task` keywords 追加 `'簽核進度','簽到哪','我的申請','申請進度','簽核狀態','催辦'`（完整片語、不含裸「簽核」）；prompt 加查簽核/催辦工作方式一行。

- [ ] **Step 1: 寫失敗測試**

`server/tests/workflow-routing.test.ts`:

```ts
/** 查簽核關鍵字 0-token 路由到 agent；e2e：fake LLM 呼 oa_listMyRequests 取得本人申請。 */
import type { LLMProvider } from '@/lib/llm/types';
import { intentRouter } from '@/modules/conversation/intent-router';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { submissionStore } from '@/modules/workflow/submission.store';

const usage = { inputTokens: 1, outputTokens: 1 };
function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's-wf', tenantId, userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', activeServiceId: undefined, messages: [], createdAt: new Date().toISOString(),
    ...partial,
  };
}

afterEach(() => submissionStore.clear());

it('「我的申請進度到哪了」→ 關鍵字 0-token 路由到 agent', async () => {
  const t = tenantStore.createTenant('wf-route');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  const r = await intentRouter.route(makeSession(t.id), '我的申請進度到哪了');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false);
});

it('e2e：LLM 呼 oa_listMyRequests → tool_result 含本人單號', async () => {
  const t = tenantStore.createTenant('wf-e2e');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
  submissionStore.record(t.id, {
    oaRequestId: 'R-E2E', formId: 'leave-request', formTitle: '請假申請',
    userId: 'kevin', submittedAt: new Date().toISOString(),
  });
  let i = 0;
  const llm: LLMProvider = {
    name: 'fake',
    createMessage: async () =>
      i++ === 0
        ? { text: '', toolCalls: [{ id: 't1', name: 'oa_listMyRequests', input: {} }], stopReason: 'tool_use', usage }
        : { text: '你有 1 筆申請：R-E2E。', toolCalls: [], stopReason: 'end_turn', usage },
  };
  const session = makeSession(t.id, {
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我的申請' }] }],
  });
  const res = await agentAgentService.handleTurn(session, '我的申請', llm);
  const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as
    | { content: string } | undefined;
  expect(tr?.content).toContain('R-E2E');
  expect(res.reply).toContain('R-E2E');
});
```

- [ ] **Step 2: 失敗 → 實作**

`agent.agent-service.ts`：
- `intents()` 的 keywords 陣列追加（保留既有寄信片語）：

```ts
        keywords: [
          '寄信給', '幫我寄', '寄封信', '寄一封信', '發信給', '代寄',
          // 查簽核／催辦（完整片語，避免搶走「簽核規定是什麼」這類知識問句）
          '簽核進度', '簽到哪', '我的申請', '申請進度', '簽核狀態', '催辦',
        ],
```

- `intents()` 的 description 更新為涵蓋查簽核（供分類器目錄）：

```ts
        description:
          '需要操作公司系統/工具的任務：查詢並彙整資料、查自己申請的簽核進度、代擬並（經確認後）寄送通知信/催辦信 Email。',
```

- `buildSystemPrompt` 工作方式清單追加一行（寄信那行附近）：

```ts
    '- 使用者問申請/簽核進度時：用 oa_listMyRequests 列出他的申請、oa_getApprovalStatus 查特定單號的關卡；如實轉述查詢結果，查無就說查無。要催辦時，用 email.propose 擬催辦信（不確定收件人就先問使用者）。',
```

- [ ] **Step 3: 綠 + 全套 + 型別 + build + commit**

Run: `cd server && npx jest tests/workflow-routing.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤；`npm run build` → 成功

```bash
git add server/src/modules/conversation/agent.agent-service.ts server/tests/workflow-routing.test.ts
git commit -m "feat(agent): 查簽核/我的申請/催辦 關鍵字與工作方式接線"
```

---

## 完成後狀態（驗收）
- 「我的假單簽到哪了？」「我有哪些申請？」由 Agent 以本人資料回答；進度隨時間前進（Demo 推演）；「幫我催一下」走既有擬信→確認→寄出（含稽核）。
- 身分綁定：只能查自己的；他人單號回查無、不洩漏存在性。
- 記錄旁路：store 失敗不影響送出。
- 全套測試綠、typecheck/build 綠。

## Self-Review 註記
- **Spec 覆蓋**：D1 Agent 工具化（含催辦零新機制）、D2 store+查詢時重算（連接器 seam 留待真 OA）、D3 身分綁定（listMyRequests 無 userId 參數；getApprovalStatus 驗擁有者，測試涵蓋跨使用者）、D4 oa:read。
- **型別一致**：`SubmissionRecord`、store API、工具 I/O、`ApprovalStep.status` 值域跨任務一致；e2e 用底線工具名（`oa_listMyRequests`，Agent 對 LLM 的轉名機制）。
- **路由風險**：關鍵字皆完整片語；負向案例（「簽核規定是什麼」不被搶）因 fallback 需經真分類器、無法決定性單測，留待真流量 eval（既有已知議題）。
- **無 placeholder**：outing 測試值明確指示自 form-submit-notify.test 照抄（該值已被既有測試驗證）。
