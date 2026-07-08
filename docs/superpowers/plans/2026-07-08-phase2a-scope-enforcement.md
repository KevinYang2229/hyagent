# Phase 2A：權限收緊（resolveScopes 真實化，機制先行）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `resolveScopes` 從「全通過 `['*']`」換成真實的「基礎 ∪ 租戶 ∪ 群組 ∪ 帳號」權限模型，並以 `BASE_SCOPES` 保底，確保現有表單送出、查額度等流程零行為變化；新能力（`email:write` 等）預設被擋，須明確授權。

**Architecture:** 新增 `authz/scope-policy.ts`（`BASE_SCOPES` 常數 + 群組/帳號政策 in-memory store）。改寫 `authz/resolve-scopes.ts`：`resolveScopes = 去重(BASE ∪ 租戶 grantedScopes ∪ groupPolicy[department] ∪ accountPolicy[userId])`，department 取自 `user.directory.getApplicant`。`Tenant` 加 `grantedScopes?` 欄位並讓 `updateTenant` 可寫。執行點（`toolRegistry.invoke` / `availableFor` 的 `hasScopes` 檢查）與工具、服務碼**皆不動**——只換 `resolveScopes` 回傳來源。

**Tech Stack:** TypeScript (NodeNext)、Jest + ts-jest。路徑別名 `@/` → `server/src/`。既有件：[resolve-scopes.ts](../../../server/src/modules/authz/resolve-scopes.ts)、[tool.context.ts](../../../server/src/modules/tools/tool.context.ts)（`makeToolContext` 呼叫 resolveScopes）、[user.directory.ts](../../../server/src/modules/user/user.directory.ts)（`getApplicant(userId).department`）、[tenant.store.ts](../../../server/src/modules/tenant/tenant.store.ts)。

## Global Constraints

- 語言：程式註解與訊息用繁體中文。
- 測試：Jest，`server/tests/*.test.ts`，跑法 `cd server && npx jest <file>`。
- `BASE_SCOPES = ['oa:read', 'oa:write']`——現有工具（查額度 `oa:read`、送單 `oa:write`）所需的全員基礎權限；**收緊後現有流程一律不壞**是本階段鐵則。
- 向後相容驗收：`cd server && npx jest` 全綠（既有 form-submit / leave / oa-tools / agent 等測試不改而仍過，即證明 `oa:read`/`oa:write` 流程未受影響）、根目錄 `npm run typecheck` 通過。
- 不改動 `tool.registry.ts`（`hasScopes`/`invoke`/`availableFor`）、工具定義、對話服務碼；只改 `resolveScopes` 的來源與新增 policy store / tenant 欄位。
- 政策 store 本階段為 in-memory（預設空，僅 BASE 生效）；磁碟持久化與 admin 編輯 UI 延後（seam only）。真實公司 per-部門政策值亦延後填。

---

### Task 1: scope-policy store + resolveScopes 真實化 + tenant.grantedScopes

**Files:**
- Create: `server/src/modules/authz/scope-policy.ts`
- Modify: `server/src/modules/authz/resolve-scopes.ts`（改寫 `resolveScopes`）
- Modify: `server/src/modules/tenant/tenant.types.ts`（`Tenant` 加 `grantedScopes?: string[]`）
- Modify: `server/src/modules/tenant/tenant.store.ts`（`updateTenant` 的 Pick 與 spread 加入 `grantedScopes`）
- Modify (rewrite): `server/tests/resolve-scopes.test.ts`（既有 Phase 0 測試斷言 `['*']`，需改寫）
- Test: `server/tests/scope-enforcement.test.ts`（新增：經 `toolRegistry.invoke` 的端到端強制）

**Interfaces:**
- Consumes: `tenantStore`（`@/modules/tenant/tenant.store`）、`getApplicant`（`@/modules/user/user.directory`）、`makeToolContext`/`toolRegistry`/`registerTool`（`@/modules/tools`）。
- Produces:
  - `BASE_SCOPES: string[]`（`['oa:read','oa:write']`）
  - `scopePolicy`：`groupScopes(department?): string[]`、`accountScopes(userId): string[]`、`setGroupScopes(dep, scopes)`、`setAccountScopes(userId, scopes)`、`clear()`（清群組+帳號政策，測試用；不影響 BASE）
  - `resolveScopes(principal: { tenantId; userId }): string[]` = 去重(BASE ∪ tenant.grantedScopes ∪ group ∪ account)
  - `Tenant.grantedScopes?: string[]`（`updateTenant` 可寫）

- [ ] **Step 1: 寫失敗測試（改寫 resolve-scopes.test.ts）**

以下內容**整檔取代** `server/tests/resolve-scopes.test.ts`：

```ts
/**
 * resolveScopes（權限收緊）：BASE ∪ 租戶 ∪ 群組 ∪ 帳號，去重。
 * BASE_SCOPES 保底，讓現有 oa:read/oa:write 流程不受收緊影響。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { BASE_SCOPES, scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('resolveScopes', () => {
  afterEach(() => scopePolicy.clear());

  it('無額外授權時回 BASE_SCOPES', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' }).sort()).toEqual([...BASE_SCOPES].sort());
  });

  it('併入帳號授權並去重', () => {
    scopePolicy.setAccountScopes('kevin', ['email:write', 'oa:read']); // oa:read 與 BASE 重複
    const scopes = resolveScopes({ tenantId: 't1', userId: 'kevin' });
    expect(scopes).toContain('email:write');
    expect(scopes.filter((s) => s === 'oa:read')).toHaveLength(1); // 去重
  });

  it('併入群組（部門）授權（kevin 屬行銷部）', () => {
    scopePolicy.setGroupScopes('行銷部', ['calendar:read']);
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' })).toContain('calendar:read');
  });

  it('併入租戶 grantedScopes', () => {
    const t = tenantStore.createTenant('scope-tenant');
    tenantStore.updateTenant(t.id, { grantedScopes: ['erp:read'] });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('erp:read');
  });

  it('makeToolContext 帶入解析後的 scopes', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.scopes).toContain('oa:write');
  });
});
```

同時新增 `server/tests/scope-enforcement.test.ts`：

```ts
/**
 * 權限強制（end-to-end via toolRegistry.invoke）：
 * 缺 scope → 403；被授予後 → 可執行；BASE 讓現有 oa 流程仍通。
 */
import { scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';

describe('scope 強制', () => {
  afterEach(() => scopePolicy.clear());

  it('缺少工具所需 scope 的使用者被擋（403）', async () => {
    registerTool({
      id: 'test.needsEmail',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['email:write'],
      handler: async () => 'sent',
    });
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' }); // BASE 無 email:write
    await expect(toolRegistry.invoke('test.needsEmail', {}, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('帳號被授予該 scope 後可執行', async () => {
    registerTool({
      id: 'test.needsEmail2',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['email:write'],
      handler: async () => 'sent',
    });
    scopePolicy.setAccountScopes('kevin', ['email:write']);
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' }); // 授權後才建 ctx
    await expect(toolRegistry.invoke('test.needsEmail2', {}, ctx)).resolves.toBe('sent');
  });

  it('BASE 保底：現有 oa 流程所需 scope 仍在', () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(ctx.scopes).toContain('oa:read');
    expect(ctx.scopes).toContain('oa:write');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/resolve-scopes.test.ts tests/scope-enforcement.test.ts`
Expected: FAIL（`scope-policy` 模組不存在；resolveScopes 仍回 `['*']` 導致新斷言失敗）

- [ ] **Step 3: 建立 scope-policy.ts**

`server/src/modules/authz/scope-policy.ts`:

```ts
/**
 * 權限政策：全員基礎權限 + 群組（部門）/ 帳號授權表。
 *
 * BASE_SCOPES 涵蓋現有工具所需（oa:read 查額度、oa:write 送單），讓權限收緊後現有流程不壞。
 * 群組/帳號政策本階段為 in-memory（預設空，僅 BASE 生效），供 seed / 測試 / 未來 admin 寫入；
 * 磁碟持久化延後（沿用其他 store 之後接 Prisma 的模式）。
 */

/** 全員基礎權限：新能力（email:write 等）不在此，須另行授權。 */
export const BASE_SCOPES = ['oa:read', 'oa:write'];

const groupPolicy = new Map<string, string[]>();
const accountPolicy = new Map<string, string[]>();

export const scopePolicy = {
  /** 部門 → 額外授權 */
  groupScopes(department?: string): string[] {
    return department ? (groupPolicy.get(department) ?? []) : [];
  },
  /** 帳號 → 例外授權 */
  accountScopes(userId: string): string[] {
    return accountPolicy.get(userId) ?? [];
  },
  setGroupScopes(department: string, scopes: string[]): void {
    groupPolicy.set(department, scopes);
  },
  setAccountScopes(userId: string, scopes: string[]): void {
    accountPolicy.set(userId, scopes);
  },
  /** 清空群組/帳號政策（測試用；不影響 BASE_SCOPES 常數）。 */
  clear(): void {
    groupPolicy.clear();
    accountPolicy.clear();
  },
};
```

- [ ] **Step 4: 改寫 resolve-scopes.ts**

以下內容**整檔取代** `server/src/modules/authz/resolve-scopes.ts`:

```ts
/**
 * 權限解析：某 principal 的有效權限 = 去重(基礎 ∪ 租戶 ∪ 群組 ∪ 帳號)。
 *
 * BASE_SCOPES 讓現有工具（oa:read/oa:write）對全員永遠可用，權限收緊不影響既有流程；
 * 新能力（email:write / calendar:* / erp:* 等）不在 BASE，須由租戶 grantedScopes、
 * 群組（部門）或帳號政策明確授權。department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { BASE_SCOPES, scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const tenantScopes = tenantStore.getTenant(principal.tenantId)?.grantedScopes ?? [];
  const department = getApplicant(principal.userId).department;
  const groupScopes = scopePolicy.groupScopes(department);
  const accountScopes = scopePolicy.accountScopes(principal.userId);
  return [...new Set([...BASE_SCOPES, ...tenantScopes, ...groupScopes, ...accountScopes])];
}
```

- [ ] **Step 5: Tenant 加 grantedScopes 欄位 + updateTenant 可寫**

在 `server/src/modules/tenant/tenant.types.ts` 的 `Tenant` 介面內（`createdAt` 之前）加入：

```ts
  /**
   * 此租戶已開通（買了）哪些能力 scope，如 ['email:write']。
   * 與群組/帳號政策一起併入 resolveScopes；未設＝不額外授權（仍有 BASE_SCOPES）。
   */
  grantedScopes?: string[];
```

在 `server/src/modules/tenant/tenant.store.ts` 的 `updateTenant`：
- 把 Pick 的欄位清單加上 `'grantedScopes'`（即 `... | 'disabledForms' | 'grantedScopes'`）。
- 在 `next` 物件的逐欄 spread 尾端（`disabledForms` 那行之後）加入：

```ts
      ...(patch.grantedScopes !== undefined ? { grantedScopes: patch.grantedScopes } : {}),
```

- [ ] **Step 6: 跑新測試確認通過**

Run: `cd server && npx jest tests/resolve-scopes.test.ts tests/scope-enforcement.test.ts`
Expected: PASS（resolve-scopes 5 tests + scope-enforcement 3 tests）

- [ ] **Step 7: 全套 + 型別（向後相容鐵則驗收）**

Run: `cd server && npx jest`
Expected: 全數 PASS——**特別確認既有 `tests/form-generic-submit`、`tests/leave-tool-submit`、`tests/oa-tools`、`tests/agent-service`、`tests/tool-available` 不改而仍過**（證明 `oa:read`/`oa:write` 流程未受權限收緊影響）。

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/authz/scope-policy.ts server/src/modules/authz/resolve-scopes.ts server/src/modules/tenant/tenant.types.ts server/src/modules/tenant/tenant.store.ts server/tests/resolve-scopes.test.ts server/tests/scope-enforcement.test.ts
git commit -m "feat(authz): resolveScopes 真實化為 BASE∪租戶∪群組∪帳號，權限強制上線"
```

---

## 完成後狀態（Phase 2A 驗收）

- `resolveScopes` 從全通過換成真實模型；`toolRegistry.invoke` 的既有 `hasScopes` 檢查因此**真的生效**——缺 scope 的呼叫被 403 擋下（測試涵蓋）。
- `BASE_SCOPES` 保底：所有現有 `oa:read`/`oa:write` 流程零行為變化（既有測試不改而全綠即為證）。
- 授權來源三維（租戶 grantedScopes / 群組部門 / 帳號例外）就位，可 seed、可測；真實政策值與 admin UI 留待後續。
- 為 Email（Phase 2B：`email.send` 需 `email:write`，預設被擋、須授權）與 Workflow 留好權限地基。

## Self-Review 註記

- **Spec 覆蓋**：對應藍圖 §7.3–7.4（resolveScopes union、由全通過平滑收緊）、§8 Phase 2「權限收緊」。BASE_SCOPES 是「平滑收緊、上層零改動」的落地手法。
- **型別一致**：`resolveScopes(principal)`、`scopePolicy.*`、`BASE_SCOPES`、`Tenant.grantedScopes` 一致；`hasScopes`（tool.registry）沿用不動，`'*'` 萬用字元仍支援（未來 admin 可授 `'*'` 給某租戶）。
- **無 placeholder**：兩測試檔給了完整內容；tenant.store 改動指出 Pick 與 spread 的確切加法。
- **向後相容風險**：唯一會壞的既有測試是 resolve-scopes.test.ts（斷言 `['*']`）——已整檔改寫；其餘既有測試因 BASE 保住 oa scope 而不需改，且列為 Step 7 明確驗收項。
