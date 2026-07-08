# Phase 2B（B1）：服務與表單納入 scope 統一模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「對話服務可用性」與「個別表單可用性」從租戶層 opt-out（`disabledServices`/`disabledForms`）改為與工具權限同一套 opt-in scope 模型，讓服務（`service:form`/`service:knowledge`/`service:agent`）與表單（`form:<formId>`）皆可 by 租戶/部門/帳號授予；消除兩套控制平面的重疊。

**Architecture:** 服務/表單成為 grantable scope。強制點從 `serviceRegistry.enabledFor(tenantId)`（濾 disabledServices）與 `listEnabledForms(tenantId)`（濾 disabledForms）改為以 `resolveScopes({tenantId,userId})` 判斷是否具 `service:<id>` / `form:<formId>`。守門（assistant）維持 `alwaysEnabled`、不設 scope。既有租戶一次性遷移（disabled 反轉為 granted）；建租戶與設計新表單時自動授予。admin 服務分頁併入權限分頁（分組：服務/表單/外部）。

**Tech Stack:** 後端 TS/Express/Zod/Jest；前端 admin（Vite+React）。既有件：[scope-catalog.ts](../../../server/src/modules/authz/scope-catalog.ts)、[scope-policy.ts](../../../server/src/modules/authz/scope-policy.ts)、[resolve-scopes.ts](../../../server/src/modules/authz/resolve-scopes.ts)、[service.registry.ts](../../../server/src/modules/conversation/service.registry.ts)、[form.agent-service.ts](../../../server/src/modules/conversation/form.agent-service.ts)、[PermissionsTab.tsx](../../../admin/src/pages/tabs/PermissionsTab.tsx)。

## Global Constraints

- 語言：程式註解、UI 文案、錯誤訊息用繁體中文。
- Scope 種類：BASE=`oa:read`/`oa:write`（不變、全員、不可授予）。Grantable 靜態：`service:form`/`service:knowledge`/`service:agent`/`email:write`/`calendar:read`/`calendar:write`/`erp:read`。Grantable 動態（per 租戶）：`form:<formId>`。守門無 scope、永遠啟用。
- opt-in 語意：未授予＝不可用。既有行為靠「遷移 + 建立時自動授予」保留。
- 向後相容驗收：`cd server && npx jest` 全綠、根目錄 `npm run typecheck` 與 `npm run build` 通過。既有涉及 `disabledServices`/`disabledForms` 語意的測試需改寫為 scope 語意（屬本變更預期）。
- `resolveScopes` / `hasScopes` / `toolRegistry.invoke` 機制不動；只改「服務/表單啟用判斷」的來源與 admin 面。
- 動態 form scope 的 grantable 驗證需 tenant-aware（該租戶存在的表單才可授予）。

---

### Task 1: scope 目錄擴充（服務靜態 scope + 動態表單 scope + tenant-aware 驗證）

**Files:**
- Modify: `server/src/modules/authz/scope-catalog.ts`
- Test: `server/tests/scope-catalog.test.ts`（擴充）

**Interfaces:**
- Consumes: `listDefinitions`（`@/modules/form/form.registry`）取某租戶表單以組動態 form scope。
- Produces:
  - `SCOPE_CATALOG` 加入三個服務 scope（`base:false`）。
  - `SERVICE_SCOPE_IDS: Set<string>`（`service:form`/`service:knowledge`/`service:agent`）。
  - `formScopeId(formId): string`（回 `form:${formId}`）。
  - `tenantGrantableScopes(tenantId): ScopeDef[]`（靜態 grantable + 該租戶各表單的 `form:<id>`，label 用表單標題）。
  - `assertGrantableScopes(ids: string[], tenantId?: string): void`（tenant-aware：`form:<id>` 僅當該租戶有此表單才合法；未傳 tenantId 時 form scope 一律不合法）。

- [ ] **Step 1: 寫失敗測試（擴充 scope-catalog.test.ts，沿用現有 3 個並新增）**

在 `server/tests/scope-catalog.test.ts` 追加：

```ts
import {
  SERVICE_SCOPE_IDS,
  formScopeId,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('scope-catalog 服務 / 表單', () => {
  it('服務 scope 為 grantable', () => {
    expect(SERVICE_SCOPE_IDS.has('service:knowledge')).toBe(true);
    expect(isGrantableScope('service:form')).toBe(true);
  });

  it('formScopeId 組出 form:<id>', () => {
    expect(formScopeId('leave-request')).toBe('form:leave-request');
  });

  it('tenantGrantableScopes 含靜態 grantable 與該租戶表單', () => {
    const t = tenantStore.createTenant('cat-forms');
    const ids = tenantGrantableScopes(t.id).map((s) => s.id);
    expect(ids).toContain('service:form');
    expect(ids).toContain('email:write');
    expect(ids).toContain('form:leave-request'); // 內建表單
  });

  it('assertGrantableScopes tenant-aware：未知表單被擋，存在的表單放行', () => {
    const t = tenantStore.createTenant('cat-assert');
    expect(() => assertGrantableScopes(['form:leave-request'], t.id)).not.toThrow();
    expect(() => assertGrantableScopes(['form:no-such-form'], t.id)).toThrow();
    expect(() => assertGrantableScopes(['form:leave-request'])).toThrow(); // 無 tenantId 時 form scope 不合法
    expect(() => assertGrantableScopes(['service:agent'])).not.toThrow(); // 服務 scope 與 tenant 無關
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/scope-catalog.test.ts`
Expected: FAIL

- [ ] **Step 3: 擴充 scope-catalog.ts**

在 `SCOPE_CATALOG` 陣列加入三個服務項（於 `oa:write` 之後、`email:write` 之前）：

```ts
  { id: 'service:form', label: '填表申請', description: '使用填寫並送出表單的對話服務', base: false },
  { id: 'service:knowledge', label: '知識問答', description: '使用公司規章 / FAQ 問答服務', base: false },
  { id: 'service:agent', label: '智慧代理', description: '使用跨工具多步驟的智慧代理服務', base: false },
```

在檔案末尾加入：

```ts
import { listDefinitions } from '@/modules/form/form.registry';

export const SERVICE_SCOPE_IDS: Set<string> = new Set([
  'service:form',
  'service:knowledge',
  'service:agent',
]);

/** 表單 scope id：form:<formId>。 */
export function formScopeId(formId: string): string {
  return `form:${formId}`;
}

/** 某租戶可授予的能力：靜態 grantable + 該租戶各表單的 form:<id>（label 用表單標題）。 */
export function tenantGrantableScopes(tenantId: string): ScopeDef[] {
  const forms: ScopeDef[] = listDefinitions(tenantId).map((d) => ({
    id: formScopeId(d.formId),
    label: d.data.title ?? d.formId,
    description: `使用「${d.data.title ?? d.formId}」表單`,
    base: false,
  }));
  return [...GRANTABLE_SCOPES, ...forms];
}
```

改寫 `assertGrantableScopes` 為 tenant-aware：

```ts
/** 驗證一組 scope 皆可授予；form:<id> 需該租戶存在此表單。BASE / '*' / 目錄外一律 400。 */
export function assertGrantableScopes(ids: string[], tenantId?: string): void {
  const validFormIds = tenantId
    ? new Set(listDefinitions(tenantId).map((d) => formScopeId(d.formId)))
    : new Set<string>();
  const ok = (id: string): boolean =>
    GRANTABLE_SCOPE_IDS.has(id) || validFormIds.has(id);
  const bad = ids.filter((id) => !ok(id));
  if (bad.length > 0) throw AppError.badRequest(`不可授予的 scope：${bad.join('、')}`);
}
```

> 注意：`GRANTABLE_SCOPE_IDS` 仍由 `SCOPE_CATALOG.filter(base===false)` 導出（現況），會自動含新加的三個服務 scope。

- [ ] **Step 4–5: 綠 + commit**

Run: `cd server && npx jest tests/scope-catalog.test.ts` → PASS
Run: `cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/authz/scope-catalog.ts server/tests/scope-catalog.test.ts
git commit -m "feat(authz): scope 目錄加入服務 scope 與動態表單 scope（tenant-aware 驗證）"
```

---

### Task 2: 服務啟用改看 scope（serviceRegistry.enabledFor + AgentService.serviceScope）

**Files:**
- Modify: `server/src/modules/conversation/agent-service.types.ts`（`AgentService` 加 `serviceScope?: string`）
- Modify: 各服務宣告 serviceScope — `form.agent-service.ts`(`serviceScope:'service:form'`)、`knowledge.agent-service.ts`(`'service:knowledge'`)、`agent.agent-service.ts`(`'service:agent'`)。assistant 不設（維持 alwaysEnabled）。
- Modify: `server/src/modules/conversation/service.registry.ts`（`enabledFor(tenantId,userId)` 改看 scope）
- Modify: `server/src/modules/conversation/intent-router.ts`（3 處 `enabledFor(session.tenantId)` → `enabledFor(session.tenantId, session.userId)`）
- Modify (rewrite): `server/tests/service-enabled.test.ts`、`server/tests/assistant-guard.test.ts`（enabledFor 段）

**Interfaces:**
- Consumes: `resolveScopes`（`@/modules/authz/resolve-scopes`）。
- Produces: `serviceRegistry.enabledFor(tenantId: string, userId: string): AgentService[]` — 保留 `alwaysEnabled` 的服務；其餘需 `resolveScopes({tenantId,userId})` 含其 `serviceScope`。

- [ ] **Step 1: 先確認基準綠**

Run: `cd server && npx jest tests/service-enabled.test.ts tests/assistant-guard.test.ts tests/intent-router.test.ts`
Expected: PASS（改動前基準）

- [ ] **Step 2: 型別 + 各服務宣告 serviceScope**

`agent-service.types.ts` 的 `AgentService` 內、`alwaysEnabled` 之後加：

```ts
  /** 使用此服務所需的 scope（如 'service:form'）；未設代表不需 scope（配合 alwaysEnabled 的守門）。 */
  readonly serviceScope?: string;
```

在三個服務物件加入對應欄位：
- `form.agent-service.ts` 的 `formAgentService`：`sticky: true,` 附近加 `serviceScope: 'service:form',`
- `knowledge.agent-service.ts` 的 `knowledgeAgentService`：加 `serviceScope: 'service:knowledge',`
- `agent.agent-service.ts` 的 `agentAgentService`：加 `serviceScope: 'service:agent',`
（`assistant.agent-service.ts` 不加。）

- [ ] **Step 3: 改寫 enabledFor**

`service.registry.ts`：頂部加 `import { resolveScopes } from '@/modules/authz/resolve-scopes';`，改寫方法：

```ts
  /** 該使用者在該租戶可用的服務：alwaysEnabled 恆在；其餘需 resolveScopes 含其 serviceScope。 */
  enabledFor(tenantId: string, userId: string): AgentService[] {
    const scopes = new Set(resolveScopes({ tenantId, userId }));
    return [...registry.values()].filter(
      (s) => s.alwaysEnabled || (s.serviceScope !== undefined && scopes.has(s.serviceScope)),
    );
  },
```

- [ ] **Step 4: 更新 intent-router 三處呼叫**

在 `intent-router.ts`，把第 53、69、105 行的 `serviceRegistry.enabledFor(session.tenantId)` 一律改為 `serviceRegistry.enabledFor(session.tenantId, session.userId)`。（`session` 於各處皆在作用域內。）

- [ ] **Step 5: 改寫既有測試為 scope 語意**

`server/tests/service-enabled.test.ts` **整檔取代**：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { scopePolicy } from '@/modules/authz/scope-policy';

afterEach(() => scopePolicy.clear());

it('enabledFor：授予服務 scope 才啟用；守門恆在', () => {
  const t = tenantStore.createTenant('svc-scope-test');
  // 未授予任何服務 → 只有守門
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id).sort()).toEqual(['assistant']);
  // 租戶授予 form + knowledge
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:knowledge'] });
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id).sort()).toEqual([
    'assistant',
    'form',
    'knowledge',
  ]);
});

it('部門授予讓該部門使用者多得服務', () => {
  const t = tenantStore.createTenant('svc-scope-dept');
  scopePolicy.setPolicy(t.id, { groups: { 行銷部: ['service:agent'] }, accounts: {} }); // kevin=行銷部
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id)).toContain('agent');
});

it('每個服務都有 label', () => {
  expect(serviceRegistry.all().every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true);
});
```

`server/tests/assistant-guard.test.ts` 底部的 `describe('serviceRegistry.enabledFor', …)` 區塊**整段取代**為：

```ts
describe('serviceRegistry.enabledFor', () => {
  it('assistant 守門服務永遠啟用（未授予任何服務 scope 時仍在）', () => {
    const t = tenantStore.createTenant('guard-always-on');
    const ids = serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id);
    expect(ids).toContain('assistant');
  });
});
```

- [ ] **Step 6: 綠 + 全套 + 型別**

Run: `cd server && npx jest tests/service-enabled.test.ts tests/assistant-guard.test.ts tests/intent-router.test.ts`
Expected: PASS

Run: `cd server && npx jest`
Expected: 全綠。**若 intent-router.test 因「測試租戶未授予服務」而失敗**，於該測試 setup 為所用租戶 `tenantStore.updateTenant(id,{grantedScopes:['service:form','service:knowledge','service:agent']})`（屬 scope 語意調整，非行為回歸）。

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck` → 無誤

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/conversation/agent-service.types.ts server/src/modules/conversation/service.registry.ts server/src/modules/conversation/intent-router.ts server/src/modules/conversation/form.agent-service.ts server/src/modules/knowledge/knowledge.agent-service.ts server/src/modules/conversation/agent.agent-service.ts server/tests/service-enabled.test.ts server/tests/assistant-guard.test.ts
git commit -m "feat(conversation): 服務啟用改由 service:* scope 決定（守門恆在）"
```

---

### Task 3: 表單啟用改看 scope（listEnabledForms 三維 + 呼叫點串 userId）

**Files:**
- Modify: `server/src/modules/conversation/form.agent-service.ts`（`listEnabledForms(tenantId,userId)` 改看 `form:<id>`；內部 `buildSystemPrompt` / `intents` 串 userId）
- Modify: `server/src/modules/conversation/assistant.agent-service.ts`（`guardSystem` 串 userId）
- Modify: `server/src/modules/conversation/intent-router.ts`（`pickFormId(tenantId,message)` → 串 userId；呼叫點）
- Modify (rewrite): `server/tests/form-enabled.test.ts`
- Modify: `server/tests/agent-routing.test.ts`（`listEnabledForms('default')` → 補 userId）

**Interfaces:**
- Produces: `listEnabledForms(tenantId: string, userId: string): Definition[]` — 該租戶表單中，principal 具 `form:<formId>` 者。`pickFormId(tenantId: string, userId: string, message?: string)`。

- [ ] **Step 1: 基準綠**

Run: `cd server && npx jest tests/form-enabled.test.ts tests/agent-routing.test.ts tests/runturn-guard.test.ts`

- [ ] **Step 2: 改 listEnabledForms + 內部呼叫**

`form.agent-service.ts`：
- 頂部加 `import { resolveScopes } from '@/modules/authz/resolve-scopes';` 與 `import { formScopeId } from '@/modules/authz/scope-catalog';`
- 改寫：

```ts
export function listEnabledForms(tenantId: string, userId: string): Definition[] {
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  return listDefinitions(tenantId).filter((d) => scopes.has(formScopeId(d.formId)));
}
```
- `buildSystemPrompt(tenantId, def, locale)` 簽名改為 `buildSystemPrompt(tenantId, userId, def, locale)`，其內 `listEnabledForms(tenantId)` → `listEnabledForms(tenantId, userId)`；`handleTurn` 內呼叫處補 `session.userId`。
- `intents(session)` 內 `listEnabledForms(session.tenantId)` → `listEnabledForms(session.tenantId, session.userId)`。

`assistant.agent-service.ts`：`guardSystem(tenantId, locale)` 改為 `guardSystem(tenantId, userId, locale)`，其內 `listEnabledForms(tenantId)` → `listEnabledForms(tenantId, userId)`；`handleTurn` 呼叫處補 `session.userId`。

`intent-router.ts`：`pickFormId(tenantId, message)` 改為 `pickFormId(tenantId, userId, message?)`，其內 `listEnabledForms(tenantId)` → `listEnabledForms(tenantId, userId)`；更新其呼叫點（在 `conversation.service.ts` 開場路由處，補 userId — 讀該檔找到 `pickFormId(` 呼叫並補入該處的 userId 變數）。

> read-before-edit：實作前開啟各檔確認 `buildSystemPrompt`/`guardSystem`/`pickFormId` 的呼叫點與可用的 userId 變數，逐一補上。

- [ ] **Step 3: 改寫測試**

`server/tests/form-enabled.test.ts` **整檔取代**：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { scopePolicy } from '@/modules/authz/scope-policy';

afterEach(() => scopePolicy.clear());

it('listEnabledForms：授予 form:<id> 才可見', () => {
  const t = tenantStore.createTenant('form-scope-test');
  // 未授予 → 空
  expect(listEnabledForms(t.id, 'kevin').map((d) => d.formId)).toHaveLength(0);
  // 授予 leave-request
  tenantStore.updateTenant(t.id, { grantedScopes: ['form:leave-request'] });
  const ids = listEnabledForms(t.id, 'kevin').map((d) => d.formId);
  expect(ids).toContain('leave-request');
  expect(ids).not.toContain('business-trip-domestic');
});
```

`server/tests/agent-routing.test.ts`：把 `listEnabledForms('default')` 呼叫補成 `listEnabledForms('default', 'kevin')`（或該測試所用 userId）；並確保該測試所用租戶已授予相應 `form:*` / `service:*`（若斷言路由到 form）。

- [ ] **Step 4: 綠 + 全套 + 型別**

Run: `cd server && npx jest`
Expected: 全綠（若因未授予導致 form 相關測試失敗，於 setup 補授予 `service:form` + 對應 `form:<id>`，屬 scope 語意調整）。

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck` → 無誤

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/conversation/form.agent-service.ts server/src/modules/conversation/assistant.agent-service.ts server/src/modules/conversation/intent-router.ts server/src/modules/conversation/conversation.service.ts server/tests/form-enabled.test.ts server/tests/agent-routing.test.ts
git commit -m "feat(conversation): 表單啟用改由 form:<id> scope 決定（三維可控）"
```

---

### Task 4: 遷移既有租戶 + 建租戶/設計表單自動授予

**Files:**
- Modify: `server/src/modules/tenant/tenant.types.ts`（`Tenant` 加 `scopesMigrated?: boolean`）
- Modify: `server/src/modules/tenant/tenant.store.ts`（`updateTenant` Pick 加 `scopesMigrated`；spread 加對應行）
- Create: `server/src/modules/authz/scope-migration.ts`（一次性遷移函式）
- Modify: `server/src/index.ts`（或 app bootstrap）呼叫遷移一次
- Modify: `server/src/modules/admin/admin.controller.ts`（`createTenant` 後自動授予標準服務 + 內建表單；`form create` 後自動授予該 `form:<id>`）
- Test: `server/tests/scope-migration.test.ts`

**Interfaces:**
- Produces: `migrateTenantScopes(): void`（idempotent-by-flag：對 `!scopesMigrated` 的租戶，`grantedScopes = union(既有, 未停用服務 service:*, 未停用表單 form:*)`，設 `scopesMigrated=true`）。`defaultGrantedScopes(tenantId): string[]`（標準服務 + 該租戶內建表單，供建租戶用）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/scope-migration.test.ts`:

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
import { migrateTenantScopes } from '@/modules/authz/scope-migration';
import { resolveScopes } from '@/modules/authz/resolve-scopes';

it('遷移把未停用服務/表單反轉為授予，且冪等（不覆蓋後續調整）', () => {
  const t = tenantStore.createTenant('mig-test');
  // 模擬既有租戶：停用 knowledge、停用 outing 表單、尚未遷移
  tenantStore.updateTenant(t.id, { disabledServices: ['knowledge'], disabledForms: ['outing-registration'] });
  // @ts-expect-error 測試直接清掉遷移旗標模擬舊資料
  tenantStore.updateTenant(t.id, { scopesMigrated: false });

  migrateTenantScopes();
  const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
  expect(scopes).toContain('service:form');
  expect(scopes).not.toContain('service:knowledge'); // 原停用 → 不授予
  expect(scopes).toContain('form:leave-request');
  expect(scopes).not.toContain('form:outing-registration'); // 原停用 → 不授予

  // 冪等：管理者事後移除 service:form，再次遷移不得復原
  const cur = (tenantStore.getTenant(t.id)?.grantedScopes ?? []).filter((s) => s !== 'service:form');
  tenantStore.updateTenant(t.id, { grantedScopes: cur });
  migrateTenantScopes();
  expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).not.toContain('service:form');
});
```

- [ ] **Step 2: 失敗 → 實作**

`tenant.types.ts`：`Tenant` 加

```ts
  /** 是否已完成服務/表單 → scope 的一次性遷移；true 後遷移不再覆寫其授予。 */
  scopesMigrated?: boolean;
```

`tenant.store.ts` `updateTenant`：Pick 加 `'scopesMigrated'`，spread 加

```ts
      ...(patch.scopesMigrated !== undefined ? { scopesMigrated: patch.scopesMigrated } : {}),
```

`scope-migration.ts`:

```ts
/**
 * 一次性遷移：把租戶的 disabledServices/disabledForms（opt-out）反轉為 grantedScopes（opt-in），
 * 保留既有行為。以 scopesMigrated 旗標確保只跑一次——事後管理者的授予調整不會被復原。
 */
import { SERVICE_SCOPE_IDS, formScopeId } from './scope-catalog';
import { listDefinitions } from '@/modules/form/form.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

/** 建租戶用：標準服務 + 該租戶內建表單全部授予。 */
export function defaultGrantedScopes(tenantId: string): string[] {
  const forms = listDefinitions(tenantId).map((d) => formScopeId(d.formId));
  return [...SERVICE_SCOPE_IDS, ...forms];
}

export function migrateTenantScopes(): void {
  for (const t of tenantStore.listTenants()) {
    if (t.scopesMigrated) continue;
    const disabledSvc = new Set(t.disabledServices ?? []);
    const disabledForm = new Set(t.disabledForms ?? []);
    const services = [...SERVICE_SCOPE_IDS].filter((s) => !disabledSvc.has(s.replace('service:', '')));
    const forms = listDefinitions(t.id)
      .map((d) => d.formId)
      .filter((id) => !disabledForm.has(id))
      .map(formScopeId);
    const merged = [...new Set([...(t.grantedScopes ?? []), ...services, ...forms])];
    tenantStore.updateTenant(t.id, { grantedScopes: merged, scopesMigrated: true });
  }
}
```

app bootstrap（`server/src/index.ts` 啟動流程，於 store 載入後、開始服務前）加：

```ts
import { migrateTenantScopes } from '@/modules/authz/scope-migration';
migrateTenantScopes();
```

`admin.controller.ts` `createTenant`：於 `tenantStore.createTenant(...)` 後、回應前加自動授予：

```ts
    tenantStore.updateTenant(tenant.id, {
      grantedScopes: defaultGrantedScopes(tenant.id),
      scopesMigrated: true,
    });
```
（import `defaultGrantedScopes` from `@/modules/authz/scope-migration`；回應改用重新取得的 tenant。）

`form.admin.controller.ts` `create`：於 `formStore.saveDefinition(tenantId, def)` 後，自動授予該表單 scope 給租戶：

```ts
    const t = tenantStore.getTenant(tenantId);
    const granted = new Set(t?.grantedScopes ?? []);
    granted.add(formScopeId(def.formId));
    tenantStore.updateTenant(tenantId, { grantedScopes: [...granted] });
```
（import `formScopeId`、`tenantStore`。）

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/scope-migration.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tenant/tenant.types.ts server/src/modules/tenant/tenant.store.ts server/src/modules/authz/scope-migration.ts server/src/index.ts server/src/modules/admin/admin.controller.ts server/src/modules/form/form.admin.controller.ts server/tests/scope-migration.test.ts
git commit -m "feat(authz): 既有租戶服務/表單遷移為 scope + 建租戶/設計表單自動授予"
```

---

### Task 5: admin 後端（分組能力 + tenant-aware 驗證 + 淘汰 disabled 寫入路徑）

**Files:**
- Modify: `server/src/modules/admin/admin.controller.ts`（`listScopes` 保留全域靜態目錄；`getPolicy`/`setPolicy` 改用 `tenantGrantableScopes(tenantId)` 回傳「該租戶可授能力」並 tenant-aware 驗證）
- Modify: `server/src/modules/admin/admin.schema.ts`（`patchTenantSchema` 移除 `disabledServices`/`disabledForms`）
- Modify: `server/src/modules/admin/admin.routes.ts`（移除 `/tenants/:id/services` 路由）+ 刪 `tenant-services.controller.ts`
- Test: 更新 `server/tests/admin-policy.test.ts`（capabilities 含 form scope；setPolicy 授予 form:<id> 生效）；移除/改寫依賴 services 端點或 disabledServices 的 admin 測試（`tenant-services-admin.test.ts`、`tenant-disabled-fields.test.ts` 相關段）

**Interfaces:**
- Produces: `GET /admin/tenants/:id/policy` 的 `data` 加 `capabilities: ScopeDef[]`（＝`tenantGrantableScopes(tenantId)`，含服務/外部/該租戶表單）。`setPolicy` 用 `assertGrantableScopes(scopes, tenantId)`。

- [ ] **Step 1–2: 讀相關測試 → 寫失敗測試**

在 `admin-policy.test.ts` 追加：授予 `form:leave-request` 後 `resolveScopes` 含之；`getPolicy` 的 `capabilities` 含 `service:form` 與 `form:leave-request`。並把 setPolicy 驗證改以 tenant-aware 案例（授予他租戶不存在的表單被擋）。

- [ ] **Step 3: 實作**

`admin.controller.getPolicy`/`setPolicy`：
- import `tenantGrantableScopes`（替換原本可能回傳 `SCOPE_CATALOG` 給 UI 的部分）。
- `getPolicy` 回應 `data` 加 `capabilities: tenantGrantableScopes(tenant.id)`（保留既有 grantedScopes/groups/accounts/departments/users）。
- `setPolicy` 的三處 `assertGrantableScopes(scopes)` 改為 `assertGrantableScopes(scopes, tenant.id)`。

`admin.schema.ts`：`patchTenantSchema` 移除 `disabledServices`、`disabledForms` 兩行（服務/表單改由 policy 管）。

`admin.routes.ts`：移除 `GET /tenants/:id/services` 路由與其 import；刪除 `server/src/modules/admin/tenant-services.controller.ts`。

- [ ] **Step 4: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest` → 全綠（改寫/移除受影響的 services/disabled 測試後）；`npm run typecheck` → 無誤

```bash
git add server/src/modules/admin/ server/tests/admin-policy.test.ts server/tests/tenant-services-admin.test.ts server/tests/tenant-disabled-fields.test.ts
git commit -m "feat(admin): policy 回傳每租戶分組能力（含表單）、tenant-aware 驗證、淘汰服務開關端點"
```

---

### Task 6: admin 前端（權限分頁分組：服務/表單/外部；移除服務分頁）

**Files:**
- Modify: `admin/src/api.ts`（`TenantPolicyView` 加 `capabilities: ScopeDef[]`；移除 `getTenantServices`/`TenantServiceCatalog` 及 `updateTenant` Pick 的 `disabledServices`/`disabledForms`）
- Modify: `admin/src/pages/tabs/PermissionsTab.tsx`（能力來源改用 `policy.capabilities`；依 id 前綴分組：`service:` 服務、`form:` 表單、其餘 外部）
- Modify: `admin/src/pages/TenantDetailPage.tsx`（移除 `services` 分頁與 `ServicesTab` import/render）
- Delete: `admin/src/pages/tabs/ServicesTab.tsx`

**Interfaces:**
- Consumes: Task 5 的 `capabilities`。

- [ ] **Step 1: api.ts**
- `TenantPolicyView` 加 `capabilities: ScopeDef[];`（可移除對全域 `listScopes` 的依賴，改用 policy 回傳的 capabilities）。
- 移除 `getTenantServices` 與 `TenantServiceCatalog`；`updateTenant` 的 Pick 移除 `'disabledServices' | 'disabledForms'`。

- [ ] **Step 2: PermissionsTab 分組**
- 移除對 `api.listScopes()` 的呼叫，改只 `getTenantPolicy`，能力來源 `const grantable = policy.capabilities;`
- 分組：`const services = grantable.filter(s=>s.id.startsWith('service:'))`、`const forms = grantable.filter(s=>s.id.startsWith('form:'))`、`const external = grantable.filter(s=>!s.id.startsWith('service:') && !s.id.startsWith('form:'))`。
- 「此租戶開通的能力」區 + 部門/帳號表格，欄位改用「服務 / 表單 / 外部」三分組（可沿用現有表格結構，欄位來源換成三組串接或分三張小表；最簡：`const cols = [...services, ...forms, ...external]` 當欄位，維持單表但於表頭以分隔或群組標題呈現）。read-before-edit 現有 PermissionsTab 結構，最小改動達成分組。

- [ ] **Step 3: 移除服務分頁**
`TenantDetailPage.tsx`：移除 `import ServicesTab`、`TabKey` 的 `'services'`、`TABS` 的 `{ key:'services', ... }`、以及 `{tab === 'services' && ...}` render。刪除 `ServicesTab.tsx`。

- [ ] **Step 4: 型別 + 建置 + 手動驗證 + commit**

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck` → 無誤（admin 內含）
Run: `cd "$(git rev-parse --show-toplevel)" && npm run build` → 成功

手動驗證：`npm run dev:server` + `npm run dev:admin` → 進租戶「權限」分頁 → 服務/表單/外部三組皆可勾選、儲存後保留；服務分頁已消失。

```bash
git add admin/src/api.ts admin/src/pages/tabs/PermissionsTab.tsx admin/src/pages/TenantDetailPage.tsx
git rm admin/src/pages/tabs/ServicesTab.tsx
git commit -m "feat(admin): 權限分頁分組（服務/表單/外部），移除服務分頁"
```

---

## 完成後狀態（驗收）

- 服務（form/knowledge/agent）與個別表單（form:<id>）皆為 opt-in scope，可 by 租戶/部門/帳號授予；守門恆在。
- 兩套控制平面收斂為一套：admin 只剩「權限」分頁（服務/表單/外部分組），服務分頁移除。
- 既有租戶經一次性遷移保留原行為；新租戶建立、新表單設計皆自動授予。
- `resolveScopes`/`hasScopes`/工具強制機制不變；全套測試綠、typecheck/build 綠。

## Self-Review 註記

- **Spec 覆蓋**：B1（服務納入 scope、opt-in、消除重疊）、每租戶動態 form scope、遷移 + 自動授予、admin 統一。
- **型別一致**：`serviceScope`、`enabledFor(tenantId,userId)`、`listEnabledForms(tenantId,userId)`、`formScopeId`、`tenantGrantableScopes`、`assertGrantableScopes(ids,tenantId)`、`capabilities` 前後端一致。
- **向後相容策略**：既有行為由「遷移 + 建立時自動授予」保留；受影響測試（service-enabled/form-enabled/assistant-guard/tenant-services/disabled-fields）改寫為 scope 語意，屬預期而非回歸。migration 以 `scopesMigrated` 旗標確保只跑一次、不覆寫後續調整（Task 4 測試涵蓋冪等性）。
- **風險點**：Task 2/3 為路由核心 + 多呼叫點串接，已逐一列出呼叫點並要求 read-before-edit；Task 4 migration 冪等性以旗標 + 測試把關。
