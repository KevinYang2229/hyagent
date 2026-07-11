# Tool Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 對「有副作用」的工具（email.send、oa.submitForm）建立稽核軌跡——`toolRegistry.invoke` 於權限不足/驗證失敗/成功/失敗四點記錄「誰、何時、對誰做了什麼（安全摘要）」，每租戶持久化，供 admin 唯讀查核。

**Architecture:** `ToolDef` 加 `audit`/`auditSummary`；新增每租戶稽核 store（比照 usage.store）；`invoke` 對 audit 工具記錄四種結果；admin 加 `GET /tenants/:id/audit` 與「稽核」分頁。設計見 [spec](../specs/2026-07-11-tool-audit-log-design.md)。

**Tech Stack:** TS/Express/Jest；前端 admin（Vite+React）。既有件：[tool.registry.ts](../../../server/src/modules/tools/tool.registry.ts)、[oa.tools.ts](../../../server/src/modules/tools/oa.tools.ts)、[email.tools.ts](../../../server/src/modules/tools/email.tools.ts)、[usage.store.ts](../../../server/src/modules/usage/usage.store.ts)（store 範本）、[admin.controller.ts](../../../server/src/modules/admin/admin.controller.ts)、[TenantDetailPage.tsx](../../../admin/src/pages/TenantDetailPage.tsx)。

## Global Constraints

- 語言：程式註解、UI 文案用繁體中文。
- 隱私：只記安全摘要（收件人+主旨、表單+單號），**不記完整信件內容/PII**。
- 稽核為旁路：記錄失敗（如寫檔錯）**絕不可影響 invoke 的正常行為/回傳**。
- 每租戶最近 N=500 筆上限，超過捨最舊。
- 稽核 store 每租戶 + 磁碟持久化，比照 usage.store 的 in-memory + `os.tmpdir()` JSON 模式。
- 測試以「新建租戶」隔離，勿依賴共用 default 的可變狀態。
- 收尾：`cd server && npx jest` 全綠、`npm run typecheck`、`npm run build` 通過。

---

### Task 1: ToolDef.audit/auditSummary 型別 + 稽核 store

**Files:**
- Modify: `server/src/modules/tools/tool.types.ts`（`ToolDef` 加 `audit?` / `auditSummary?`）
- Create: `server/src/modules/audit/audit.store.ts`
- Test: `server/tests/audit-store.test.ts`

**Interfaces:**
- Produces:
  - `ToolDef.audit?: boolean`、`ToolDef.auditSummary?(input: I, result?: O): string`
  - `interface AuditEntry { toolId: string; userId: string; at: string; ok: boolean; summary: string; error?: string }`
  - `auditStore.record(tenantId: string, entry: AuditEntry): void`（超過 500 捨最舊 + 持久化）
  - `auditStore.list(tenantId: string, limit?: number): AuditEntry[]`（新→舊）
  - `auditStore.clear(): void`（測試）

- [ ] **Step 1: 寫失敗測試**

`server/tests/audit-store.test.ts`:

```ts
/** 稽核 store：record/list（新→舊）/ 每租戶上限捨舊 / 租戶隔離。 */
import { auditStore, type AuditEntry } from '@/modules/audit/audit.store';

function entry(partial: Partial<AuditEntry> = {}): AuditEntry {
  return { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: true, summary: 's', ...partial };
}

describe('auditStore', () => {
  afterEach(() => auditStore.clear());

  it('record 後 list 回該租戶紀錄（新→舊）', () => {
    auditStore.record('t1', entry({ summary: 'a' }));
    auditStore.record('t1', entry({ summary: 'b' }));
    const list = auditStore.list('t1');
    expect(list.map((e) => e.summary)).toEqual(['b', 'a']); // 新在前
  });

  it('租戶隔離', () => {
    auditStore.record('t1', entry());
    expect(auditStore.list('t2')).toHaveLength(0);
  });

  it('超過每租戶上限（500）捨最舊', () => {
    for (let i = 0; i < 520; i++) auditStore.record('t3', entry({ summary: `#${i}` }));
    const list = auditStore.list('t3', 1000);
    expect(list).toHaveLength(500);
    expect(list[0].summary).toBe('#519'); // 最新
    expect(list.some((e) => e.summary === '#0')).toBe(false); // 最舊已捨
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`tool.types.ts` 的 `ToolDef` 內（`handler` 之前）加：

```ts
  /** 是否寫入稽核軌跡（僅有副作用的動作應開，如 email.send / oa.submitForm）。 */
  readonly audit?: boolean;
  /** 稽核安全摘要（不含 PII）；invoke 記錄時呼叫。失敗會被 best-effort 吞掉。 */
  auditSummary?(input: I, result?: O): string;
```

`server/src/modules/audit/audit.store.ts`（比照 usage.store）：

```ts
/**
 * 工具稽核紀錄（每租戶）：in-memory + 磁碟持久化，每租戶保留最近 N 筆。
 * 只由 toolRegistry.invoke 對 audit 工具寫入；旁路性質——記錄失敗不得影響主流程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';

export interface AuditEntry {
  toolId: string;
  userId: string;
  at: string;
  ok: boolean;
  summary: string;
  error?: string;
}

const MAX_PER_TENANT = 500;
const STORE_FILE = path.join(os.tmpdir(), 'oa-agent-audit.json');
const logs = new Map<string, AuditEntry[]>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...logs.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist audit log');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, AuditEntry[]][];
    for (const [k, v] of raw) logs.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore audit log; starting empty');
}

export const auditStore = {
  record(tenantId: string, entry: AuditEntry): void {
    const arr = logs.get(tenantId) ?? [];
    arr.push(entry);
    if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT); // 捨最舊
    logs.set(tenantId, arr);
    persist();
  },
  /** 回最近 limit 筆（新→舊）。 */
  list(tenantId: string, limit = 100): AuditEntry[] {
    const arr = logs.get(tenantId) ?? [];
    return [...arr].reverse().slice(0, limit);
  },
  clear(): void {
    logs.clear();
    persist();
  },
};
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/audit-store.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tools/tool.types.ts server/src/modules/audit/audit.store.ts server/tests/audit-store.test.ts
git commit -m "feat(audit): ToolDef.audit/auditSummary 型別 + 每租戶稽核 store"
```

---

### Task 2: invoke 記錄稽核（4 點）+ 標記 email.send / oa.submitForm

**Files:**
- Modify: `server/src/modules/tools/tool.registry.ts`（`invoke` 加稽核）
- Modify: `server/src/modules/tools/email.tools.ts`（`email.send` 加 audit + auditSummary）
- Modify: `server/src/modules/tools/oa.tools.ts`（`oa.submitForm` 加 audit + auditSummary）
- Test: `server/tests/audit-invoke.test.ts`

**Interfaces:**
- Consumes: `auditStore`（`@/modules/audit/audit.store`）。
- Produces: `invoke` 對 `tool.audit` 工具於 scope 不足(403)、驗證失敗(422)、handler 成功、handler 失敗各記一筆；`ctx` 提供 tenantId/userId。非 audit 工具行為不變。

- [ ] **Step 1: 寫失敗測試**

`server/tests/audit-invoke.test.ts`:

```ts
/** invoke 稽核：audit 工具四種結果各記一筆；非 audit 工具不記。 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { auditStore } from '@/modules/audit/audit.store';
import '@/modules/tools/oa.tools';
import '@/modules/tools/email.tools';

describe('invoke 稽核', () => {
  afterEach(() => auditStore.clear());

  it('audit 工具成功 → 記一筆 ok，含安全摘要', async () => {
    registerTool({
      id: 'test.audit.ok', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'],
      audit: true, auditSummary: () => '摘要OK', handler: async () => 'done',
    });
    const t = tenantStore.createTenant('audit-ok');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    await toolRegistry.invoke('test.audit.ok', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' }));
    const list = auditStore.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ toolId: 'test.audit.ok', userId: 'kevin', ok: true, summary: '摘要OK' });
  });

  it('audit 工具權限不足 → 記一筆 ok:false（權限不足）', async () => {
    registerTool({ id: 'test.audit.denied', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], audit: true, handler: async () => 'x' });
    const t = tenantStore.createTenant('audit-denied'); // 未授予 email:write
    await expect(
      toolRegistry.invoke('test.audit.denied', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' })),
    ).rejects.toMatchObject({ statusCode: 403 });
    const list = auditStore.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ok: false });
    expect(list[0].error).toContain('權限');
  });

  it('非 audit 工具不記', async () => {
    registerTool({ id: 'test.noaudit', description: 'x', inputSchema: { type: 'object' }, scopes: [], handler: async () => 'x' });
    const t = tenantStore.createTenant('audit-none');
    await toolRegistry.invoke('test.noaudit', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' }));
    expect(auditStore.list(t.id)).toHaveLength(0);
  });

  it('email.send / oa.submitForm 皆標記為 audit', () => {
    expect(toolRegistry.get('email.send').audit).toBe(true);
    expect(toolRegistry.get('oa.submitForm').audit).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`tool.registry.ts`：頂部加 `import { auditStore } from '@/modules/audit/audit.store';`。改寫 `invoke`：

```ts
  async invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const { tool, validate } = lookup(id);
    const audit = (ok: boolean, extra: { summary?: string; error?: string }): void => {
      if (!tool.audit) return;
      let summary = extra.summary;
      if (summary === undefined) {
        try {
          summary = tool.auditSummary ? tool.auditSummary(input as never) : tool.id;
        } catch {
          summary = tool.id;
        }
      }
      auditStore.record(ctx.tenantId, { toolId: id, userId: ctx.userId, at: new Date().toISOString(), ok, summary, error: extra.error });
    };

    if (!hasScopes(ctx.scopes, tool.scopes)) {
      audit(false, { error: '權限不足' });
      throw AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
    }
    if (!validate(input)) {
      audit(false, { error: '輸入驗證失敗' });
      throw AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
    }
    logger.debug({ toolId: id, tenantId: ctx.tenantId, userId: ctx.userId }, 'tool.invoke');
    try {
      const result = await tool.handler(input, ctx);
      let summary: string | undefined;
      try {
        summary = tool.auditSummary ? tool.auditSummary(input as never, result as never) : undefined;
      } catch {
        summary = undefined;
      }
      audit(true, { summary });
      return result;
    } catch (err) {
      audit(false, { error: (err as Error).message });
      throw err;
    }
  },
```

`email.tools.ts` 的 `email.send` 註冊加：

```ts
  audit: true,
  auditSummary: (input: EmailSendInput) => `收件人 ${input.to}｜主旨 ${input.subject}`,
```

`oa.tools.ts` 的 `oa.submitForm` 註冊加：

```ts
  audit: true,
  auditSummary: (input: OASubmitInput, result?: OASubmitResult) =>
    `表單 ${input.formId}｜單號 ${result?.oaRequestId ?? '—'}`,
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/audit-invoke.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tools/tool.registry.ts server/src/modules/tools/email.tools.ts server/src/modules/tools/oa.tools.ts server/tests/audit-invoke.test.ts
git commit -m "feat(audit): invoke 對 audit 工具記錄四種結果；標記 email.send/oa.submitForm"
```

---

### Task 3: admin 後端 GET /tenants/:id/audit

**Files:**
- Modify: `server/src/modules/admin/admin.controller.ts`（加 `getAudit`）
- Modify: `server/src/modules/admin/admin.routes.ts`（加路由）
- Test: `server/tests/admin-audit.test.ts`

**Interfaces:**
- Produces: `GET /api/admin/tenants/:id/audit` → `{ data: AuditEntry[] }`（最近 N，新→舊）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/admin-audit.test.ts`:

```ts
import { adminController } from '@/modules/admin/admin.controller';
import { auditStore } from '@/modules/audit/audit.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

function mockRes() {
  const res = { statusCode: 0, body: null as unknown, status(n: number) { res.statusCode = n; return res; }, json(b: unknown) { res.body = b; } };
  return res;
}

describe('admin 稽核 API', () => {
  afterEach(() => auditStore.clear());

  it('getAudit 回該租戶稽核（新→舊）', async () => {
    const t = tenantStore.createTenant('admin-audit');
    auditStore.record(t.id, { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: true, summary: 'a' });
    auditStore.record(t.id, { toolId: 'email.send', userId: 'kevin', at: new Date().toISOString(), ok: false, summary: 'b', error: '權限不足' });
    const res = mockRes();
    await adminController.getAudit({ params: { id: t.id } } as never, res as never);
    const data = (res.body as { data: { summary: string; ok: boolean }[] }).data;
    expect(data.map((e) => e.summary)).toEqual(['b', 'a']);
    expect(data[0].ok).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`admin.controller.ts`：頂部 import `import { auditStore } from '@/modules/audit/audit.store';`。於物件內（`getUsage` 附近）加：

```ts
  async getAudit(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: auditStore.list(tenant.id, 200) });
  },
```

`admin.routes.ts`：於 usage 路由附近加：

```ts
router.get(
  '/tenants/:id/audit',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getAudit),
);
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/admin-audit.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/admin/admin.controller.ts server/src/modules/admin/admin.routes.ts server/tests/admin-audit.test.ts
git commit -m "feat(admin): GET /tenants/:id/audit 稽核查詢端點"
```

---

### Task 4: admin「稽核」分頁

**Files:**
- Modify: `admin/src/api.ts`（`AuditEntry` 型別 + `getTenantAudit`）
- Create: `admin/src/pages/tabs/AuditTab.tsx`
- Modify: `admin/src/pages/TenantDetailPage.tsx`（加 `audit` 分頁）

**Interfaces:**
- Consumes: Task 3 的 `GET /admin/tenants/:id/audit`。

- [ ] **Step 1: api.ts**

加型別與 client 方法：

```ts
export interface AuditEntry {
  toolId: string;
  userId: string;
  at: string;
  ok: boolean;
  summary: string;
  error?: string;
}
```
`api` 物件內加：
```ts
  getTenantAudit: (id: string) => req<AuditEntry[]>('GET', `/admin/tenants/${id}/audit`),
```

- [ ] **Step 2: AuditTab.tsx**

`admin/src/pages/tabs/AuditTab.tsx`（唯讀列表，沿用 card + 表格 inline style 慣例）：

```tsx
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type AuditEntry } from '../../api';

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

export default function AuditTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.getTenantAudit(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rows) return <div className="card"><div className="card-body">載入中…</div></div>;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">稽核紀錄</div>
          <div className="card-desc">有副作用的動作（寄信、送單）的軌跡：誰、何時、做了什麼、成功與否。只顯示安全摘要，不含信件內容。</div>
        </div>
      </div>
      <div className="card-body" style={{ overflowX: 'auto' }}>
        {rows.length === 0 ? (
          <div className="row-sub">尚無稽核紀錄。</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={th}>時間</th>
                <th style={th}>工具</th>
                <th style={th}>使用者</th>
                <th style={th}>摘要</th>
                <th style={th}>狀態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td style={td}>{new Date(e.at).toLocaleString()}</td>
                  <td style={td}>{e.toolId}</td>
                  <td style={td}>{e.userId}</td>
                  <td style={td}>{e.summary}</td>
                  <td style={td}>{e.ok ? '✅ 成功' : `⛔ ${e.error ?? '失敗'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 接進 TenantDetailPage**

`TenantDetailPage.tsx`：import `AuditTab`；`TabKey` 加 `'audit'`；`TABS` 加（放在 `usage` 之後）`{ key: 'audit', label: '稽核' }`；render 加 `{tab === 'audit' && <AuditTab tenantId={tenant.id} onError={handleErr} />}`。

- [ ] **Step 4: 型別 + build + 手動驗證 + commit**

Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck` → 無誤；`npm run build` → 成功

手動：`npm run dev:server` + `npm run dev:admin` → 進租戶「稽核」分頁 → 觸發一次寄信/送單後，列表出現該筆（時間/工具/使用者/摘要/狀態）。

```bash
git add admin/src/api.ts admin/src/pages/tabs/AuditTab.tsx admin/src/pages/TenantDetailPage.tsx
git commit -m "feat(admin): 稽核分頁（有副作用動作的唯讀軌跡）"
```

---

## 完成後狀態（驗收）
- email.send / oa.submitForm 的每次呼叫（成功/失敗/被擋）皆留稽核；每租戶最近 500 筆、持久化。
- admin「稽核」分頁可查：時間 / 工具 / 使用者 / 安全摘要 / 狀態。
- 稽核為旁路：記錄失敗不影響 invoke；讀取類工具不記；不記 PII。
- 全套測試綠、typecheck/build 綠。

## Self-Review 註記
- **Spec 覆蓋**：D1 側重副作用（audit 旗標僅標 email.send/oa.submitForm）、D2 記被擋嘗試（invoke 於 403/422 也記）、D3 隱私（auditSummary 只安全欄位）、D4 admin 分頁 + API。
- **型別一致**：`ToolDef.audit/auditSummary`、`AuditEntry`、`auditStore.*`、`getTenantAudit` 前後端一致。
- **旁路安全**：auditSummary best-effort try/catch；record 失敗僅 logger.warn（persist 內已 try/catch），不拋。
- **測試隔離**：全用新建租戶，避免共用 default 污染。
- **無 placeholder**：四任務含完整程式碼與確切插入位置。
