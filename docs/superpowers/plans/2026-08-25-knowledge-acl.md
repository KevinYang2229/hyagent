# 知識庫角色型存取權限（ACL）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓知識庫檢索依使用者角色決定可見範圍——檔案層標籤、身分下推到 pgvector 的 where 條件、未標記預設不可見。

**Architecture:** 檔案／來源標上 `kb:<labelId>` 可見性標籤，標籤即 scope，沿用既有 `resolveScopes`（部門／帳號／套餐）指派。標籤自檔案 meta（真相來源）投影到 `knowledge_chunks.visibility_scopes`，檢索時以 `&&` 陣列相交在 SQL 端 **pre-filter**，與向量排序同時完成。以每租戶三態旗標 `off / shadow / on` 分階段上線。

**Tech Stack:** TypeScript / Express / Prisma（`$queryRaw`）/ PostgreSQL + pgvector（`halfvec(3072)`）/ Jest / zod / React（admin）

**Spec:** [`docs/superpowers/specs/2026-08-25-knowledge-acl-design.md`](../specs/2026-08-25-knowledge-acl-design.md)

## Global Constraints

- **標籤 id 格式**：`labelId` 限 `^[a-z0-9-]+$`（不含冒號）。scope id 為 `kb:<labelId>`。
- **租戶層禁令**：`Tenant.grantedScopes` 一律拒絕 `kb:` 前綴，**無白名單例外**。
- **fail-closed**：未標記內容不可見。空 scopes → 零結果，不拋錯。
- **`NULL` vs `[]`**：`NULL` ＝ 從未標記（待辦）；`[]` ＝ 明確標成誰都不能看（已決定）。查詢效果相同，報表須分辨。
- **`POOL_SIZE` ＝ 20**（`retriever.scoring.ts`）。驗證候選池行為的測試資料**必須超過 20 筆**，否則錯誤實作也會通過。
- **不記問句全文**（可能含個資）。shadow 只記 `file_id` 與少量 `sample_user_ids`。
- **server 只用 `import type` 引用 `@hyagent/shared`**（部署映像不帶 shared 的 TS 原始碼，執行期載入會爆）。
- **正式環境 `DATA_BACKEND=db`**。`file` 後端為 dev/測試路徑，行為須一致。
- **測試指令**：`npm test -w server`；單檔 `npx jest server/tests/<file> --config server/jest.config.*`（依專案既有設定，於 repo 根目錄執行 `npm test -w server -- <pattern>`）。

---

## File Structure

**新增**

| 檔 | 責任 |
|---|---|
| `server/src/modules/knowledge/knowledge.visibility.ts` | 標籤與可見性的單一入口：`kbScopeId` / `visibilityScopesOf(principal)` / `setFileVisibility`（雙表原子更新） |
| `server/src/modules/knowledge/knowledge.acl-shadow.repo.ts` | shadow 計數表讀寫 |
| `server/prisma/migrations/0007_knowledge_acl/migration.sql` | 兩張表加欄位 + shadow 計數表 |

**修改**

| 檔 | 變更 |
|---|---|
| `server/src/modules/tenant/tenant.types.ts` | `knowledgeLabels` / `knowledgeAcl` |
| `server/src/modules/authz/scope-catalog.ts` | `kb:` 展開、`labelId` 驗證、租戶層禁令 |
| `server/src/modules/user/user.directory.ts` | 提出 `UNKNOWN_DEPARTMENT` 常數 |
| `server/src/modules/knowledge/retriever.types.ts` | `RetrievalPrincipal`、`search` 簽名 |
| `server/src/modules/knowledge/retriever.pgvector.ts` | 兩路候選加可見性條件、三態旗標 |
| `server/src/modules/knowledge/retriever.staticIndex.ts`、`retriever.stub.ts` | 實作新介面 |
| `server/src/modules/knowledge/knowledge.index.repo.ts` | 兩處 insert / on conflict 加欄位 |
| `server/src/modules/knowledge/knowledge.tables.repo.ts` | `searchTableCatalog` 加過濾 |
| `server/src/modules/knowledge/knowledge.store.ts` | `KnowledgeFileMeta` / `KnowledgeSource` 加欄位 |
| `server/src/modules/knowledge/knowledge-index.types.ts` | `IndexedChunk.visibilityScopes` |
| `server/src/modules/knowledge/knowledge.agent-service.ts` | 傳 principal |
| `server/src/modules/report/report.compose.ts`、`report.job.ts` | 傳 `userId` |
| `server/src/modules/knowledge/knowledge.admin.controller.ts`、`knowledge.admin.schema.ts` | 標籤 CRUD、標註、`asUserId`、盤點 |
| `server/src/modules/admin/admin.routes.ts` | 掛新路由 |
| `server/src/modules/knowledge/batch-source.ts`、`folder-ingest.service.ts` | 資料夾標籤解析 |
| `server/src/modules/conversation/conversation.routes.ts` | 修正過期註解 |
| `admin/src/pages/tabs/*` | 標籤管理、檔案標註、未標記警示、盤點面板 |

**任務順序**：1→2 為純邏輯（無 DB），3 建欄位，4→6 為檢索與寫入，7→9 為管理面，10 為 UI。每個任務結束時 `npm test -w server` 全綠。

---

### Task 1: 標籤目錄與租戶層禁令

**Files:**
- Modify: `server/src/modules/tenant/tenant.types.ts`
- Modify: `server/src/modules/authz/scope-catalog.ts`
- Test: `server/tests/knowledge-acl-scope-catalog.test.ts`（新增）

**Interfaces:**
- Consumes: `tenantStore.getTenant/updateTenant`、`SCOPE_CATALOG`、`tenantGrantableScopes`、`assertGrantableScopes`（既有）
- Produces:
  - `Tenant.knowledgeLabels?: KnowledgeLabel[]`，`interface KnowledgeLabel { id: string; label: string }`
  - `Tenant.knowledgeAcl?: 'off' | 'shadow' | 'on'`
  - `KB_SCOPE_PREFIX = 'kb:'`
  - `kbScopeId(labelId: string): string`
  - `isKbScope(id: string): boolean`
  - `assertValidLabelId(labelId: string): void`
  - `assertTenantGrantable(ids: string[]): void`（租戶層專用，拒 `kb:`）

- [ ] **Step 1: 寫失敗測試**

建立 `server/tests/knowledge-acl-scope-catalog.test.ts`：

```ts
/**
 * kb:<labelId> 可見性標籤進入 scope 目錄的規則。
 * 租戶層禁令是安全邊界：grantedScopes 併給該租戶所有人（含訪客身分），
 * 把 kb:hr 放進去等於對公開 widget 開放人事文件。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import {
  assertTenantGrantable,
  assertValidLabelId,
  isKbScope,
  kbScopeId,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';

describe('kb 標籤 scope', () => {
  it('kbScopeId 加上 kb: 前綴，isKbScope 認得', () => {
    expect(kbScopeId('hr')).toBe('kb:hr');
    expect(isKbScope('kb:hr')).toBe(true);
    expect(isKbScope('service:knowledge')).toBe(false);
  });

  it('labelId 只允許小寫英數與連字號', () => {
    expect(() => assertValidLabelId('hr-policy')).not.toThrow();
    expect(() => assertValidLabelId('HR')).toThrow();
    expect(() => assertValidLabelId('hr:salary')).toThrow();
    expect(() => assertValidLabelId('')).toThrow();
  });

  it('租戶的 knowledgeLabels 展開成可授予 scope', () => {
    const t = tenantStore.createTenant('acl-catalog-test');
    tenantStore.updateTenant(t.id, {
      knowledgeLabels: [{ id: 'hr', label: '人資文件' }],
    });
    const ids = tenantGrantableScopes(t.id).map((s) => s.id);
    expect(ids).toContain('kb:hr');
  });

  it('租戶層授予 kb: 前綴一律拒絕（無白名單例外）', () => {
    expect(() => assertTenantGrantable(['service:knowledge'])).not.toThrow();
    expect(() => assertTenantGrantable(['kb:hr'])).toThrow(/租戶層/);
    expect(() => assertTenantGrantable(['kb:public'])).toThrow(/租戶層/);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-scope-catalog`
Expected: FAIL — `kbScopeId` 等匯出不存在（TS 編譯錯）

- [ ] **Step 3: 加型別**

`server/src/modules/tenant/tenant.types.ts` 於 `grantedScopes` 之後插入：

```ts
  /** 知識庫可見性標籤目錄（租戶自訂分類）。id 進 scope 體系時前綴 kb:。 */
  knowledgeLabels?: KnowledgeLabel[];
  /**
   * 知識庫 ACL 階段旗標：
   * off（預設）＝不過濾，行為與導入前完全相同；
   * shadow＝不過濾但記錄「若啟用會擋掉什麼」；on＝強制過濾。
   * 全租戶切至 on 後應移除三態邏輯，只留無條件過濾（見設計文件 §4）。
   */
  knowledgeAcl?: 'off' | 'shadow' | 'on';
```

同檔案加上（置於 `Tenant` 介面之前）：

```ts
/** 知識庫可見性標籤（租戶自訂分類） */
export interface KnowledgeLabel {
  /** 小寫英數與連字號；scope id 為 kb:<id> */
  id: string;
  /** 顯示名稱，如「人資文件」 */
  label: string;
}
```

- [ ] **Step 4: 實作 scope-catalog**

`server/src/modules/authz/scope-catalog.ts` 加入 import 與下列內容：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';

/** 知識庫可見性標籤的 scope 前綴 */
export const KB_SCOPE_PREFIX = 'kb:';

/** labelId → scope id */
export function kbScopeId(labelId: string): string {
  return `${KB_SCOPE_PREFIX}${labelId}`;
}

export function isKbScope(id: string): boolean {
  return id.startsWith(KB_SCOPE_PREFIX);
}

/**
 * labelId 限 [a-z0-9-]+。scope id 以冒號分段，label 內含冒號會讓 kb: 前綴的比對
 * 出現歧義——而該比對正是 assertTenantGrantable 這道安全檢查所依賴的。
 */
const LABEL_ID_RE = /^[a-z0-9-]+$/;

export function assertValidLabelId(labelId: string): void {
  if (!LABEL_ID_RE.test(labelId)) {
    throw AppError.badRequest(`標籤 id 只允許小寫英數與連字號：${labelId}`);
  }
}

/**
 * 租戶層（Tenant.grantedScopes）授予驗證。
 *
 * resolveScopes 會把 grantedScopes 併給該租戶**所有人，包含訪客身分**。
 * 該欄位語意是「這租戶買了哪些能力」，誤操作門檻很低——把 kb:hr 放進去，
 * 等於對公開 widget 開放人事文件。訪客的可見範圍改走部門指派（見 resolve-scopes），
 * 故此處無需任何白名單例外。
 */
export function assertTenantGrantable(ids: string[]): void {
  const kb = ids.filter(isKbScope);
  if (kb.length > 0) {
    throw AppError.badRequest(
      `租戶層不可授予知識庫標籤（會併給所有人含訪客）：${kb.join('、')}。請改於部門或帳號層指派。`,
    );
  }
  assertGrantableScopes(ids);
}
```

`tenantGrantableScopes` 內，於 `forms` 之後加入 labels 並併入回傳：

```ts
  const labels: ScopeDef[] = (tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => ({
    id: kbScopeId(l.id),
    label: l.label,
    description: `檢索「${l.label}」分類的知識庫內容`,
    base: false,
  }));
  return [...GRANTABLE_SCOPES, ...forms, ...labels];
```

`assertGrantableScopes` 的 `ok()` 加上 `kb:` 放行（部門／帳號層會用到）：

```ts
  const validLabelIds = tenantId
    ? new Set((tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => kbScopeId(l.id)))
    : new Set<string>();
  const ok = (id: string): boolean =>
    GRANTABLE_SCOPE_IDS.has(id) || validFormIds.has(id) || validLabelIds.has(id);
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npm test -w server -- knowledge-acl-scope-catalog`
Expected: PASS（4 個案例）

- [ ] **Step 6: 接上租戶授權路徑**

找出目前呼叫 `assertGrantableScopes` 來驗證 `grantedScopes` 的 admin controller（`grep -rn "assertGrantableScopes" server/src/modules/admin server/src/modules/tenant`），把**租戶層**那一處改呼叫 `assertTenantGrantable`。部門／帳號層維持 `assertGrantableScopes`。

- [ ] **Step 7: 全套測試 + 型別**

Run: `npm test -w server && npm run typecheck -w server`
Expected: 全綠

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/tenant/tenant.types.ts server/src/modules/authz/scope-catalog.ts server/tests/knowledge-acl-scope-catalog.test.ts server/src/modules/admin server/src/modules/tenant
git commit -m "feat(authz): kb 可見性標籤進 scope 目錄，租戶層禁授 kb: 前綴"
```

---

### Task 2: 訪客部門常數

**Files:**
- Modify: `server/src/modules/user/user.directory.ts`
- Test: `server/tests/knowledge-acl-guest-department.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `kbScopeId`
- Produces: `UNKNOWN_DEPARTMENT: string`（值為 `'—'`，即 `getApplicant` 現有的 fallback）

**背景**：公開 widget 的訪客 token 由宿主經 `/auth/sso/exchange` 簽發，`sub` 不在使用者目錄中，`getApplicant` 回 `department: '—'`。`scopePolicy.groups` 以部門字串為 key，因此把 `kb:public` 指派給該部門即涵蓋所有訪客。員工尚未建檔時同樣落在此桶——最小權限，方向正確。

- [ ] **Step 1: 寫失敗測試**

```ts
/**
 * 訪客（宿主 SSO 簽發、不在使用者目錄中的 sub）的權限掛鉤點是「未建檔部門」，
 * 不是租戶層 grantedScopes——後者會併給所有人，見 scope-catalog.assertTenantGrantable。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { getApplicant, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';

afterEach(() => scopePolicy.clear());

describe('訪客部門', () => {
  it('未知 sub 落在 UNKNOWN_DEPARTMENT', () => {
    expect(getApplicant('guest-abc-123').department).toBe(UNKNOWN_DEPARTMENT);
  });

  it('指派給 UNKNOWN_DEPARTMENT 的 kb 標籤，訪客拿得到', () => {
    const t = tenantStore.createTenant('acl-guest-test');
    tenantStore.updateTenant(t.id, {
      knowledgeLabels: [
        { id: 'public', label: '公開' },
        { id: 'hr', label: '人資' },
      ],
    });
    const policy = scopePolicy.getPolicy(t.id);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(t.id, policy);

    const scopes = resolveScopes({ tenantId: t.id, userId: 'guest-abc-123' });
    expect(scopes).toContain('kb:public');
    expect(scopes).not.toContain('kb:hr');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-guest-department`
Expected: FAIL — `UNKNOWN_DEPARTMENT` 未匯出

- [ ] **Step 3: 實作**

`server/src/modules/user/user.directory.ts`：

```ts
/**
 * 未建檔帳號的部門。宿主經 SSO 簽發的訪客 sub 不在本目錄中，一律落在此桶；
 * 員工尚未建檔時同樣如此——最小權限，方向正確。
 * scopePolicy.groups 以部門字串為 key，故此值即公開 widget 的權限掛鉤點。
 */
export const UNKNOWN_DEPARTMENT = '—';
```

並把 `getApplicant` 的 fallback 改用該常數：

```ts
    : { id: userId, name: userId, department: UNKNOWN_DEPARTMENT };
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test -w server -- knowledge-acl-guest-department`
Expected: PASS（2 個案例）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/user/user.directory.ts server/tests/knowledge-acl-guest-department.test.ts
git commit -m "feat(authz): 提出 UNKNOWN_DEPARTMENT 常數作為訪客權限掛鉤點"
```

---

### Task 3: DB 欄位與寫入投影

**Files:**
- Create: `server/prisma/migrations/0007_knowledge_acl/migration.sql`
- Modify: `server/src/modules/knowledge/knowledge-index.types.ts`
- Modify: `server/src/modules/knowledge/knowledge.store.ts`
- Modify: `server/src/modules/knowledge/knowledge.index.repo.ts`
- Test: `server/tests/knowledge-acl-index-repo.test.ts`（新增）

**Interfaces:**
- Produces:
  - `IndexedChunk.visibilityScopes?: string[]`
  - `KnowledgeFileMeta.visibilityScopes?: string[]`
  - `KnowledgeSource.visibilityScopes?: string[]`
  - `knowledge_chunks.visibility_scopes text[]`、`knowledge_tables.visibility_scopes text[]`

**關鍵**：`knowledge_chunks` **從不就地更新**，只有 `saveIndexToDb`（刪光整租戶再塞回）與 `replaceWebsiteChunksInDb`（刪 `file_id is null` 再塞回）兩種寫法。標籤若只活在 chunk 上，下一次重爬即整批清空，配合 fail-closed 會造成知識庫無預警失聲。真相來源必須在檔案 meta／來源設定，chunk 上僅為投影。

- [ ] **Step 1: 寫 migration**

`server/prisma/migrations/0007_knowledge_acl/migration.sql`：

```sql
-- 知識庫可見性標籤的查詢投影欄位。
-- 刻意不設 default：NULL＝從未標記（遷移待辦），[]＝明確標成誰都不能看（已決定）。
-- 兩者查詢效果相同（&& 對 NULL 得 NULL、對 [] 得 false），但盤點報表須分辨。
alter table knowledge_chunks add column if not exists visibility_scopes text[];
alter table knowledge_tables add column if not exists visibility_scopes text[];

-- shadow 階段的統計：以 (租戶, 檔案) 累加，資料量等於檔案數而非查詢數。
-- 全租戶切至 on 後，本表與三態旗標一起退場。
create table if not exists knowledge_acl_shadow (
  tenant_id       text        not null,
  file_id         text        not null,
  blocked_count   bigint      not null default 0,
  sample_user_ids text[],
  last_blocked_at timestamptz not null default now(),
  primary key (tenant_id, file_id)
);
```

> GIN index 暫不建立：現況為精確掃描（見 `retriever.pgvector.ts` 檔頭關於 0006 移除 HNSW 的說明），多一個陣列相交判斷成本可忽略。資料量長起來再加。

- [ ] **Step 2: 寫失敗測試**

`server/tests/knowledge-acl-index-repo.test.ts`：

```ts
/**
 * 標籤投影：寫入 chunks 時 visibility_scopes 必須一起進去，
 * 且 upsert 的 do update set 必須含該欄——漏了的症狀是
 * 「改了權限但沒生效，重啟也沒用」（upsert 默默保留舊值）。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import { saveIndex } from '@/modules/knowledge/knowledge.index.repo';

/** 把某次 $executeRaw 的 template strings 併回可搜尋的字串 */
function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] } | readonly string[];
  const raw = (parts as { raw?: readonly string[] }).raw ?? (parts as readonly string[]);
  return Array.from(raw).join('?');
}

describe('chunks 寫入含可見性投影', () => {
  beforeEach(() => executeRaw.mockClear());

  it('insert 欄位清單與 on conflict 都含 visibility_scopes', async () => {
    await saveIndex('t1', {
      generatedAt: new Date().toISOString(),
      model: 'test',
      source: 'https://example.com',
      chunks: [
        { id: 'c1', url: 'u1', title: 't', text: 'x', vector: [1, 0, 0], visibilityScopes: ['kb:hr'] },
      ],
    });

    const inserts = executeRaw.mock.calls
      .map(sqlTextOf)
      .filter((s) => s.includes('insert into knowledge_chunks'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain('visibility_scopes');
      expect(sql).toMatch(/do update set[\s\S]*visibility_scopes\s*=\s*excluded\.visibility_scopes/);
    }
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-index-repo`
Expected: FAIL — SQL 不含 `visibility_scopes`

- [ ] **Step 4: 加型別**

`knowledge-index.types.ts` 的 `IndexedChunk` 加：

```ts
  /**
   * 可見性標籤（kb:<labelId>）。真相來源在檔案 meta／來源設定，本欄為查詢投影。
   * undefined 寫入為 NULL＝從未標記；[] ＝明確標成誰都不能看。
   */
  visibilityScopes?: string[];
```

`knowledge.store.ts` 的 `KnowledgeFileMeta` 加：

```ts
  /** 可見性標籤（kb:<labelId>）真相來源；未設＝未標記，fail-closed 下不可見 */
  visibilityScopes?: string[];
```

`KnowledgeSource` 加：

```ts
  /** 網站來源的可見性標籤（整個來源一組）；重爬時重新投影到 chunks */
  visibilityScopes?: string[];
```

- [ ] **Step 5: 改寫入 SQL**

`knowledge.index.repo.ts` 中**所有** `insert into knowledge_chunks`（共三處：`saveIndexToDb`、`replaceWebsiteChunksInDb`、`appendChunks`）統一改為：

```ts
        const values = batch.map(
          (c) => Prisma.sql`(${tenantId}, ${c.id}, ${c.url}, ${c.title}, ${c.text}, ${c.fileId ?? null},
                            ${c.visibilityScopes ?? null}, ${toVectorLiteral(c.vector)}::halfvec(3072))`,
        );
        await tx.$executeRaw`
          insert into knowledge_chunks (tenant_id, id, url, title, text, file_id, visibility_scopes, embedding)
          values ${Prisma.join(values)}
          on conflict (tenant_id, id) do update set
            url = excluded.url, title = excluded.title, text = excluded.text,
            file_id = excluded.file_id, visibility_scopes = excluded.visibility_scopes,
            embedding = excluded.embedding
        `;
```

（`appendChunks` 若使用 `db.$executeRaw` 而非 `tx.$executeRaw`，保留其原本的 executor，只改 SQL 與 values。）

- [ ] **Step 6: 執行測試確認通過**

Run: `npm test -w server -- knowledge-acl-index-repo`
Expected: PASS

- [ ] **Step 7: 套用 migration 並跑全套**

```bash
npm run db:generate -w server
npm test -w server && npm run typecheck -w server
```
Expected: 全綠（既有 `knowledge-index-repo-db.test.ts` 亦須通過）

- [ ] **Step 8: Commit**

```bash
git add server/prisma/migrations/0007_knowledge_acl server/src/modules/knowledge/knowledge-index.types.ts server/src/modules/knowledge/knowledge.store.ts server/src/modules/knowledge/knowledge.index.repo.ts server/tests/knowledge-acl-index-repo.test.ts
git commit -m "feat(knowledge): 加入 visibility_scopes 投影欄位與 shadow 統計表"
```

---

### Task 3B: 標籤在寫入來回中存活

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.index.repo.ts`（`loadIndexFromDb` / `loadIndexTextFromDb`）
- Modify: `server/src/modules/knowledge/ingest.service.ts`
- Test: `server/tests/knowledge-acl-survives-rewrite.test.ts`（新增）

**Interfaces:**
- Consumes: Task 3 的 `IndexedChunk.visibilityScopes`、`KnowledgeSource.visibilityScopes`
- Produces: 無新匯出；修補既有讀寫路徑

**這是整個計畫中最重要的一條測試。** 設計文件 §1 指出 `knowledge_chunks` 從不就地更新，
但實際的清空路徑比重爬更近：

`loadIndexFromDb` 目前的 select 是 `id, url, title, text, file_id, embedding`——**不含
`visibility_scopes`**。而 `ingestFile` 與 `removeFile` 都走 `loadIndex → saveIndex`
（刪光整租戶再塞回）。也就是說，若不修補此處，**每上傳一個新檔就會把該租戶所有既有檔案的
標籤清空**，配合 fail-closed 即為知識庫整個失聲，且日誌完全正常。

網站 chunk 則是每次爬取新產生的物件，須於產生時自 `KnowledgeSource.visibilityScopes` 蓋章。

- [ ] **Step 1: 寫失敗測試**

`server/tests/knowledge-acl-survives-rewrite.test.ts`：

```ts
/**
 * 標籤必須在「載入 → 寫回」的來回中存活。
 *
 * ingestFile / removeFile 都走 loadIndex → saveIndex（刪光整租戶再塞回）。
 * loadIndex 若沒把 visibility_scopes 撈回來，寫回時就是 NULL——
 * 每上傳一個新檔就清空所有既有標籤，fail-closed 下等於知識庫無預警失聲。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
jest.mock('@/config/env', () => ({
  __esModule: true,
  env: { DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false, KNOWLEDGE_INDEX_DIR: '.' },
}));

import { loadIndex } from '@/modules/knowledge/knowledge.index.repo';

describe('標籤在讀寫來回中存活', () => {
  it('loadIndex 撈回 visibility_scopes', async () => {
    queryRaw.mockReset();
    queryRaw
      .mockResolvedValueOnce([{ generated_at: new Date(), model: 'test', source: 'https://x.com' }])
      .mockResolvedValueOnce([
        {
          id: 'c1', url: 'u1', title: 't1', text: 'x1', file_id: 'f1',
          visibility_scopes: ['kb:hr'], embedding: '[1,0,0]',
        },
      ]);

    const idx = await loadIndex('t1');
    expect(idx?.chunks[0]?.visibilityScopes).toEqual(['kb:hr']);
  });

  it('loadIndex 的 select 清單含 visibility_scopes', async () => {
    queryRaw.mockReset();
    queryRaw
      .mockResolvedValueOnce([{ generated_at: new Date(), model: 'test', source: 's' }])
      .mockResolvedValueOnce([]);
    await loadIndex('t1');

    const chunkQuery = queryRaw.mock.calls[1] as unknown[];
    const raw = (chunkQuery[0] as unknown as { raw: readonly string[] }).raw;
    expect(Array.from(raw).join('?')).toContain('visibility_scopes');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-survives-rewrite`
Expected: FAIL — `visibilityScopes` 為 `undefined`；select 不含該欄

- [ ] **Step 3: 修 loadIndexFromDb**

`ChunkRow` 型別加 `visibility_scopes: string[] | null`，select 與映射同步：

```ts
  const rows = await db.$queryRaw<ChunkRow[]>`
    select id, url, title, text, file_id, visibility_scopes, embedding::text as embedding
    from knowledge_chunks where tenant_id = ${tenantId}
  `;
  const chunks: IndexedChunk[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    text: r.text,
    vector: parseVectorLiteral(r.embedding),
    // file_id 為 null 代表網站來源；不設此欄以維持與 file 後端相同的物件形狀
    ...(r.file_id ? { fileId: r.file_id } : {}),
    // 標籤必須隨 chunk 來回，否則 loadIndex → saveIndex 的重寫會把它清成 NULL
    ...(r.visibility_scopes ? { visibilityScopes: r.visibility_scopes } : {}),
  }));
```

`loadIndexTextFromDb` 同樣加上 `visibility_scopes` 於 select 與映射
（`ChunkText` 由 `IndexedChunk` 去掉 `vector` 而來，欄位自動具備）。

- [ ] **Step 4: 網站 chunk 蓋章**

`ingest.service.ts` 產生網站 chunk 之處，自來源設定帶入標籤。於建立 `IndexedChunk` 的位置加上：

```ts
// 網站來源的標籤掛在來源設定上（整個網站一組）。重爬會刪掉 file_id is null 的列再塞回，
// 因此每次都必須重新蓋章——標籤的真相來源是 KnowledgeSource，不是上一輪的 chunk。
const sourceScopes = knowledgeStore.getSource(tenantId).visibilityScopes;
```

並於各 chunk 物件展開 `...(sourceScopes ? { visibilityScopes: sourceScopes } : {})`。

- [ ] **Step 5: 執行測試確認通過 + 全套**

Run: `npm test -w server -- knowledge-acl-survives-rewrite && npm test -w server && npm run typecheck -w server`
Expected: 全綠

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/knowledge.index.repo.ts server/src/modules/knowledge/ingest.service.ts server/tests/knowledge-acl-survives-rewrite.test.ts
git commit -m "fix(knowledge): 標籤隨 chunk 在載入與重寫來回中存活，網站來源每次重新蓋章"
```

---

### Task 4: 檢索介面與 pgvector 過濾

**Files:**
- Create: `server/src/modules/knowledge/knowledge.visibility.ts`
- Modify: `server/src/modules/knowledge/retriever.types.ts`
- Modify: `server/src/modules/knowledge/retriever.pgvector.ts`
- Test: `server/tests/knowledge-acl-retrieval.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `isKbScope`；`resolveScopes`；`tenantStore`
- Produces:
  - `interface RetrievalPrincipal { tenantId: string; userId: string }`
  - `KnowledgeRetriever.search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]>`
  - `visibilityScopesOf(principal: RetrievalPrincipal): string[]`
  - `aclModeOf(tenantId: string): 'off' | 'shadow' | 'on'`

**設計要點**：`RetrievalPrincipal` **刻意不含 `scopes`**。權限由 retriever 內部呼叫 `resolveScopes` 算出，呼叫端無從捏造。兩路候選（dense 與 lexical）都必須加條件——漏掉 lexical 那路的失效特別惡毒：平常都對，只有在問句字面命中無權文件時才漏，而那正是最敏感的查詢。

- [ ] **Step 1: 寫失敗測試**

`server/tests/knowledge-acl-retrieval.test.ts`：

```ts
/**
 * 可見性過濾必須是 pre-filter：條件與 tenant_id 並排進 SQL，跟向量排序同時完成。
 * post-filter（撈回 Node 再濾）在 POOL_SIZE=20 之下必然失敗——權限窄的使用者
 * 候選池會被無權 chunk 佔滿，濾完剩零筆，且測試資料少時完全重現不出來。
 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: 10 }),
  }),
}));

const queryRaw = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $queryRaw: queryRaw }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import {
  invalidatePgvectorModelCache,
  pgvectorRetriever,
} from '@/modules/knowledge/retriever.pgvector';
import { POOL_SIZE } from '@/modules/knowledge/retriever.scoring';

function mockQueries(candidates: Record<string, unknown>[]): void {
  queryRaw.mockReset();
  queryRaw.mockResolvedValueOnce([{ model: 'test' }]).mockResolvedValueOnce(candidates);
}

/** 把最後一次 $queryRaw 的 template 與嵌入片段全部併成可搜尋字串 */
function lastSqlText(): string {
  const call = queryRaw.mock.calls[queryRaw.mock.calls.length - 1] as unknown[];
  const parts = call[0] as unknown as { raw: readonly string[] };
  const own = Array.from(parts.raw).join('?');
  const nested = call
    .slice(1)
    .filter((a): a is { sql: string } => typeof a === 'object' && a !== null && typeof (a as { sql?: unknown }).sql === 'string')
    .map((a) => a.sql)
    .join(' ');
  return `${own} ${nested}`;
}

function makeTenant(name: string, acl: 'off' | 'shadow' | 'on'): string {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, {
    knowledgeAcl: acl,
    knowledgeLabels: [{ id: 'hr', label: '人資' }, { id: 'public', label: '公開' }],
  });
  return t.id;
}

describe('pgvector 可見性過濾', () => {
  afterEach(() => {
    scopePolicy.clear();
    queryRaw.mock.calls.forEach(() => undefined);
  });

  it('acl=on：dense 與 lexical 兩路都帶可見性條件', async () => {
    const tid = makeTenant('acl-retr-1', 'on');
    invalidatePgvectorModelCache(tid);
    const policy = scopePolicy.getPolicy(tid);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(tid, policy);

    mockQueries([]);
    // 含 ASCII token 才會走 lexical 分支
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-1' }, 'HyCMS 是什麼');

    const sql = lastSqlText();
    const occurrences = sql.split('visibility_scopes').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2); // dense + lexical
    invalidatePgvectorModelCache(tid);
  });

  it('acl=off：完全不加可見性條件（遷移期行為零改變）', async () => {
    const tid = makeTenant('acl-retr-2', 'off');
    invalidatePgvectorModelCache(tid);
    mockQueries([]);
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-2' }, 'HyCMS 是什麼');
    expect(lastSqlText()).not.toContain('visibility_scopes');
    invalidatePgvectorModelCache(tid);
  });

  it('acl=on 且使用者無任何 kb 標籤：回零筆且不拋錯', async () => {
    const tid = makeTenant('acl-retr-3', 'on');
    invalidatePgvectorModelCache(tid);
    mockQueries([]); // SQL 端已濾掉全部
    const out = await pgvectorRetriever.search({ tenantId: tid, userId: 'nobody' }, 'HyCMS');
    expect(out).toEqual([]);
    invalidatePgvectorModelCache(tid);
  });

  it('候選池不被無權文件佔滿：SQL 端先濾再取 top-k', async () => {
    const tid = makeTenant('acl-retr-4', 'on');
    invalidatePgvectorModelCache(tid);
    const policy = scopePolicy.getPolicy(tid);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(tid, policy);

    // 模擬 DB 已完成 pre-filter：只回有權的 3 筆。
    // 若實作改成 post-filter，DB 會回 30 筆無權 + 3 筆有權而濾剩 0 筆——
    // 本測試以「有權的 3 筆全數回傳」守住 pre-filter 語意。
    const rows = [
      { id: 'P1', url: 'u1', title: '公開公告一', text: '公開內容一', cosine: 0.92 },
      { id: 'P2', url: 'u2', title: '公開公告二', text: '公開內容二', cosine: 0.9 },
      { id: 'P3', url: 'u3', title: '公開公告三', text: '公開內容三', cosine: 0.88 },
    ];
    expect(POOL_SIZE).toBe(20); // 守住前提：測試資料規模須參照此值
    mockQueries(rows);

    const out = await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-4' }, '公開公告');
    expect(out.map((c) => c.id).sort()).toEqual(['P1', 'P2', 'P3']);
    invalidatePgvectorModelCache(tid);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-retrieval`
Expected: FAIL — `search` 仍收 `tenantId: string`（TS 編譯錯）

- [ ] **Step 3: 建 knowledge.visibility.ts**

```ts
/**
 * 知識庫可見性：把「這個人能看到哪些標籤」與「本租戶目前的 ACL 階段」收斂成單一入口。
 *
 * 檢索器不接受外部傳入的 scopes——權限計算只有一份且不接受外部輸入，
 * 才是 fail-closed 守得住的形狀。呼叫端只交出身分（RetrievalPrincipal）。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { isKbScope } from '@/modules/authz/scope-catalog';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { RetrievalPrincipal } from './retriever.types';

/** 該租戶目前的 ACL 階段；未設＝off（遷移預設，行為與導入前相同） */
export function aclModeOf(tenantId: string): 'off' | 'shadow' | 'on' {
  return tenantStore.getTenant(tenantId)?.knowledgeAcl ?? 'off';
}

/**
 * 該 principal 可見的標籤 scope。無任何標籤時回空陣列——
 * SQL 的 `visibility_scopes && '{}'` 恆為 false，fail-closed 由語意自動給予，
 * 不需要額外防守碼。
 */
export function visibilityScopesOf(principal: RetrievalPrincipal): string[] {
  return resolveScopes(principal).filter(isKbScope);
}
```

- [ ] **Step 4: 改介面**

`retriever.types.ts`：

```ts
/**
 * 檢索身分。刻意不含 scopes——權限由檢索器內部經 resolveScopes 算出，
 * 呼叫端無從捏造（傳錯的、傳成別人的、圖方便傳萬用值的，全都編譯得過）。
 */
export interface RetrievalPrincipal {
  tenantId: string;
  userId: string;
}

export interface KnowledgeRetriever {
  readonly name: string;
  search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]>;
}
```

- [ ] **Step 5: 改 pgvector 檢索器**

`retriever.pgvector.ts`：加入 import，`search` 簽名改為 `(principal: RetrievalPrincipal, query: string)`，函式開頭取出 `tenantId`，並組出可見性片段：

```ts
import { Prisma } from '@prisma/client';
import { aclModeOf, visibilityScopesOf } from './knowledge.visibility';
import type { KnowledgeChunk, KnowledgeRetriever, RetrievalPrincipal } from './retriever.types';

  async search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]> {
    const { tenantId } = principal;
    const q = query.trim();
    if (!q) return [];
    // ...（既有的 model / embedding 邏輯不變，原本用到 tenantId 之處照舊）

    /**
     * 可見性條件必須與 tenant_id 並排（pre-filter），不可撈回 Node 再濾。
     * POOL_SIZE=20，post-filter 會讓權限窄的使用者候選池被無權 chunk 佔滿而濾剩零筆
     * ——與 0006 移除 HNSW 索引時記載的 post-filter 問題是同一個。
     * off / shadow 階段回 Prisma.empty，SQL 與導入前完全相同。
     */
    const visible =
      aclModeOf(tenantId) === 'on'
        ? Prisma.sql`and visibility_scopes && ${visibilityScopesOf(principal)}::text[]`
        : Prisma.empty;
```

兩路候選都插入該片段：

```ts
    const lexicalBranch = terms.length
      ? Prisma.sql`
          union
          (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
           from knowledge_chunks
           where tenant_id = ${tenantId}
             ${visible}
             and (lower(title) like any(${terms.map((t) => `%${t}%`)}::text[])
               or lower(text)  like any(${terms.map((t) => `%${t}%`)}::text[]))
           order by embedding <=> ${vec}::halfvec(3072)
           limit ${LEXICAL_LIMIT})`
      : Prisma.empty;

    const rows = await db.$queryRaw<CandidateRow[]>`
      (select id, url, title, text, 1 - (embedding <=> ${vec}::halfvec(3072)) as cosine
       from knowledge_chunks
       where tenant_id = ${tenantId}
         ${visible}
       order by embedding <=> ${vec}::halfvec(3072)
       limit ${POOL_SIZE})
      ${lexicalBranch}
    `;
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm test -w server -- knowledge-acl-retrieval`
Expected: PASS（4 個案例）。既有 `knowledge-retriever-pgvector.test.ts` 此時會編譯失敗（仍傳 string）——Task 5 一併修正。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge/knowledge.visibility.ts server/src/modules/knowledge/retriever.types.ts server/src/modules/knowledge/retriever.pgvector.ts server/tests/knowledge-acl-retrieval.test.ts
git commit -m "feat(knowledge): 檢索身分下推，pgvector 兩路候選 pre-filter 可見性"
```

---

### Task 5: 四個呼叫端與其餘檢索器

**Files:**
- Modify: `server/src/modules/knowledge/retriever.staticIndex.ts`
- Modify: `server/src/modules/knowledge/retriever.stub.ts`
- Modify: `server/src/modules/knowledge/knowledge.agent-service.ts`
- Modify: `server/src/modules/report/report.compose.ts`、`server/src/modules/report/report.job.ts`
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts`、`knowledge.admin.schema.ts`
- Modify: `server/src/modules/conversation/conversation.routes.ts`（修正過期註解）
- Modify: `server/tests/knowledge-retriever-pgvector.test.ts`（既有測試改傳 principal）
- Test: `server/tests/knowledge-acl-callsites.test.ts`（新增）

**Interfaces:**
- Consumes: Task 4 的 `RetrievalPrincipal`、`visibilityScopesOf`、`aclModeOf`
- Produces: `composeSection(tenantId: string, userId: string, ...)`（新增第二參數）；`queryTestSchema` 新增 `asUserId?: string`

- [ ] **Step 1: 寫失敗測試**

`server/tests/knowledge-acl-callsites.test.ts`：

```ts
/**
 * 每個「拿知識庫檢索結果」的呼叫端都必須交出身分。
 * 報告那條最容易被忘記——它不在對話流程裡，卻能把整份文件彙整成可下載檔案。
 */
import { stubRetriever } from '@/modules/knowledge/retriever.stub';

describe('檢索器介面一致性', () => {
  it('stub 收 principal 而非 tenantId', async () => {
    const out = await stubRetriever.search({ tenantId: 't1', userId: 'u1' }, '請假');
    expect(Array.isArray(out)).toBe(true);
  });

  it('composeSection 的簽名含 userId', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/modules/report/report.compose') as {
      composeSection: (...args: unknown[]) => unknown;
    };
    // (tenantId, userId, section, ...) —— 至少三個具名參數
    expect(mod.composeSection.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-callsites`
Expected: FAIL — 型別不符 / 參數個數不足

- [ ] **Step 3: 改 stub 與 staticIndex**

兩者的 `search` 簽名改為 `(principal: RetrievalPrincipal, query: string)`，函式開頭 `const { tenantId } = principal;`，其餘邏輯不變。

`retriever.stub.ts` 加註解，把「不過濾」寫成明確決定：

```ts
/**
 * stub 為固定 FAQ（dev/測試路徑），**全部視為公開**、不套用可見性過濾。
 * 這是明確決定而非遺漏：stub 內容不含任何租戶資料。
 */
```

`retriever.staticIndex.ts` 於挑選候選處套用同樣的過濾（file 後端亦須與 db 行為一致，否則權限邏輯永遠沒被日常開發驗證）：

```ts
import { aclModeOf, visibilityScopesOf } from './knowledge.visibility';

    const visible = aclModeOf(tenantId) === 'on' ? new Set(visibilityScopesOf(principal)) : null;
    const candidates = idx.chunks.filter(
      (c) => !visible || (c.visibilityScopes ?? []).some((s) => visible.has(s)),
    );
```

（`candidates` 取代原本直接迭代 `idx.chunks` 之處。）

- [ ] **Step 4: 改四個呼叫端**

`knowledge.agent-service.ts:183`：

```ts
    const pool = await retriever.search({ tenantId: session.tenantId, userId: session.userId }, query);
```

`loadTableContext` 同檔：簽名加 `userId`，呼叫端（同檔 `handleTurn`）傳 `session.userId`。

`report.compose.ts:1081` 的簽名加入第二參數 `userId`：

```ts
export async function composeSection(
  tenantId: string,
  userId: string,
  section: OutlineSection,
  locale: string | undefined,
  llm: LLMProvider,
  opts: ComposeOptions = {},
): Promise<ReportSection> {
```

同函式內的檢索呼叫：

```ts
    const pool = await retriever.search({ tenantId, userId }, section.query);
```

`report.job.ts:94` 的呼叫處補傳 `params.userId`：

```ts
        sections.push(
          await compose(params.tenantId, params.userId, section, params.locale, params.llm, { usedTables }),
        );
```

若同檔尚有其他 `compose(` 呼叫（如收尾的綜合觀察節），一併補上第二參數。
`deps.compose?: typeof composeSection` 的型別會自動跟上，無需手改。

`knowledge.admin.controller.ts` 的 `queryTest`：

```ts
    const { question, asUserId } = req.body as { question: string; asUserId?: string };
    const retriever = await pickRetriever(tenantId);
    // 管理者權限最大，用自身身分試查永遠成功、等於沒測到。
    // 權限上線後管理者最需要回答的是「HR 的小明看不看得到這份」。
    const userId = asUserId ?? (req.user?.sub ?? 'admin');
    const hits = await retriever.search({ tenantId, userId }, question);
```

`knowledge.admin.schema.ts`：

```ts
export const queryTestSchema = z.object({
  question: z.string().min(1),
  /** 以此使用者身分試查；未帶時用管理者自身 */
  asUserId: z.string().min(1).optional(),
});
```

- [ ] **Step 5: 修正過期註解**

`server/src/modules/conversation/conversation.routes.ts:16` 改為：

```ts
// userId 取自 requireAuth 注入的 req.user.sub（見 app.ts 掛載順序）；
// controller 內的 x-user-id fallback 僅供未掛 requireAuth 的測試路徑使用。
```

- [ ] **Step 6: 修既有測試**

`server/tests/knowledge-retriever-pgvector.test.ts` 內所有 `pgvectorRetriever.search('t1', …)` 改為 `pgvectorRetriever.search({ tenantId: 't1', userId: 'u1' }, …)`。該檔測的租戶未設 `knowledgeAcl`，預設 `off`，SQL 與斷言不受影響。

- [ ] **Step 7: 全套測試 + 型別**

Run: `npm test -w server && npm run typecheck -w server`
Expected: 全綠。若仍有編譯錯，即為漏掉的呼叫端——那正是本設計採用介面下推的目的。

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/knowledge server/src/modules/report server/src/modules/conversation/conversation.routes.ts server/tests
git commit -m "feat(knowledge): 四個檢索呼叫端下推身分，後台試查支援 asUserId"
```

---

### Task 6: 表格側門與標籤更新原子函式

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.tables.repo.ts`
- Modify: `server/src/modules/knowledge/knowledge.visibility.ts`
- Test: `server/tests/knowledge-acl-tables.test.ts`（新增）

**Interfaces:**
- Consumes: Task 4 的 `aclModeOf` / `visibilityScopesOf`
- Produces:
  - `searchTableCatalog(principal: RetrievalPrincipal, vector: number[], limit: number)`
  - `setFileVisibility(tenantId: string, fileId: string, scopes: string[]): Promise<void>`（單一交易更新兩表）

**關鍵**：`knowledge_tables` 是平行檢索路徑。只鎖 chunks 的症狀是「文件鎖起來了，但問它裡面的表格數字還是答得出來」。

- [ ] **Step 1: 寫失敗測試**

```ts
/**
 * knowledge_tables 是平行檢索路徑，漏掉即為側門。
 * setFileVisibility 必須在同一交易更新兩張表，且封裝成單一函式，
 * 不讓呼叫端有機會只呼叫其中一個。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
const queryRaw = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
jest.mock('@/config/env', () => ({
  __esModule: true,
  env: { DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false, KNOWLEDGE_INDEX_DIR: '.' },
}));

import { setFileVisibility } from '@/modules/knowledge/knowledge.visibility';

function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] };
  return Array.from(parts.raw ?? []).join('?');
}

import { searchTableCatalog } from '@/modules/knowledge/knowledge.tables.repo';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('標籤更新的原子性', () => {
  it('setFileVisibility 同時更新 chunks 與 tables', async () => {
    executeRaw.mockClear();
    await setFileVisibility('t1', 'f1', ['kb:hr']);
    const sqls = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sqls).toContain('update knowledge_chunks');
    expect(sqls).toContain('update knowledge_tables');
  });
});

describe('表格檢索沒有側門', () => {
  it('acl=on 時 searchTableCatalog 帶可見性條件', async () => {
    const t = tenantStore.createTenant('acl-tables-test');
    tenantStore.updateTenant(t.id, {
      knowledgeAcl: 'on',
      knowledgeLabels: [{ id: 'hr', label: '人資' }],
    });
    queryRaw.mockClear();
    await searchTableCatalog({ tenantId: t.id, userId: 'nobody' }, [1, 0, 0], 5);

    const call = queryRaw.mock.calls[0] as unknown[];
    const own = Array.from((call[0] as unknown as { raw: readonly string[] }).raw).join('?');
    const nested = call
      .slice(1)
      .filter((a): a is { sql: string } =>
        typeof a === 'object' && a !== null && typeof (a as { sql?: unknown }).sql === 'string')
      .map((a) => a.sql)
      .join(' ');
    expect(`${own} ${nested}`).toContain('visibility_scopes');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-tables`
Expected: FAIL — `setFileVisibility` 不存在

- [ ] **Step 3: 實作 setFileVisibility**

於 `knowledge.visibility.ts` 追加：

```ts
import { connectDb } from '@/lib/db';
import { env } from '@/config/env';

/**
 * 設定某檔的可見性標籤，同時更新兩張表的投影。
 *
 * 兩句**必須同一交易且封裝成單一函式**：漏掉 knowledge_tables 就是一道側門，
 * 症狀為「文件鎖起來了，但問它裡面的表格數字還是答得出來」。
 * 不碰 embedding——標籤與向量無關，改標籤不重算、不重爬、不花 token。
 *
 * 真相來源在 KnowledgeFileMeta.visibilityScopes，呼叫端須一併更新（見 admin controller）。
 */
export async function setFileVisibility(
  tenantId: string,
  fileId: string,
  scopes: string[],
): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      update knowledge_chunks set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id = ${fileId}`;
    await tx.$executeRaw`
      update knowledge_tables set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id = ${fileId}`;
  });
}
```

- [ ] **Step 4: 改 searchTableCatalog**

```ts
export async function searchTableCatalog(
  principal: RetrievalPrincipal,
  vector: number[],
  limit: number,
): Promise<TableCatalogEntry[]> {
  if (env.DATA_BACKEND !== 'db') return [];
  const { tenantId } = principal;
  const visible =
    aclModeOf(tenantId) === 'on'
      ? Prisma.sql`and visibility_scopes && ${visibilityScopesOf(principal)}::text[]`
      : Prisma.empty;
  const db = await connectDb();
  const rows = await db.$queryRaw<TableRow[]>`
    select id, source, sheet, caption, headers, row_count
    from knowledge_tables
    where tenant_id = ${tenantId} and embedding is not null
      ${visible}
    order by embedding <=> ${toVectorLiteral(vector)}::halfvec(3072)
    limit ${limit}
  `;
  return rows.map(toEntry);
}
```

`loadTable(tenantId, id)` 同樣加上過濾（直接取單張表是另一條側門）：改簽名為 `loadTable(principal: RetrievalPrincipal, id: string)`，where 加上相同的 `${visible}`。更新其呼叫端（`knowledge.agent-service.ts` 的 `loadTableContext`）傳 principal。

- [ ] **Step 5: 執行測試確認通過 + 全套**

Run: `npm test -w server -- knowledge-acl-tables && npm test -w server && npm run typecheck -w server`
Expected: 全綠

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/knowledge/knowledge.visibility.ts server/src/modules/knowledge/knowledge.tables.repo.ts server/src/modules/knowledge/knowledge.agent-service.ts server/tests/knowledge-acl-tables.test.ts
git commit -m "feat(knowledge): 表格檢索納入可見性過濾，標籤更新雙表原子化"
```

---

### Task 7: 後台 API — 標籤 CRUD 與標註

**Files:**
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts`
- Modify: `server/src/modules/knowledge/knowledge.admin.schema.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`
- Test: `server/tests/knowledge-acl-admin.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `assertValidLabelId` / `kbScopeId`；Task 6 的 `setFileVisibility`
- Produces: 下列端點

```
GET    /admin/tenants/:id/knowledge/labels
POST   /admin/tenants/:id/knowledge/labels            { id, label }
PATCH  /admin/tenants/:id/knowledge/labels/:labelId   { label }
DELETE /admin/tenants/:id/knowledge/labels/:labelId
PATCH  /admin/tenants/:id/knowledge/files/:fileId/visibility { scopes: string[] }
```

- [ ] **Step 1: 寫失敗測試**

```ts
/**
 * 標籤 CRUD 與檔案標註（supertest，x-admin-key 由 setup-env 設為 test-admin-key）。
 *
 * 刪除標籤時，使用中的文件回到「未標記（鎖住）」，不得變公開
 * ——刪除操作絕不能是提權操作。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantGrantableScopes } from '@/modules/authz/scope-catalog';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

/** 在 meta 中放一筆檔案，供標註與刪除標籤的案例使用 */
function seedFile(tenantId: string, fileId: string, scopes?: string[]): void {
  knowledgeStore.addFileMeta(
    tenantId,
    {
      fileId,
      name: `${fileId}.pdf`,
      chunks: 3,
      ingestedAt: new Date().toISOString(),
      ...(scopes ? { visibilityScopes: scopes } : {}),
    },
    {},
  );
}

describe('知識庫標籤 admin API', () => {
  it('建立標籤後出現在可授予 scope 清單', async () => {
    const tid = 'acl-admin-t1';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資文件' })
      .expect(201);

    expect(tenantGrantableScopes(tid).map((x) => x.id)).toContain('kb:hr');
  });

  it('labelId 格式不合回 400', async () => {
    await request(app)
      .post('/api/admin/tenants/acl-admin-t2/knowledge/labels')
      .set(auth)
      .send({ id: 'HR', label: '大寫不合法' })
      .expect(400);
  });

  it('標註檔案後讀得回標籤', async () => {
    const tid = 'acl-admin-t3';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(201);
    seedFile(tid, 'f1');

    const res = await request(app)
      .patch(`/api/admin/tenants/${tid}/knowledge/files/f1/visibility`)
      .set(auth)
      .send({ scopes: ['kb:hr'] })
      .expect(200);

    expect(res.body.data.scopes).toEqual(['kb:hr']);
    const file = (knowledgeStore.getMeta(tid).files ?? []).find((f) => f.fileId === 'f1');
    expect(file?.visibilityScopes).toEqual(['kb:hr']);
  });

  it('標註未知標籤回 400', async () => {
    const tid = 'acl-admin-t4';
    seedFile(tid, 'f1');
    await request(app)
      .patch(`/api/admin/tenants/${tid}/knowledge/files/f1/visibility`)
      .set(auth)
      .send({ scopes: ['kb:nope'] })
      .expect(400);
  });

  it('刪除標籤：回報使用中文件數，且該檔變成未標記而非公開', async () => {
    const tid = 'acl-admin-t5';
    await request(app)
      .post(`/api/admin/tenants/${tid}/knowledge/labels`)
      .set(auth)
      .send({ id: 'hr', label: '人資' })
      .expect(201);
    seedFile(tid, 'f1', ['kb:hr']);

    const res = await request(app)
      .delete(`/api/admin/tenants/${tid}/knowledge/labels/hr`)
      .set(auth)
      .expect(200);

    expect(res.body.data.affectedFiles).toBe(1);
    const file = (knowledgeStore.getMeta(tid).files ?? []).find((f) => f.fileId === 'f1');
    // 關鍵：標籤被移除後是空陣列（誰都看不到），不是「沒有限制」
    expect(file?.visibilityScopes).toEqual([]);
    expect(tenantGrantableScopes(tid).map((x) => x.id)).not.toContain('kb:hr');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-admin`
Expected: FAIL — 端點 404

- [ ] **Step 3: 加 schema**

`knowledge.admin.schema.ts`：

```ts
/** 建立標籤（POST /knowledge/labels） */
export const labelCreateSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
});

/** 更新標籤顯示名稱（PATCH /knowledge/labels/:labelId） */
export const labelUpdateSchema = z.object({ label: z.string().min(1).max(60) });

/** 標籤 path 參數：需保留 :labelId */
export const labelParamSchema = z.object({
  id: z.string().min(1),
  labelId: z.string().min(1),
});

/** 檔案可見性標註（PATCH /knowledge/files/:fileId/visibility） */
export const fileVisibilitySchema = z.object({ scopes: z.array(z.string()).default([]) });
```

- [ ] **Step 4: 實作 controller**

於 `knowledgeAdminController` 加入（節錄關鍵邏輯）：

```ts
  async listLabels(req, res) {
    const tenantId = String(req.params.id);
    res.json({ data: tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [] });
  },

  async createLabel(req, res) {
    const tenantId = String(req.params.id);
    const { id, label } = req.body as { id: string; label: string };
    assertValidLabelId(id);
    const cur = tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [];
    if (cur.some((l) => l.id === id)) throw AppError.badRequest(`標籤已存在：${id}`);
    tenantStore.updateTenant(tenantId, { knowledgeLabels: [...cur, { id, label }] });
    res.status(201).json({ data: { id, label } });
  },

  /**
   * 刪除標籤：使用中的文件回到「未標記（鎖住）」，**不得變公開**
   * ——刪除操作絕不能是提權操作。
   */
  async deleteLabel(req, res) {
    const tenantId = String(req.params.id);
    const labelId = String(req.params.labelId);
    const scope = kbScopeId(labelId);
    const meta = knowledgeStore.getMeta(tenantId);
    const affected = (meta.files ?? []).filter((f) => (f.visibilityScopes ?? []).includes(scope));

    for (const f of affected) {
      const next = (f.visibilityScopes ?? []).filter((s) => s !== scope);
      await setFileVisibility(tenantId, f.fileId, next);
      // 真相來源同步
      knowledgeStore.addFileMeta(tenantId, { ...f, visibilityScopes: next }, {});
    }
    const cur = tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [];
    tenantStore.updateTenant(tenantId, { knowledgeLabels: cur.filter((l) => l.id !== labelId) });
    res.json({ data: { affectedFiles: affected.length } });
  },

  async setFileVisibilityHandler(req, res) {
    const tenantId = String(req.params.id);
    const fileId = String(req.params.fileId);
    const { scopes } = req.body as { scopes: string[] };
    const valid = new Set(
      (tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => kbScopeId(l.id)),
    );
    const bad = scopes.filter((s) => !valid.has(s));
    if (bad.length) throw AppError.badRequest(`未知的標籤：${bad.join('、')}`);

    const meta = knowledgeStore.getMeta(tenantId);
    const file = (meta.files ?? []).find((f) => f.fileId === fileId);
    if (!file) throw AppError.notFound(`查無檔案：${fileId}`);

    knowledgeStore.addFileMeta(tenantId, { ...file, visibilityScopes: scopes }, {});
    await setFileVisibility(tenantId, fileId, scopes);
    res.json({ data: { fileId, scopes } });
  },
```

`saveSource` 一併接受並保存 `visibilityScopes`（`sourceSchema` 加 `visibilityScopes: z.array(z.string()).optional()`）。

- [ ] **Step 5: 掛路由**

`admin.routes.ts`，比照既有知識庫路由的 middleware 組合：

```ts
router.get('/tenants/:id/knowledge/labels', /* 既有 auth/validate */ asyncHandler(knowledgeAdminController.listLabels));
router.post('/tenants/:id/knowledge/labels', validate({ body: labelCreateSchema }), asyncHandler(knowledgeAdminController.createLabel));
router.patch('/tenants/:id/knowledge/labels/:labelId', validate({ params: labelParamSchema, body: labelUpdateSchema }), asyncHandler(knowledgeAdminController.updateLabel));
router.delete('/tenants/:id/knowledge/labels/:labelId', validate({ params: labelParamSchema }), asyncHandler(knowledgeAdminController.deleteLabel));
router.patch('/tenants/:id/knowledge/files/:fileId/visibility', validate({ body: fileVisibilitySchema }), asyncHandler(knowledgeAdminController.setFileVisibilityHandler));
```

- [ ] **Step 6: 執行測試 + 全套**

Run: `npm test -w server -- knowledge-acl-admin && npm test -w server && npm run typecheck -w server`
Expected: 全綠

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge server/src/modules/admin/admin.routes.ts server/tests/knowledge-acl-admin.test.ts
git commit -m "feat(admin): 知識庫標籤 CRUD 與檔案可見性標註 API"
```

---

### Task 8: 批次匯入的資料夾標籤

**Files:**
- Modify: `server/src/modules/knowledge/batch-source.ts`
- Modify: `server/src/modules/knowledge/folder-ingest.service.ts`
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts`
- Test: `server/tests/knowledge-acl-batch.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `kbScopeId`、Task 3 的 `KnowledgeFileMeta.visibilityScopes`
- Produces: `PendingItem.labelId?: string`；`IngestFileOptions.visibilityScopes?: string[]`

**背景**：批次匯入無人值守。fail-closed 下「匯入成功但沒人看得到」是最糟的狀態——錢付了、空間佔了、面板正常，但文件對所有人不存在，且不會有人來抱怨。沿用既有慣例（`PendingItem.tenantId` ＝子資料夾名）多加一層目錄，並把對不上標籤的檔案**擋在門口**而非放進來再關燈。

- [ ] **Step 1: 寫失敗測試**

```ts
/**
 * 目錄結構編碼標籤：inbox/<tenantId>/<labelId>/xxx.pdf
 * 對不上已知標籤的檔案不匯入，歸檔至錯誤區——錯誤區看得見、可處理，
 * 且尚未花掉 embedding 的錢。
 */
import { parseLabelFromRef } from '@/modules/knowledge/batch-source';

describe('批次匯入的資料夾標籤', () => {
  it('自路徑第二層解析 labelId', () => {
    expect(parseLabelFromRef('/inbox/acme/hr/policy.pdf', '/inbox', 'acme')).toBe('hr');
  });

  it('未分層（直接放在租戶目錄下）回 undefined', () => {
    expect(parseLabelFromRef('/inbox/acme/policy.pdf', '/inbox', 'acme')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-batch`
Expected: FAIL — `parseLabelFromRef` 不存在

- [ ] **Step 3: 實作解析**

`batch-source.ts`：

```ts
/** 一個待處理的匯入項目 */
export interface PendingItem {
  // …既有欄位
  /** 可見性標籤 id（本機來源＝租戶目錄下的第二層資料夾名）；未分層時 undefined */
  labelId?: string;
}

/**
 * 自匯入路徑取出 labelId：<root>/<tenantId>/<labelId>/<file>。
 * 未分層（檔案直接放在租戶目錄下）回 undefined，由呼叫端依 fail-closed 規則擋下。
 */
export function parseLabelFromRef(ref: string, root: string, tenantId: string): string | undefined {
  const rel = ref.startsWith(root) ? ref.slice(root.length) : ref;
  const segs = rel.split('/').filter(Boolean);
  // segs = [tenantId, ...middle, filename]
  if (segs[0] !== tenantId || segs.length < 3) return undefined;
  return segs[1];
}
```

於本機來源的 `list()` 中填入 `labelId`。

- [ ] **Step 4: 擋在門口**

`folder-ingest.service.ts` 消化每個項目之前：

```ts
    const labels = tenantStore.getTenant(item.tenantId)?.knowledgeLabels ?? [];
    const known = item.labelId && labels.some((l) => l.id === item.labelId);
    if (!known) {
      /**
       * fail-closed 在批次匯入的正確形狀是「擋在門口」，不是放進來再關燈。
       * 匯進來卻沒人看得到＝錢付了、空間佔了、面板正常，但文件對所有人不存在，
       * 且不會有人來抱怨——殭屍文件會持續累積。
       */
      logger.warn({ tenantId: item.tenantId, name: item.name, labelId: item.labelId },
        '匯入項目的資料夾未對應到已知標籤，歸檔至錯誤區');
      await source.settle(item, { ok: false, error: `未知的可見性標籤資料夾：${item.labelId ?? '（未分層）'}` });
      continue;
    }
```

呼叫 `ingestFile` 時帶入：

```ts
    await ingestFile(item.tenantId, item.name, buf, {
      deferSuggestions: true,
      visibilityScopes: [kbScopeId(item.labelId!)],
    });
```

- [ ] **Step 5: ingestFile 接受標籤**

`knowledge-file.service.ts` 的 `IngestFileOptions` 加：

```ts
  /** 匯入時的可見性標籤；未帶＝未標記（fail-closed 下不可見） */
  visibilityScopes?: string[];
```

寫入 `KnowledgeFileMeta` 與每個 chunk 的 `visibilityScopes` 時一併帶入。

- [ ] **Step 6: 執行測試 + 全套**

Run: `npm test -w server -- knowledge-acl-batch && npm test -w server && npm run typecheck -w server`
Expected: 全綠（既有 `folder-ingest.test.ts` 須一併通過；若其 fixture 未分層，補上標籤目錄）

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge server/tests/knowledge-acl-batch.test.ts
git commit -m "feat(knowledge): 批次匯入以資料夾層級指定可見性標籤，未知標籤擋在門口"
```

---

### Task 9: shadow 統計與盤點 API

**Files:**
- Create: `server/src/modules/knowledge/knowledge.acl-shadow.repo.ts`
- Modify: `server/src/modules/knowledge/retriever.pgvector.ts`
- Modify: `server/src/modules/knowledge/knowledge.admin.controller.ts`、`admin.routes.ts`
- Test: `server/tests/knowledge-acl-shadow.test.ts`（新增）

**Interfaces:**
- Consumes: Task 4 的 `aclModeOf` / `visibilityScopesOf`
- Produces:
  - `recordShadowBlocks(tenantId: string, userId: string, fileIds: string[]): Promise<void>`
  - `listShadowStats(tenantId: string): Promise<ShadowStat[]>`，`interface ShadowStat { fileId: string; blockedCount: number; sampleUserIds: string[]; lastBlockedAt: string }`
  - `GET /admin/tenants/:id/knowledge/acl-report`

**設計要點**：shadow 對 SQL 的處理與 `off` 相同（不加條件），過濾改在 Node 端**模擬**一次算差集，回傳給使用者的仍是未過濾結果。刻意不跑第二次 pre-filter 查詢（那會多一次全租戶向量掃描）。**因此 shadow 會低估影響**——它看不到那些因候選池被佔滿而根本沒進 top-20 的有權文件。此限制必須顯示在後台。

- [ ] **Step 1: 寫失敗測試**

```ts
/**
 * shadow 統計不得寫進 auditStore：AuditEntry 綁 toolId（語意不符），
 * 且 MAX_PER_TENANT=500 而 shadow 是每次查詢一筆的高頻寫入——
 * 幾天內就會把真正的工具稽核紀錄整批擠掉。本測試是那道防線。
 */
import { auditStore } from '@/modules/audit/audit.store';
import { recordShadowBlocks } from '@/modules/knowledge/knowledge.acl-shadow.repo';

describe('shadow 統計', () => {
  it('高頻寫入不影響 auditStore 內容', async () => {
    const before = auditStore.list('t1', 1000).length;
    for (let i = 0; i < 600; i += 1) {
      await recordShadowBlocks('t1', `u${i}`, ['f1']);
    }
    expect(auditStore.list('t1', 1000).length).toBe(before);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm test -w server -- knowledge-acl-shadow`
Expected: FAIL — `recordShadowBlocks` 不存在

- [ ] **Step 3: 實作 repo**

`knowledge.acl-shadow.repo.ts`：

```ts
/**
 * shadow 階段統計：以 (租戶, 檔案) 累加，資料量等於檔案數而非查詢數。
 *
 * 刻意不用 auditStore：AuditEntry 綁 toolId（語意不符），且 MAX_PER_TENANT=500，
 * 而 shadow 是每次知識庫查詢一筆的高頻寫入——會把真正的工具稽核紀錄整批擠掉。
 *
 * 不記問句全文（可能含個資）；要定位漏標的檔案，file_id 與少量 sample_user_ids 已足夠。
 * 全租戶切至 on 後，本表與三態旗標一起退場。
 */
import { connectDb } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

export interface ShadowStat {
  fileId: string;
  blockedCount: number;
  sampleUserIds: string[];
  lastBlockedAt: string;
}

const SAMPLE_LIMIT = 5;

/** 旁路性質：記錄失敗不得影響檢索主流程 */
export async function recordShadowBlocks(
  tenantId: string,
  userId: string,
  fileIds: string[],
): Promise<void> {
  if (env.DATA_BACKEND !== 'db' || fileIds.length === 0) return;
  try {
    const db = await connectDb();
    for (const fileId of fileIds) {
      await db.$executeRaw`
        insert into knowledge_acl_shadow (tenant_id, file_id, blocked_count, sample_user_ids, last_blocked_at)
        values (${tenantId}, ${fileId}, 1, array[${userId}]::text[], now())
        on conflict (tenant_id, file_id) do update set
          blocked_count = knowledge_acl_shadow.blocked_count + 1,
          sample_user_ids = (
            select array_agg(u) from (
              select distinct unnest(knowledge_acl_shadow.sample_user_ids || array[${userId}]::text[]) as u
              limit ${SAMPLE_LIMIT}
            ) s
          ),
          last_blocked_at = now()
      `;
    }
  } catch (err) {
    logger.warn({ err, tenantId }, 'shadow 統計寫入失敗（不影響檢索）');
  }
}

export async function listShadowStats(tenantId: string): Promise<ShadowStat[]> {
  if (env.DATA_BACKEND !== 'db') return [];
  const db = await connectDb();
  const rows = await db.$queryRaw<
    { file_id: string; blocked_count: bigint; sample_user_ids: string[] | null; last_blocked_at: Date }[]
  >`
    select file_id, blocked_count, sample_user_ids, last_blocked_at
    from knowledge_acl_shadow where tenant_id = ${tenantId}
    order by blocked_count desc
  `;
  return rows.map((r) => ({
    fileId: r.file_id,
    blockedCount: Number(r.blocked_count),
    sampleUserIds: r.sample_user_ids ?? [],
    lastBlockedAt: r.last_blocked_at.toISOString(),
  }));
}
```

- [ ] **Step 4: 接進檢索器**

`retriever.pgvector.ts` 於候選取回、映射為 chunk 之後（回傳之前）：

```ts
    /**
     * shadow：SQL 未過濾（與 off 相同），在此模擬一次算差集，回傳仍是未過濾結果。
     * 不跑第二次 pre-filter 查詢——那會多一次全租戶向量掃描，而 shadow 只需要
     * 「哪些檔會被擋掉」。代價是它**低估影響**：看不到那些因候選池被佔滿而
     * 根本沒進 top-k 的有權文件。此限制須顯示在後台盤點面板。
     */
    if (aclModeOf(tenantId) === 'shadow') {
      const allowed = new Set(visibilityScopesOf(principal));
      const blockedFileIds = [
        ...new Set(
          rows
            .filter((r) => !(r.visibility_scopes ?? []).some((s: string) => allowed.has(s)))
            .map((r) => r.file_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      void recordShadowBlocks(tenantId, principal.userId, blockedFileIds);
    }
```

> `CandidateRow` 需加上 `file_id: string | null` 與 `visibility_scopes: string[] | null`，且兩路 select 清單一併補上這兩欄。

- [ ] **Step 5: 盤點 API**

controller：

```ts
  /**
   * ACL 盤點：unlabeled（NULL＝從未標記，待辦）與 explicitlyEmpty（[]＝已決定誰都不能看）
   * 分開列，兩者查詢效果相同但語意不同。
   */
  async aclReport(req, res) {
    const tenantId = String(req.params.id);
    const files = knowledgeStore.getMeta(tenantId).files ?? [];
    res.json({
      data: {
        mode: aclModeOf(tenantId),
        unlabeled: files.filter((f) => f.visibilityScopes === undefined),
        explicitlyEmpty: files.filter((f) => f.visibilityScopes?.length === 0),
        shadowStats: await listShadowStats(tenantId),
        shadowCaveat:
          'shadow 以候選池內的結果估算，會低估影響：因候選池被無權文件佔滿而未進入 top-k 的有權文件不會被計入。回報零影響不等於切換 on 後零影響。',
      },
    });
  },
```

路由：

```ts
router.get('/tenants/:id/knowledge/acl-report', asyncHandler(knowledgeAdminController.aclReport));
```

- [ ] **Step 6: 執行測試 + 全套**

Run: `npm test -w server -- knowledge-acl-shadow && npm test -w server && npm run typecheck -w server`
Expected: 全綠

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/knowledge server/src/modules/admin/admin.routes.ts server/tests/knowledge-acl-shadow.test.ts
git commit -m "feat(knowledge): shadow 階段統計與 ACL 盤點 API"
```

---

### Task 10: 後台 UI

**Files:**
- Modify: `admin/src/pages/tabs/`（知識庫分頁）
- Modify: `admin/src/pages/tabs/`（權限分頁：部門指派需顯示 `UNKNOWN_DEPARTMENT` 為「訪客／未建檔帳號」）

**Interfaces:**
- Consumes: Task 7 與 Task 9 的端點

> 本任務為前端工作，可獨立於後端排程；後端 1–9 完成後系統即可經 API 操作。

- [ ] **Step 1: 標籤管理區塊**

知識庫分頁新增「可見性標籤」區塊：列出標籤、新增（id + 顯示名稱）、改名、刪除。刪除前以確認對話框顯示 `affectedFiles` 數量與「這些文件將回到未標記狀態（無人可見）」。

- [ ] **Step 2: 檔案清單顯示標籤**

檔案列表每列顯示標籤 chips 與多選編輯。**未標記者以警示色呈現**——fail-closed 讓未標記等於白花錢，此狀態必須刺眼。

- [ ] **Step 3: 試查加身分欄位**

測試查詢表單加「以此使用者身分查詢」輸入框（選填），送出時帶 `asUserId`。placeholder 說明：「留空＝以管理者身分（權限最大，通常查得到全部）」。

- [ ] **Step 4: ACL 盤點面板**

顯示目前 `mode`、未標記清單、明確清空清單、shadow 統計表（檔名／被擋次數／樣本使用者／最後時間），並把 `shadowCaveat` 原文顯示為提示。

- [ ] **Step 5: 部門指派顯示訪客桶**

權限分頁的部門下拉中，`'—'` 顯示為「訪客／未建檔帳號」，並附說明：公開 widget 的訪客落在此桶。

- [ ] **Step 6: 驗證與 Commit**

```bash
npm run typecheck -w admin && npm test -w admin
git add admin/src
git commit -m "feat(admin): 知識庫可見性標籤管理、盤點面板與訪客部門標示"
```

---

## 上線程序（實作完成後執行，非程式任務）

1. 部署後所有租戶維持 `knowledgeAcl` 未設（＝`off`），確認檢索結果與部署前一致。
2. 管理者建立標籤、標註既有檔案與網站來源；後台「未標記」計數作為進度。
3. 切 `shadow`，觀察一至兩週，依盤點面板補標漏網文件。
4. 切 `on`。出事切回 `shadow`（不回滾資料、不重跑 embedding、不改 schema）。
5. **全租戶切至 `on` 後**：移除三態旗標與相關分支、drop `knowledge_acl_shadow` 表、`visibility_scopes` 過濾改為無條件。此步驟寫入待辦，不靠記性。
