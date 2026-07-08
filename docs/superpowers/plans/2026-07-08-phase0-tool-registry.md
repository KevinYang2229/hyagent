# Phase 0：Tool Registry 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把現有 OA 送出/查詢收編成「工具」，建立共用 Tool Registry 三層結構（服務 → Tool Registry → Connector），使用者行為零改變。

**Architecture:** 新增 `modules/tools/`（ToolDef 契約 + registry + invoke 唯一入口）、`lib/connectors/`（泛化 `getConnector`）、`modules/authz/`（scope 解析 seam，第一版全通過）。把 OA 的 `submitForm` / `getLeaveBalance` 包成 `oa.submitForm` / `oa.getLeaveBalance` 兩個工具，Form 送出與領域 service 改走 `toolRegistry.invoke`。底層仍是同一個 `OAConnector`（`OA_CONNECTOR=stub|http` 不變）。

**Tech Stack:** TypeScript (NodeNext)、Express、Ajv 8.20（`import Ajv from 'ajv'`）、Jest + ts-jest。路徑別名 `@/` → `server/src/`。

## Global Constraints

- 語言：程式註解與訊息用繁體中文，與現有檔案一致。
- 測試框架：Jest，測試檔放 `server/tests/*.test.ts`，跑法 `cd server && npx jest <file>`。
- 錯誤：可預期錯誤一律 `throw AppError.*`（`@/utils/app-error`）。
- Ajv 建立方式固定：`const ajv = new Ajv({ allErrors: true, strict: false });`（與 `form.engine.ts` 一致）。
- 向後相容鐵則：本階段**零新連接器、零行為變化**；完成後 `cd server && npx jest` 必須全綠、`npm run typecheck` 必須通過。
- 不修改 `usage.store.ts`（工具計費留待 Phase 2）；本階段稽核鉤子只用 `logger.debug`。
- 不實作 `availableFor`（Agent 專用，留待 Phase 1）。

---

### Task 1: 權限 seam + 工具型別 + ToolContext

**Files:**
- Create: `server/src/modules/authz/resolve-scopes.ts`
- Create: `server/src/modules/tools/tool.types.ts`
- Create: `server/src/modules/tools/tool.context.ts`
- Test: `server/tests/resolve-scopes.test.ts`

**Interfaces:**
- Produces:
  - `interface ScopePrincipal { tenantId: string; userId: string }`
  - `resolveScopes(principal: ScopePrincipal): string[]`（Phase 0 一律回 `['*']`）
  - `interface ToolContext { tenantId: string; userId: string; locale?: string; scopes: string[] }`
  - `interface ToolDef<I, O> { readonly id: string; readonly description: string; readonly inputSchema: Record<string, unknown>; readonly scopes: string[]; handler(input: I, ctx: ToolContext): Promise<O> }`
  - `makeToolContext(input: { tenantId: string; userId: string; locale?: string }): ToolContext`

- [ ] **Step 1: 寫失敗測試**

`server/tests/resolve-scopes.test.ts`:

```ts
/**
 * resolveScopes（RBAC seam）：Phase 0 全通過。
 * 之後（Phase 2）改為租戶∩群組∩帳號 union；此測試屆時會更新。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { makeToolContext } from '@/modules/tools/tool.context';

describe('resolveScopes（Phase 0 全通過）', () => {
  it('任何 principal 都回萬用字元 ["*"]', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' })).toEqual(['*']);
  });
});

describe('makeToolContext', () => {
  it('把 principal 加上解析後的 scopes 組成 ToolContext', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx).toEqual({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW', scopes: ['*'] });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/resolve-scopes.test.ts`
Expected: FAIL（`Cannot find module '@/modules/authz/resolve-scopes'`）

- [ ] **Step 3: 實作三個檔**

`server/src/modules/authz/resolve-scopes.ts`:

```ts
/**
 * 權限解析（RBAC seam）。
 *
 * Phase 0：一律回萬用字元 ['*'] ＝全通過，行為與現況（登入即可用）相同。
 * Phase 2 收緊時改為 union(租戶 grantedScopes, 群組 groupPolicy[department], 帳號 accountPolicy[userId])，
 * 上層（toolRegistry.invoke 的檢查點）無需改動。
 */
export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(_principal: ScopePrincipal): string[] {
  return ['*'];
}
```

`server/src/modules/tools/tool.types.ts`:

```ts
/**
 * Tool Registry 契約：工具即一等公民。
 *
 * ToolDef 是最小可呼叫單位；連接器（OA/ERP/Calendar/Email）退為工具 handler 的內部依賴。
 * inputSchema 一物二用：給 Agent 當 LLM tool schema，也做 invoke 前的 Ajv 驗證。
 */
export interface ToolContext {
  tenantId: string;
  userId: string;
  locale?: string;
  /** resolveScopes(principal) 的結果；invoke 以此比對 tool.scopes */
  scopes: string[];
}

export interface ToolDef<I = unknown, O = unknown> {
  /** 命名空間 id，如 'oa.submitForm' / 'oa.getLeaveBalance' */
  readonly id: string;
  /** 給 Agent 的 LLM 分類/挑選用（Phase 1 起用） */
  readonly description: string;
  /** JSON Schema：LLM tool schema + 執行前 Ajv 驗證 */
  readonly inputSchema: Record<string, unknown>;
  /** 需具備的權限，如 ['oa:write']；空陣列＝不需權限 */
  readonly scopes: string[];
  handler(input: I, ctx: ToolContext): Promise<O>;
}
```

`server/src/modules/tools/tool.context.ts`:

```ts
/**
 * 由 principal（tenantId/userId/locale）組出帶 scopes 的 ToolContext。
 * 服務層在呼叫 toolRegistry.invoke 前用此建立 ctx。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { ToolContext } from './tool.types';

export function makeToolContext(input: {
  tenantId: string;
  userId: string;
  locale?: string;
}): ToolContext {
  return { ...input, scopes: resolveScopes({ tenantId: input.tenantId, userId: input.userId }) };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/resolve-scopes.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/authz/resolve-scopes.ts server/src/modules/tools/tool.types.ts server/src/modules/tools/tool.context.ts server/tests/resolve-scopes.test.ts
git commit -m "feat(tools): 加入 ToolDef/ToolContext 型別與 resolveScopes 權限 seam"
```

---

### Task 2: Tool Registry（registerTool + invoke）

**Files:**
- Create: `server/src/modules/tools/tool.registry.ts`
- Test: `server/tests/tool-registry.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolContext`（Task 1）；`AppError`（`@/utils/app-error`）；`logger`（`@/lib/logger`）。
- Produces:
  - `registerTool(tool: ToolDef): void`（id 重複則 throw）
  - `toolRegistry.get(id: string): ToolDef`（找不到 throw）
  - `toolRegistry.has(id: string): boolean`
  - `toolRegistry.invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown>`（scope 檢查 → Ajv 驗證 → 記 log → 執行 handler）

- [ ] **Step 1: 寫失敗測試**

`server/tests/tool-registry.test.ts`:

```ts
/**
 * Tool Registry：註冊、scope 檢查、輸入驗證、派發。
 * 每個測試用唯一工具 id，避免 module-singleton registry 撞名。
 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import type { ToolContext } from '@/modules/tools/tool.types';

const ctx = (scopes: string[]): ToolContext => ({ tenantId: 't1', userId: 'kevin', scopes });

describe('toolRegistry', () => {
  it('invoke 驗證通過時呼叫 handler 並回傳其結果', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registerTool({
      id: 'test.echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      scopes: ['test:read'],
      handler,
    });
    const result = await toolRegistry.invoke('test.echo', { msg: 'hi' }, ctx(['test:read']));
    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith({ msg: 'hi' }, ctx(['test:read']));
  });

  it('萬用字元 scope 通過任何工具的權限檢查', async () => {
    registerTool({
      id: 'test.wild',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['whatever:write'],
      handler: async () => 'done',
    });
    await expect(toolRegistry.invoke('test.wild', {}, ctx(['*']))).resolves.toBe('done');
  });

  it('scope 不足時丟 403 且不呼叫 handler', async () => {
    const handler = jest.fn();
    registerTool({ id: 'test.guarded', description: 'x', inputSchema: { type: 'object' }, scopes: ['oa:write'], handler });
    await expect(toolRegistry.invoke('test.guarded', {}, ctx(['oa:read']))).rejects.toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('輸入不符 schema 時丟 422 且不呼叫 handler', async () => {
    const handler = jest.fn();
    registerTool({
      id: 'test.needs-msg',
      description: 'x',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      scopes: [],
      handler,
    });
    await expect(toolRegistry.invoke('test.needs-msg', {}, ctx(['*']))).rejects.toMatchObject({ statusCode: 422 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('未知工具 id 時 get/invoke 丟錯', () => {
    expect(() => toolRegistry.get('nope.missing')).toThrow(/unknown tool/);
    expect(toolRegistry.has('nope.missing')).toBe(false);
  });

  it('重複註冊同一 id 丟錯', () => {
    registerTool({ id: 'test.dup', description: 'x', inputSchema: { type: 'object' }, scopes: [], handler: async () => 1 });
    expect(() =>
      registerTool({ id: 'test.dup', description: 'y', inputSchema: { type: 'object' }, scopes: [], handler: async () => 2 }),
    ).toThrow(/duplicate tool/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/tool-registry.test.ts`
Expected: FAIL（`Cannot find module '@/modules/tools/tool.registry'`）

- [ ] **Step 3: 實作 tool.registry.ts**

`server/src/modules/tools/tool.registry.ts`:

```ts
/**
 * Agent 工具註冊表（碰外部系統的動作）。
 *
 * 與 service.registry 同構的查表結構。invoke 是唯一執行入口：
 * 集中做 scope 檢查、Ajv 輸入驗證、稽核鉤子，服務層不再直接碰連接器、也不寫權限碼。
 * 對話控制類工具（如 form 的 slot-filling）不進此表——只有碰外部系統的動作才進來。
 */
import Ajv from 'ajv';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import type { ToolContext, ToolDef } from './tool.types';

const ajv = new Ajv({ allErrors: true, strict: false });
const registry = new Map<string, ToolDef>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
  registry.set(tool.id, tool);
}

/** granted 含 '*' 視為萬用字元；否則需涵蓋 required 全部。 */
function hasScopes(granted: string[], required: string[]): boolean {
  if (granted.includes('*')) return true;
  return required.every((s) => granted.includes(s));
}

export const toolRegistry = {
  get(id: string): ToolDef {
    const tool = registry.get(id);
    if (!tool) throw new Error(`unknown tool: ${id}`);
    return tool;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  async invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(id);
    if (!hasScopes(ctx.scopes, tool.scopes)) {
      throw AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
    }
    const validate = ajv.compile(tool.inputSchema);
    if (!validate(input)) {
      throw AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
    }
    // 稽核/計費鉤子：Phase 2 於此接 usageStore.recordToolCall；目前先記 log。
    logger.debug({ toolId: id, tenantId: ctx.tenantId, userId: ctx.userId }, 'tool.invoke');
    return tool.handler(input, ctx);
  },
};
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/tool-registry.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tools/tool.registry.ts server/tests/tool-registry.test.ts
git commit -m "feat(tools): Tool Registry 與 invoke 唯一入口（scope 檢查 + Ajv 驗證）"
```

---

### Task 3: 連接器工廠泛化（getConnector）

**Files:**
- Create: `server/src/lib/connectors/index.ts`
- Test: `server/tests/connectors.test.ts`

**Interfaces:**
- Consumes: `getOAConnector`（`@/lib/oa`）、`OAConnector`（`@/lib/oa/types`）。
- Produces: `getConnector(name: 'oa'): OAConnector`（Phase 0 只認 'oa'；未知名稱 throw）。

> 泛化說明：這是 `getOAConnector()` 的統一入口。Phase 2+ 新增 'email'/'erp'/'calendar' 時在此 switch 加 case，型別 union 一起擴。Phase 0 只收 OA，證明「新增連接器不動上層」的模式。

- [ ] **Step 1: 寫失敗測試**

`server/tests/connectors.test.ts`:

```ts
/**
 * getConnector：連接器工廠的統一入口（Phase 0 只認 'oa'）。
 */
import { getConnector } from '@/lib/connectors';

describe('getConnector', () => {
  it("getConnector('oa') 回傳具 submitForm 的 OA 連接器", () => {
    const oa = getConnector('oa');
    expect(typeof oa.submitForm).toBe('function');
    expect(typeof oa.name).toBe('string');
  });

  it('未知連接器名稱丟錯', () => {
    // @ts-expect-error 故意傳未支援名稱
    expect(() => getConnector('nope')).toThrow(/unknown connector/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/connectors.test.ts`
Expected: FAIL（`Cannot find module '@/lib/connectors'`）

- [ ] **Step 3: 實作 connectors/index.ts**

`server/src/lib/connectors/index.ts`:

```ts
/**
 * 連接器工廠統一入口。工具 handler 透過 getConnector(name) 取得對應連接器，
 * 連接器內部才知道 base URL / 認證 / HTTP / 資料映射。
 *
 * Phase 0：只有 OA（沿用 getOAConnector 的 stub/http 選擇）。
 * Phase 2+：新增 'email' | 'erp' | 'calendar' 時，在此 switch 加 case、型別 union 一起擴，上層零改動。
 */
import { getOAConnector } from '@/lib/oa';
import type { OAConnector } from '@/lib/oa/types';

export type ConnectorName = 'oa';

export function getConnector(name: ConnectorName): OAConnector {
  switch (name) {
    case 'oa':
      return getOAConnector();
    default:
      throw new Error(`unknown connector: ${name as string}`);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/connectors.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/connectors/index.ts server/tests/connectors.test.ts
git commit -m "feat(connectors): 泛化 getConnector 統一入口（Phase 0 僅 OA）"
```

---

### Task 4: OA 工具（oa.submitForm / oa.getLeaveBalance）+ tools 進入點

**Files:**
- Create: `server/src/modules/tools/oa.tools.ts`
- Create: `server/src/modules/tools/index.ts`
- Test: `server/tests/oa-tools.test.ts`

**Interfaces:**
- Consumes: `registerTool`, `toolRegistry`（Task 2）、`getConnector`（Task 3）、`makeToolContext`（Task 1）、`OASubmitInput`/`OASubmitResult`/`OAConnector` 型別（`@/lib/oa/types`）。
- Produces:
  - 註冊工具 `oa.submitForm`（input：`OASubmitInput` = `{ formId, oa, source }`；回 `OASubmitResult`；scopes `['oa:write']`）
  - 註冊工具 `oa.getLeaveBalance`（input：`{ userId }`；回 `LeaveBalance[]`；scopes `['oa:read']`）
  - `server/src/modules/tools/index.ts`：`import './oa.tools'`（副作用註冊）後 `export { toolRegistry, registerTool } from './tool.registry'`、`export { makeToolContext } from './tool.context'`、`export type { ToolContext, ToolDef } from './tool.types'`。**上層一律從 `@/modules/tools` import，確保工具在使用前已註冊。**

> 設計：`oa.submitForm` 的 `inputSchema` 對 `source` 放寬（`additionalProperties: true`），因為 source 是「表單值 + 衍生欄位」的任意物件，實際欄位由各表單 oa.schema 決定，不在工具層深驗。

- [ ] **Step 1: 寫失敗測試**

`server/tests/oa-tools.test.ts`:

```ts
/**
 * OA 工具：透過 toolRegistry.invoke 呼叫，底層落到 stub OA 連接器。
 * OA_CONNECTOR 於 tests/setup-env.ts 未設，getOAConnector 預設 stub。
 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { getDefinition } from '@/modules/form/form.registry';

describe('OA 工具（走 stub 連接器）', () => {
  it('已註冊 oa.submitForm 與 oa.getLeaveBalance', () => {
    expect(toolRegistry.has('oa.submitForm')).toBe(true);
    expect(toolRegistry.has('oa.getLeaveBalance')).toBe(true);
  });

  it('invoke oa.submitForm 回傳 stub 單號（STUB-…）', async () => {
    const def = getDefinition('default', 'outing-registration');
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const result = (await toolRegistry.invoke(
      'oa.submitForm',
      { formId: 'outing-registration', oa: def.oa, source: { userId: 'kevin' } },
      ctx,
    )) as { oaRequestId: string; status: string };
    expect(result.oaRequestId).toMatch(/^STUB-/);
    expect(typeof result.status).toBe('string');
  });

  it('invoke oa.getLeaveBalance 回傳陣列', async () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const result = await toolRegistry.invoke('oa.getLeaveBalance', { userId: 'kevin' }, ctx);
    expect(Array.isArray(result)).toBe(true);
  });
});
```

> 註：若 `outing-registration` 無 `oa` 定義導致 stub 未回 `STUB-` 前綴，改用 `leave-request`（其 oa.schema 必存在）。實作 Step 3 後若第二個測試失敗，先確認所選表單的 `def.oa` 非 undefined。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/oa-tools.test.ts`
Expected: FAIL（`Cannot find module '@/modules/tools'`）

- [ ] **Step 3: 實作 oa.tools.ts 與 index.ts**

`server/src/modules/tools/oa.tools.ts`:

```ts
/**
 * OA 連接器的工具化：把 OAConnector 的方法包成 Tool Registry 可派發的工具。
 * handler 內部才 getConnector('oa')，工具是連接器的消費者。
 */
import { getConnector } from '@/lib/connectors';
import type { LeaveBalance, OASubmitInput, OASubmitResult } from '@/lib/oa/types';
import { registerTool } from './tool.registry';

registerTool({
  id: 'oa.submitForm',
  description: '將一張已驗證的表單送至 OA 系統，回傳 OA 單號與受理狀態。',
  inputSchema: {
    type: 'object',
    properties: {
      formId: { type: 'string' },
      oa: { type: 'object' },
      source: { type: 'object', additionalProperties: true },
    },
    required: ['formId', 'oa', 'source'],
    additionalProperties: true,
  },
  scopes: ['oa:write'],
  handler: (input: OASubmitInput): Promise<OASubmitResult> =>
    getConnector('oa').submitForm(input),
});

registerTool({
  id: 'oa.getLeaveBalance',
  description: '查詢某使用者各假別的剩餘時數。',
  inputSchema: {
    type: 'object',
    properties: { userId: { type: 'string' } },
    required: ['userId'],
    additionalProperties: false,
  },
  scopes: ['oa:read'],
  handler: (input: { userId: string }): Promise<LeaveBalance[]> => {
    const oa = getConnector('oa');
    return oa.getLeaveBalance ? oa.getLeaveBalance(input.userId) : Promise.resolve([]);
  },
});
```

`server/src/modules/tools/index.ts`:

```ts
/**
 * Tools 進入點：import 時副作用註冊所有工具，並對外提供 registry 與工具建構工具。
 * 上層一律從 '@/modules/tools' import，確保工具在被 invoke 前已完成註冊。
 */
import './oa.tools';

export { registerTool, toolRegistry } from './tool.registry';
export { makeToolContext } from './tool.context';
export type { ToolContext, ToolDef } from './tool.types';
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/oa-tools.test.ts`
Expected: PASS（3 tests）。若「STUB-」斷言失敗，依 Step 1 註記改用 `leave-request`。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tools/oa.tools.ts server/src/modules/tools/index.ts server/tests/oa-tools.test.ts
git commit -m "feat(tools): OA 收編為 oa.submitForm / oa.getLeaveBalance 工具"
```

---

### Task 5: Form 通用送出改走 Tool Registry

**Files:**
- Modify: `server/src/modules/conversation/form-submit.registry.ts`（`makeGenericSubmit` 內第 59 行附近的 `getOAConnector().submitForm` → `toolRegistry.invoke('oa.submitForm', …)`）
- Test: `server/tests/form-generic-submit.test.ts`（既有，作回歸驗證）

**Interfaces:**
- Consumes: `toolRegistry`, `makeToolContext`（`@/modules/tools`）、`OASubmitResult`（`@/lib/oa/types`）。
- Produces: `makeGenericSubmit` 行為不變（回 `FormSubmission`），送出改經工具層。

- [ ] **Step 1: 先跑既有回歸測試（基準綠）**

Run: `cd server && npx jest tests/form-generic-submit.test.ts`
Expected: PASS（作為改動前基準；若本來就有失敗，先停下釐清）

- [ ] **Step 2: 改實作**

在 `server/src/modules/conversation/form-submit.registry.ts`：

移除 `import { getOAConnector } from '@/lib/oa';`，改加：

```ts
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { OASubmitResult } from '@/lib/oa/types';
```

把 `makeGenericSubmit` 內原本這段：

```ts
    if (def.oa) {
      const result = await getOAConnector().submitForm({
        formId,
        oa: def.oa,
        source: { ...values, userId },
      });
      oaRequestId = result.oaRequestId;
      status = result.status;
    } else {
```

改為：

```ts
    if (def.oa) {
      const result = (await toolRegistry.invoke(
        'oa.submitForm',
        { formId, oa: def.oa, source: { ...values, userId } },
        makeToolContext({ tenantId, userId }),
      )) as OASubmitResult;
      oaRequestId = result.oaRequestId;
      status = result.status;
    } else {
```

- [ ] **Step 3: 跑回歸測試確認仍通過**

Run: `cd server && npx jest tests/form-generic-submit.test.ts`
Expected: PASS（行為不變）

- [ ] **Step 4: 跑相關送出測試確認無回歸**

Run: `cd server && npx jest tests/form-submit.registry.test.ts tests/leave-tool-submit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/conversation/form-submit.registry.ts
git commit -m "refactor(form): 通用送出改走 toolRegistry.invoke('oa.submitForm')"
```

---

### Task 6: 領域 service 送出/查額度改走 Tool Registry

**Files:**
- Modify: `server/src/modules/leave/leave.service.ts`（`submitLeaveApplication` 的 submitForm、`leaveService.getBalances` 的 getLeaveBalance）
- Modify: `server/src/modules/business-trip/business-trip.service.ts`（`getOAConnector().submitForm` → 工具）
- Modify: `server/src/modules/outing/outing.service.ts`（`getOAConnector().submitForm` → 工具）
- Test: `server/tests/leave-tool-submit.test.ts`、`server/tests/form-submit.registry.test.ts`（既有，回歸）

**Interfaces:**
- Consumes: `toolRegistry`, `makeToolContext`（`@/modules/tools`）、`OASubmitResult`、`LeaveBalance`（`@/lib/oa/types`）。
- Produces: 三個領域 service 對外行為不變；OA 呼叫全數改經工具層（本階段結束後 `getOAConnector` 僅由 `lib/connectors` 使用）。

- [ ] **Step 1: 先跑既有回歸測試（基準綠）**

Run: `cd server && npx jest tests/leave-tool-submit.test.ts tests/form-submit.registry.test.ts`
Expected: PASS（改動前基準）

- [ ] **Step 2: 改 leave.service.ts**

移除 `import { getOAConnector } from '@/lib/oa';`。保留 `import type { LeaveBalance } from '@/lib/oa/types';`，並加：

```ts
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { OASubmitResult } from '@/lib/oa/types';
```

把 `submitLeaveApplication` 內：

```ts
  const connector = getOAConnector();
  const result = await connector.submitForm({
    formId: FORM_ID,
    oa: def.oa,
    source: { ...values, userId, region, hours },
  });
```

改為：

```ts
  const result = (await toolRegistry.invoke(
    'oa.submitForm',
    { formId: FORM_ID, oa: def.oa, source: { ...values, userId, region, hours } },
    makeToolContext({ tenantId, userId }),
  )) as OASubmitResult;
```

把 `leaveService.getBalances` 內：

```ts
  async getBalances(userId: string): Promise<LeaveBalance[]> {
    const connector = getOAConnector();
    return connector.getLeaveBalance ? connector.getLeaveBalance(userId) : [];
  },
```

改為（改走 `oa.getLeaveBalance` 工具；`getBalances` 只有 userId，tenantId 用 'default' 建 ctx，因為額度查詢不分租戶且第一版 scope 全通過）：

```ts
  async getBalances(userId: string): Promise<LeaveBalance[]> {
    return (await toolRegistry.invoke(
      'oa.getLeaveBalance',
      { userId },
      makeToolContext({ tenantId: 'default', userId }),
    )) as LeaveBalance[];
  },
```

- [ ] **Step 3: 改 business-trip.service.ts 與 outing.service.ts**

兩檔各自：移除 `import { getOAConnector } from '@/lib/oa';`，加：

```ts
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { OASubmitResult } from '@/lib/oa/types';
```

把各檔內：

```ts
    const connector = getOAConnector();
    const result = await connector.submitForm({ /* formId, oa, source */ });
```

改為（保留原本傳給 `submitForm` 的 `{ formId, oa, source }` 物件內容不變，只換呼叫方式；`tenantId`/`userId` 為該 service 既有參數）：

```ts
    const result = (await toolRegistry.invoke(
      'oa.submitForm',
      { /* 原本的 formId, oa, source 三個欄位原封不動 */ },
      makeToolContext({ tenantId, userId }),
    )) as OASubmitResult;
```

> 實作提醒：打開兩檔各自的 submit 函式，確認 `submitForm({...})` 內原本的三個欄位（`formId` / `oa` / `source`）值，原封不動搬進 `invoke` 的第二參數。`tenantId`、`userId` 皆為 submit 函式現有參數，直接可用。

- [ ] **Step 4: 跑回歸測試確認三個 service 行為不變**

Run: `cd server && npx jest tests/leave-tool-submit.test.ts tests/form-submit.registry.test.ts`
Expected: PASS

- [ ] **Step 5: 全套測試 + 型別檢查（Phase 0 收尾驗收）**

Run: `cd server && npx jest`
Expected: 全數 PASS（含所有既有測試，證明零行為變化）

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 6: 確認 getOAConnector 僅剩 connectors 入口使用**

Run: `cd server && grep -rn "getOAConnector" src | grep -v 'src/lib/oa/index.ts' | grep -v 'src/lib/connectors/index.ts'`
Expected: 無輸出（除工廠與統一入口外，無其他直接呼叫者）

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/leave/leave.service.ts server/src/modules/business-trip/business-trip.service.ts server/src/modules/outing/outing.service.ts
git commit -m "refactor(oa): 領域 service 送出/查額度改走 Tool Registry 工具"
```

---

## 完成後狀態（Phase 0 驗收）

- 三層結構成形：服務 → `toolRegistry.invoke` → 工具 handler → `getConnector('oa')` → OAConnector（stub/http）。
- 所有碰 OA 的動作（通用送出、leave/business-trip/outing 送出、查假別額度）都經工具層；`getOAConnector` 只剩 `lib/connectors` 呼叫。
- 權限檢查點就位但全通過（`resolveScopes` 回 `['*']`）；輸入驗證、稽核 log 就位。
- 使用者行為零變化：`cd server && npx jest` 全綠、`npm run typecheck` 通過。
- 為 Phase 1（Agent + `availableFor`）、Phase 2（Email 連接器 + 權限收緊 + usage 記帳）留好 seam。

## Self-Review 註記

- **Spec 覆蓋**：對應藍圖 §4（ToolDef/Registry/invoke）、§5（OAConnector 保留、form-submit 改一行）、§7.1（getConnector 泛化）、§7.3–7.4（resolveScopes seam + 全通過）、§8 Phase 0。`availableFor`（§4.2）與 usage 記帳（§8 橫向）明確標示延後至 Phase 1/2，非遺漏。
- **型別一致**：`ToolContext`/`ToolDef`/`makeToolContext`/`resolveScopes`/`getConnector`/`toolRegistry.invoke` 簽名跨 Task 一致；`OASubmitInput`/`OASubmitResult`/`LeaveBalance` 皆取自既有 `@/lib/oa/types`。
- **無 placeholder**：每個實作步驟含完整程式碼；Task 6 Step 3 因兩檔內容需就地核對，已用明確提醒指出「原封搬三欄位」而非留白。
