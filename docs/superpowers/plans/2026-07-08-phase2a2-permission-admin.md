# Phase 2A-2：權限管理 admin 介面（租戶 + 部門 + 帳號）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓管理者在 admin 後台的「權限」分頁設定「此租戶開通哪些能力、哪些部門/帳號有哪些能力」，三維授權（租戶 grantedScopes、部門、帳號）皆可視覺化設定並持久化，`resolveScopes` 據此強制。

**Architecture:** 新增 scope 目錄（單一來源）；把 Phase 2A 的全域 in-memory `scopePolicy` 改成**每租戶 + 磁碟持久化**的 store（比照 tenant/usage store），`resolveScopes` 改讀每租戶政策；admin 後端加 `/scopes` 與 `/tenants/:id/policy`（GET/PUT）；admin 前端加「權限」分頁。分四個任務：目錄 → 每租戶 store/解析 → 後端 API → 前端 UI。

**Tech Stack:** 後端 TypeScript/Express/Zod/Jest；前端 admin（Vite + React，`@oa-agent/ui` 元件、`card`/`list`/`row`/`btn` CSS class、`Checkbox`）。回應包 `{ data }`；admin API client 用 `req<T>(method, path, body)`（回 `data`）。

## Global Constraints

- 語言：程式註解、UI 文案、錯誤訊息用繁體中文。
- BASE 能力 `oa:read`/`oa:write` 為全員預設、**不可授予也不可取消**（UI 唯讀顯示）；只有 grantable（非 BASE）scope 可被授予。**不接受 `'*'`**（目錄外一律拒絕）——永久解掉萬用字元隱患。
- 向後相容鐵則：`resolveScopes` 對既有流程零影響（BASE 保底），`cd server && npx jest` 全綠、根目錄 `npm run typecheck` 通過、`npm run build` 通過（含 admin）。
- 政策 store 每租戶 + 磁碟持久化，比照 [usage.store.ts](../../../server/src/modules/usage/usage.store.ts) 的 in-memory+`os.tmpdir()` JSON 模式。
- admin 分頁標籤沿用現有 hardcoded 中文（現有 tabs 皆硬寫中文，不走 i18n）。
- 不改動 `tool.registry.ts`（`hasScopes`/`invoke`/`availableFor`）與工具/服務碼。

---

### Task 1: scope 目錄（單一來源）

**Files:**
- Create: `server/src/modules/authz/scope-catalog.ts`
- Test: `server/tests/scope-catalog.test.ts`

**Interfaces:**
- Produces:
  - `interface ScopeDef { id: string; label: string; description: string; base: boolean }`
  - `SCOPE_CATALOG: ScopeDef[]`
  - `BASE_SCOPE_IDS: string[]`（`base===true` 者）
  - `GRANTABLE_SCOPES: ScopeDef[]`、`GRANTABLE_SCOPE_IDS: Set<string>`（`base===false` 者）
  - `isGrantableScope(id: string): boolean`
  - `assertGrantableScopes(ids: string[]): void`（有非 grantable 者 throw `AppError.badRequest`）

- [ ] **Step 1: 寫失敗測試**

`server/tests/scope-catalog.test.ts`:

```ts
/** scope 目錄：BASE 與 grantable 分類、grantable 驗證。 */
import {
  BASE_SCOPE_IDS,
  GRANTABLE_SCOPE_IDS,
  assertGrantableScopes,
  isGrantableScope,
} from '@/modules/authz/scope-catalog';

describe('scope-catalog', () => {
  it('BASE 含 oa:read / oa:write，且不在 grantable', () => {
    expect(BASE_SCOPE_IDS).toEqual(expect.arrayContaining(['oa:read', 'oa:write']));
    expect(GRANTABLE_SCOPE_IDS.has('oa:read')).toBe(false);
  });

  it('email:write 為 grantable', () => {
    expect(isGrantableScope('email:write')).toBe(true);
  });

  it('assertGrantableScopes 對非 grantable（含 BASE 與未知）丟 400', () => {
    expect(() => assertGrantableScopes(['email:write'])).not.toThrow();
    expect(() => assertGrantableScopes(['oa:write'])).toThrow(); // BASE 不可授予
    expect(() => assertGrantableScopes(['*'])).toThrow();
    expect(() => assertGrantableScopes(['nope:read'])).toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/scope-catalog.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作 scope-catalog.ts**

```ts
/**
 * Scope 目錄：全系統可辨識的能力清單（單一來源）。
 * base=true 為全員基礎（BASE，不可授予/取消）；base=false 為可授予能力（grantable）。
 * admin UI 據此渲染、後端據此驗證（授予範圍只能是 grantable，杜絕目錄外與 '*'）。
 */
import { AppError } from '@/utils/app-error';

export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  base: boolean;
}

export const SCOPE_CATALOG: ScopeDef[] = [
  { id: 'oa:read', label: '查詢額度', description: '查詢假別剩餘時數等唯讀資料', base: true },
  { id: 'oa:write', label: '送出表單', description: '將表單送至 OA 系統', base: true },
  { id: 'email:write', label: '寄送 Email', description: '代寄通知信 / 邀請信', base: false },
  { id: 'calendar:read', label: '讀取行事曆', description: '查詢空檔 / 會議', base: false },
  { id: 'calendar:write', label: '建立行事曆', description: '建立會議 / 邀請', base: false },
  { id: 'erp:read', label: '讀取 ERP', description: '查詢庫存 / 訂單 / 人事等', base: false },
];

export const BASE_SCOPE_IDS: string[] = SCOPE_CATALOG.filter((s) => s.base).map((s) => s.id);
export const GRANTABLE_SCOPES: ScopeDef[] = SCOPE_CATALOG.filter((s) => !s.base);
export const GRANTABLE_SCOPE_IDS: Set<string> = new Set(GRANTABLE_SCOPES.map((s) => s.id));

export function isGrantableScope(id: string): boolean {
  return GRANTABLE_SCOPE_IDS.has(id);
}

/** 驗證一組 scope 皆為可授予；否則丟 400（BASE、'*'、目錄外皆不可授予）。 */
export function assertGrantableScopes(ids: string[]): void {
  const bad = ids.filter((id) => !GRANTABLE_SCOPE_IDS.has(id));
  if (bad.length > 0) throw AppError.badRequest(`不可授予的 scope：${bad.join('、')}`);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd server && npx jest tests/scope-catalog.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/authz/scope-catalog.ts server/tests/scope-catalog.test.ts
git commit -m "feat(authz): scope 目錄（BASE / grantable 單一來源 + 授予驗證）"
```

---

### Task 2: 每租戶政策 store + resolveScopes 改讀每租戶（含持久化）

**Files:**
- Modify (rewrite): `server/src/modules/authz/scope-policy.ts`（全域 → 每租戶 + 磁碟持久化）
- Modify: `server/src/modules/authz/resolve-scopes.ts`（每租戶查詢 + BASE 改由 catalog 來）
- Modify (rewrite): `server/tests/resolve-scopes.test.ts`（改每租戶簽名）
- Modify (rewrite): `server/tests/scope-enforcement.test.ts`（改每租戶簽名）

**Interfaces:**
- Consumes: `BASE_SCOPE_IDS`（`./scope-catalog`）。
- Produces:
  - `interface TenantPolicy { groups: Record<string, string[]>; accounts: Record<string, string[]> }`
  - `scopePolicy.groupScopes(tenantId, department?): string[]`
  - `scopePolicy.accountScopes(tenantId, userId): string[]`
  - `scopePolicy.getPolicy(tenantId): TenantPolicy`（回**複本**）
  - `scopePolicy.setPolicy(tenantId, policy: TenantPolicy): void`（存複本 + 持久化）
  - `scopePolicy.clear(): void`（測試用）
  - `resolveScopes({tenantId, userId})` 不變簽名，改讀每租戶政策 + `BASE_SCOPE_IDS`。

- [ ] **Step 1: 先確認基準綠**

Run: `cd server && npx jest tests/resolve-scopes.test.ts tests/scope-enforcement.test.ts`
Expected: PASS（Phase 2A 版本；改動前基準）

- [ ] **Step 2: 改寫測試（先紅）**

**整檔取代** `server/tests/resolve-scopes.test.ts`:

```ts
/** resolveScopes（每租戶）：BASE ∪ 租戶 ∪ 群組(該租戶) ∪ 帳號(該租戶)，去重。 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { BASE_SCOPE_IDS } from '@/modules/authz/scope-catalog';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('resolveScopes', () => {
  afterEach(() => scopePolicy.clear());

  it('無額外授權時回 BASE_SCOPE_IDS', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' }).sort()).toEqual([...BASE_SCOPE_IDS].sort());
  });

  it('部門授權只作用於該租戶', () => {
    scopePolicy.setPolicy('tenant-A', { groups: { 行銷部: ['email:write'] }, accounts: {} });
    expect(resolveScopes({ tenantId: 'tenant-A', userId: 'kevin' })).toContain('email:write'); // kevin=行銷部
    expect(resolveScopes({ tenantId: 'tenant-B', userId: 'kevin' })).not.toContain('email:write'); // 他租戶不受影響
  });

  it('帳號例外授權（該租戶）並去重', () => {
    scopePolicy.setPolicy('tenant-A', { groups: {}, accounts: { kevin: ['email:write', 'oa:read'] } });
    const scopes = resolveScopes({ tenantId: 'tenant-A', userId: 'kevin' });
    expect(scopes).toContain('email:write');
    expect(scopes.filter((s) => s === 'oa:read')).toHaveLength(1);
  });

  it('併入租戶 grantedScopes', () => {
    const t = tenantStore.createTenant('scope-tenant');
    tenantStore.updateTenant(t.id, { grantedScopes: ['erp:read'] });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('erp:read');
  });

  it('makeToolContext 帶入解析後的 scopes（含 BASE）', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx.scopes).toContain('oa:write');
  });
});
```

**整檔取代** `server/tests/scope-enforcement.test.ts`:

```ts
/** 權限強制（end-to-end via toolRegistry.invoke），每租戶政策。 */
import { scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';

describe('scope 強制', () => {
  afterEach(() => scopePolicy.clear());

  it('缺少工具所需 scope 的使用者被擋（403）', async () => {
    registerTool({ id: 'test.needsEmail', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], handler: async () => 'sent' });
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    await expect(toolRegistry.invoke('test.needsEmail', {}, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('該租戶帳號被授予後可執行', async () => {
    registerTool({ id: 'test.needsEmail2', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], handler: async () => 'sent' });
    scopePolicy.setPolicy('default', { groups: {}, accounts: { kevin: ['email:write'] } });
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    await expect(toolRegistry.invoke('test.needsEmail2', {}, ctx)).resolves.toBe('sent');
  });

  it('BASE 保底：現有 oa 流程所需 scope 仍在', () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(ctx.scopes).toEqual(expect.arrayContaining(['oa:read', 'oa:write']));
  });
});
```

Run: `cd server && npx jest tests/resolve-scopes.test.ts tests/scope-enforcement.test.ts`
Expected: FAIL（`scopePolicy.setPolicy` 不存在 / groupScopes 簽名不符）

- [ ] **Step 3: 改寫 scope-policy.ts（每租戶 + 持久化）**

**整檔取代** `server/src/modules/authz/scope-policy.ts`:

```ts
/**
 * 權限政策（每租戶）：部門 / 帳號授權表，in-memory + 磁碟持久化（比照 usage.store）。
 * BASE 能力見 scope-catalog（全員預設，不在此表）。政策以 tenantId 隔離，跨租戶互不影響。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';

export interface TenantPolicy {
  groups: Record<string, string[]>; // 部門 → scopes
  accounts: Record<string, string[]>; // userId → scopes
}

const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-scope-policy.json');
const policies = new Map<string, TenantPolicy>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...policies.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist scope policy');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, TenantPolicy][];
    for (const [k, v] of raw) policies.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore scope policy; starting empty');
}

function clone(p: TenantPolicy): TenantPolicy {
  return { groups: { ...p.groups }, accounts: { ...p.accounts } };
}

const EMPTY: TenantPolicy = { groups: {}, accounts: {} };

export const scopePolicy = {
  groupScopes(tenantId: string, department?: string): string[] {
    if (!department) return [];
    return policies.get(tenantId)?.groups[department] ?? [];
  },
  accountScopes(tenantId: string, userId: string): string[] {
    return policies.get(tenantId)?.accounts[userId] ?? [];
  },
  /** 取某租戶政策複本（admin 讀取用）。 */
  getPolicy(tenantId: string): TenantPolicy {
    return clone(policies.get(tenantId) ?? EMPTY);
  },
  /** 整包覆寫某租戶政策（admin 儲存用）。 */
  setPolicy(tenantId: string, policy: TenantPolicy): void {
    policies.set(tenantId, clone(policy));
    persist();
  },
  /** 清空（測試用）。 */
  clear(): void {
    policies.clear();
    persist();
  },
};
```

- [ ] **Step 4: 改寫 resolve-scopes.ts（每租戶 + BASE 來自 catalog）**

**整檔取代** `server/src/modules/authz/resolve-scopes.ts`:

```ts
/**
 * 權限解析：某 principal 的有效權限 = 去重(BASE ∪ 租戶 grantedScopes ∪ 群組(該租戶) ∪ 帳號(該租戶))。
 * BASE 讓現有工具（oa:read/oa:write）對全員永遠可用；其餘須由租戶/部門/帳號政策明確授權。
 * department 取自 user 目錄（之後接真實 HR 換該層即可）。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { BASE_SCOPE_IDS } from './scope-catalog';
import { scopePolicy } from './scope-policy';

export interface ScopePrincipal {
  tenantId: string;
  userId: string;
}

export function resolveScopes(principal: ScopePrincipal): string[] {
  const { tenantId, userId } = principal;
  const tenantScopes = tenantStore.getTenant(tenantId)?.grantedScopes ?? [];
  const department = getApplicant(userId).department;
  const groupScopes = scopePolicy.groupScopes(tenantId, department);
  const accountScopes = scopePolicy.accountScopes(tenantId, userId);
  return [...new Set([...BASE_SCOPE_IDS, ...tenantScopes, ...groupScopes, ...accountScopes])];
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd server && npx jest tests/resolve-scopes.test.ts tests/scope-enforcement.test.ts tests/scope-catalog.test.ts`
Expected: PASS

- [ ] **Step 6: 全套 + 型別（向後相容驗收）**

Run: `cd server && npx jest`
Expected: 全數 PASS（既有 form-submit / leave / oa-tools / agent 等不改而仍過）

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/authz/scope-policy.ts server/src/modules/authz/resolve-scopes.ts server/tests/resolve-scopes.test.ts server/tests/scope-enforcement.test.ts
git commit -m "feat(authz): 政策改為每租戶並持久化，resolveScopes 讀每租戶政策"
```

---

### Task 3: admin 後端 API（scopes 目錄 + 每租戶政策 GET/PUT + grantedScopes）

**Files:**
- Modify: `server/src/modules/user/user.directory.ts`（加 `listDepartments()`）
- Modify: `server/src/modules/admin/admin.schema.ts`（`patchTenantSchema` 加 `grantedScopes`；新增 `putPolicySchema`）
- Modify: `server/src/modules/admin/admin.controller.ts`（加 `listScopes` / `getPolicy` / `setPolicy`）
- Modify: `server/src/modules/admin/admin.routes.ts`（加三條路由）
- Test: `server/tests/admin-policy.test.ts`

**Interfaces:**
- Consumes: `SCOPE_CATALOG`/`GRANTABLE_SCOPE_IDS`/`assertGrantableScopes`（scope-catalog）、`scopePolicy`（scope-policy）、`tenantStore`、`listDepartments`/`listUserIds`/`getApplicant`（user.directory）。
- Produces（皆包 `{ data }`）：
  - `GET /api/admin/scopes` → `ScopeDef[]`
  - `GET /api/admin/tenants/:id/policy` → `{ grantedScopes: string[]; groups; accounts; departments: string[]; users: {id:string;label:string}[] }`
  - `PUT /api/admin/tenants/:id/policy`（body：`{ grantedScopes, groups, accounts }`）→ 同 GET 形狀
  - `listDepartments(): string[]`

- [ ] **Step 1: 寫失敗測試**

`server/tests/admin-policy.test.ts`:

```ts
/** admin 權限 API：讀目錄、讀/寫每租戶政策、grantable 驗證。 */
import { adminController } from '@/modules/admin/admin.controller';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { resolveScopes } from '@/modules/authz/resolve-scopes';

function mockRes() {
  const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => void } = {
    status(n) { res.statusCode = n; return res; },
    json(b) { res.body = b; },
  } as never;
  return res;
}

describe('admin 權限 API', () => {
  afterEach(() => scopePolicy.clear());

  it('listScopes 回目錄（含 base 與 grantable）', async () => {
    const res = mockRes();
    await adminController.listScopes({} as never, res as never);
    const data = (res.body as { data: { id: string; base: boolean }[] }).data;
    expect(data.some((s) => s.id === 'oa:read' && s.base)).toBe(true);
    expect(data.some((s) => s.id === 'email:write' && !s.base)).toBe(true);
  });

  it('setPolicy 寫入後 resolveScopes 生效；GET 讀回', async () => {
    const t = tenantStore.createTenant('admin-policy-test');
    const req = { params: { id: t.id }, body: { grantedScopes: ['erp:read'], groups: { 行銷部: ['email:write'] }, accounts: {} } };
    await adminController.setPolicy(req as never, mockRes() as never);

    // 生效：kevin=行銷部 → email:write（群組）+ erp:read（租戶）
    const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
    expect(scopes).toEqual(expect.arrayContaining(['email:write', 'erp:read', 'oa:read', 'oa:write']));

    // GET 讀回
    const getRes = mockRes();
    await adminController.getPolicy({ params: { id: t.id } } as never, getRes as never);
    const body = (getRes.body as { data: { grantedScopes: string[]; groups: Record<string, string[]> } }).data;
    expect(body.grantedScopes).toContain('erp:read');
    expect(body.groups['行銷部']).toContain('email:write');
  });

  it('授予非 grantable（BASE/未知）被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-bad');
    const req = { params: { id: t.id }, body: { grantedScopes: ['oa:write'], groups: {}, accounts: {} } };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd server && npx jest tests/admin-policy.test.ts`
Expected: FAIL（`adminController.listScopes` 不存在等）

- [ ] **Step 3: user.directory 加 listDepartments**

在 `server/src/modules/user/user.directory.ts` 末尾（`listUserIds` 附近）加入：

```ts
/** 目錄中出現過的部門清單（去重）；admin 權限設定的部門來源。 */
export function listDepartments(): string[] {
  const set = new Set<string>();
  for (const p of Object.values(DIRECTORY)) if (p.department) set.add(p.department);
  for (const p of PEOPLE) if (p.department) set.add(p.department);
  return [...set];
}
```

- [ ] **Step 4: admin.schema.ts 加欄位與 policy schema**

在 `patchTenantSchema` 的 `.object({...})` 內加一行（`disabledForms` 之後）：

```ts
    grantedScopes: z.array(z.string()).optional(),
```

在檔案末尾（型別 export 之前）加入：

```ts
export const putPolicySchema = z.object({
  grantedScopes: z.array(z.string()),
  groups: z.record(z.string(), z.array(z.string())),
  accounts: z.record(z.string(), z.array(z.string())),
});
export type PutPolicyInput = z.infer<typeof putPolicySchema>;
```

- [ ] **Step 5: admin.controller.ts 加三個方法**

在 `server/src/modules/admin/admin.controller.ts` 檔案頂端 import 區加入：

```ts
import { SCOPE_CATALOG, assertGrantableScopes } from '@/modules/authz/scope-catalog';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { getApplicant, listDepartments, listUserIds } from '@/modules/user/user.directory';
import type { PutPolicyInput } from './admin.schema';
```

在 `adminController` 物件內（`getUsage` 之後）加入：

```ts
  async listScopes(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: SCOPE_CATALOG });
  },

  async getPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        grantedScopes: tenant.grantedScopes ?? [],
        groups: policy.groups,
        accounts: policy.accounts,
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },

  async setPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as PutPolicyInput;
    // 授予範圍一律限 grantable（擋 BASE / '*' / 目錄外）
    assertGrantableScopes(body.grantedScopes);
    for (const scopes of Object.values(body.groups)) assertGrantableScopes(scopes);
    for (const scopes of Object.values(body.accounts)) assertGrantableScopes(scopes);

    tenantStore.updateTenant(tenant.id, { grantedScopes: body.grantedScopes });
    scopePolicy.setPolicy(tenant.id, { groups: body.groups, accounts: body.accounts });

    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        grantedScopes: body.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },
```

- [ ] **Step 6: admin.routes.ts 加三條路由**

在 `server/src/modules/admin/admin.routes.ts` import 的 schema 區把 `putPolicySchema` 加進來（與其他 schema import 並列），並在「服務 catalog」路由附近加入：

```ts
router.get('/scopes', asyncHandler(adminController.listScopes));

router.get(
  '/tenants/:id/policy',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getPolicy),
);
router.put(
  '/tenants/:id/policy',
  validate({ params: tenantParamSchema, body: putPolicySchema }),
  asyncHandler(adminController.setPolicy),
);
```

- [ ] **Step 7: 跑測試 + 全套 + 型別**

Run: `cd server && npx jest tests/admin-policy.test.ts`
Expected: PASS（3 tests）

Run: `cd server && npx jest`
Expected: 全數 PASS

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/user/user.directory.ts server/src/modules/admin/admin.schema.ts server/src/modules/admin/admin.controller.ts server/src/modules/admin/admin.routes.ts server/tests/admin-policy.test.ts
git commit -m "feat(admin): scopes 目錄與每租戶權限政策 API（GET/PUT policy）"
```

---

### Task 4: admin 前端「權限」分頁

**Files:**
- Modify: `admin/src/api.ts`（`Tenant.grantedScopes?`、`updateTenant` Pick 加 `grantedScopes`、新增型別與 `listScopes`/`getTenantPolicy`/`putTenantPolicy`）
- Create: `admin/src/pages/tabs/PermissionsTab.tsx`
- Modify: `admin/src/pages/TenantDetailPage.tsx`（加 `permissions` 分頁）

**Interfaces:**
- Consumes: Task 3 的 `GET /admin/scopes`、`GET/PUT /admin/tenants/:id/policy`。
- Produces:
  - `interface ScopeDef { id; label; description; base }`
  - `interface TenantPolicyView { grantedScopes: string[]; groups: Record<string,string[]>; accounts: Record<string,string[]>; departments: string[]; users: {id:string;label:string}[] }`
  - `api.listScopes()`、`api.getTenantPolicy(id)`、`api.putTenantPolicy(id, body)`

- [ ] **Step 1: api.ts 加型別與 client 方法**

在 `admin/src/api.ts`：
- 在 `Tenant` 介面加 `grantedScopes?: string[];`。
- 在 `updateTenant` 的 Pick 型別加上 `| 'grantedScopes'`。
- 在型別區加入：

```ts
export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  base: boolean;
}
export interface TenantPolicyView {
  grantedScopes: string[];
  groups: Record<string, string[]>;
  accounts: Record<string, string[]>;
  departments: string[];
  users: { id: string; label: string }[];
}
```

- 在 `api` 物件內加入（與 `getTenantServices` 並列）：

```ts
  listScopes: () => req<ScopeDef[]>('GET', '/admin/scopes'),
  getTenantPolicy: (id: string) => req<TenantPolicyView>('GET', `/admin/tenants/${id}/policy`),
  putTenantPolicy: (
    id: string,
    body: { grantedScopes: string[]; groups: Record<string, string[]>; accounts: Record<string, string[]> },
  ) => req<TenantPolicyView>('PUT', `/admin/tenants/${id}/policy`, body),
```

- [ ] **Step 2: 建立 PermissionsTab.tsx**

`admin/src/pages/tabs/PermissionsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Checkbox, useToast } from '@oa-agent/ui';
import { api, type ScopeDef, type TenantPolicyView } from '../../api';

/** 切換某 scope 是否在清單內（回新陣列）。 */
function toggle(list: string[], scope: string): string[] {
  return list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope];
}

export default function PermissionsTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [scopes, setScopes] = useState<ScopeDef[] | null>(null);
  const [policy, setPolicy] = useState<TenantPolicyView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cat, pol] = await Promise.all([api.listScopes(), api.getTenantPolicy(tenantId)]);
      setScopes(cat);
      setPolicy(pol);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!scopes || !policy)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );

  const baseScopes = scopes.filter((s) => s.base);
  const grantable = scopes.filter((s) => !s.base);

  const toggleTenant = (id: string) =>
    setPolicy((p) => (p ? { ...p, grantedScopes: toggle(p.grantedScopes, id) } : p));
  const toggleGroup = (dep: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, groups: { ...p.groups, [dep]: toggle(p.groups[dep] ?? [], id) } } : p,
    );
  const toggleAccount = (userId: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, accounts: { ...p.accounts, [userId]: toggle(p.accounts[userId] ?? [], id) } } : p,
    );

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const updated = await api.putTenantPolicy(tenantId, {
        grantedScopes: policy.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
      });
      setPolicy(updated);
      toast.success('已儲存變更');
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const cell = (checked: boolean, onChange: () => void) => (
    <td style={{ textAlign: 'center' }}>
      <Checkbox checked={checked} onChange={onChange} />
    </td>
  );

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">權限</div>
          <div className="card-desc">
            設定此租戶開通的能力，以及各部門 / 帳號可用的能力。基礎能力為全員預設、不可調整。
          </div>
        </div>
      </div>

      {/* ① 全員預設（唯讀） */}
      <div className="card-body">
        <div style={{ fontWeight: 500, marginBottom: 8 }}>全員預設（不可調整）</div>
        <ul className="list">
          {baseScopes.map((s) => (
            <li key={s.id} className="row" style={{ opacity: 0.6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox checked disabled onChange={() => {}} />
                <span>{s.label}</span>
                <span className="row-sub" style={{ marginLeft: 4 }}>
                  {s.id}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* ② 此租戶開通的能力 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>此租戶開通的能力</div>
        <ul className="list">
          {grantable.map((s) => (
            <li key={s.id} className="row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <Checkbox
                  checked={policy.grantedScopes.includes(s.id)}
                  onChange={() => toggleTenant(s.id)}
                />
                <span>{s.label}</span>
                <span className="row-sub" style={{ marginLeft: 4 }}>
                  {s.id}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* ③ 部門授權 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>部門授權</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>部門</th>
                {grantable.map((s) => (
                  <th key={s.id}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.departments.map((dep) => (
                <tr key={dep}>
                  <td>{dep}</td>
                  {grantable.map((s) =>
                    cell((policy.groups[dep] ?? []).includes(s.id), () => toggleGroup(dep, s.id)),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ④ 帳號例外 */}
      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>帳號例外</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>帳號</th>
                {grantable.map((s) => (
                  <th key={s.id}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.label}
                    <span className="row-sub" style={{ marginLeft: 4 }}>
                      {u.id}
                    </span>
                  </td>
                  {grantable.map((s) =>
                    cell((policy.accounts[u.id] ?? []).includes(s.id), () => toggleAccount(u.id, s.id)),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          儲存
        </button>
      </div>
    </div>
  );
}
```

> 若 admin 尚無 `.table` 樣式 class，沿用現有表格樣式或改用與其他 tab 一致的 `list`/`row` 呈現；實作時先確認 `admin/src/index.css` 是否有 `.table`，無則以 inline style 給最小邊框即可（不影響功能）。

- [ ] **Step 3: 接進 TenantDetailPage**

在 `admin/src/pages/TenantDetailPage.tsx`：
- import：`import PermissionsTab from './tabs/PermissionsTab';`
- `TabKey` 型別加 `'permissions'`。
- `TABS` 陣列加入（放在 `services` 之後）：`{ key: 'permissions', label: '權限' },`
- 在 render 分頁內容處（其他 `tab === 'services' && <ServicesTab .../>` 附近）加入：

```tsx
{tab === 'permissions' && <PermissionsTab tenantId={id} onError={handleErr} />}
```

（`id`、`handleErr` 為該頁既有變數，與 ServicesTab 用法一致。）

- [ ] **Step 4: 型別 + 建置驗收**

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck`
Expected: 無型別錯誤（含 admin）

Run: `cd "$(git rev-parse --show-toplevel)" && npm run build`
Expected: 建置成功（含 admin）

- [ ] **Step 5: 手動驗證（實際畫面）**

啟動 `npm run dev:server` 與 `npm run dev:admin`，登入後台 → 進任一租戶 → 「權限」分頁：
- 全員預設兩項為唯讀勾選；
- 勾選某能力 / 某部門×能力 / 某帳號×能力 → 儲存 → 重新載入仍保留；
- （可另用 curl 對 `PUT /api/admin/tenants/:id/policy` 授予非 grantable，確認回 400。）

- [ ] **Step 6: Commit**

```bash
git add admin/src/api.ts admin/src/pages/tabs/PermissionsTab.tsx admin/src/pages/TenantDetailPage.tsx
git commit -m "feat(admin): 權限分頁（租戶/部門/帳號能力設定）"
```

---

## 完成後狀態（驗收）

- admin 後台每租戶新增「權限」分頁，管理者可視覺化設定三維授權（租戶開通能力 / 部門 / 帳號），儲存後持久化、`resolveScopes` 即時生效。
- 授予範圍受 scope 目錄約束（只能授 grantable，擋 BASE / `'*'` / 目錄外）——永久解掉萬用字元隱患。
- BASE 能力全員唯讀顯示；既有 OA 流程零影響（既有測試不改而全綠）。
- 政策每租戶隔離、磁碟持久化。
- 這是 Phase 2 第一個**在 admin 畫面看得到**的成果。

## Self-Review 註記

- **Spec 覆蓋**：延伸藍圖 §7.3（RBAC 三維：租戶∩群組∩帳號）與「§7 admin 編輯政策」的延後項；把 Phase 2A 的全域政策升級為每租戶 + 持久化 + admin UI。
- **型別一致**：`TenantPolicy`/`scopePolicy.*`/`ScopeDef`/`TenantPolicyView`/`putTenantPolicy` 前後端一致；後端回應與前端型別對齊（grantedScopes/groups/accounts/departments/users）。
- **向後相容**：唯一會壞的既有測試是 Phase 2A 的 resolve-scopes / scope-enforcement（簽名改每租戶）→ 已於 Task 2 整檔改寫；其餘既有測試因 BASE 保底不需改，列為 Task 2 Step 6 驗收。
- **無 placeholder**：四任務均含完整程式碼；前端 `.table` 樣式的不確定性以明確 fallback 指示處理，不留待實作臆測。
