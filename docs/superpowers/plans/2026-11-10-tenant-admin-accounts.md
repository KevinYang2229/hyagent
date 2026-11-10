# 租戶管理者帳號與分頁權限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後台新增「租戶管理者」帳號。每個帳號只屬於一個租戶，超級管理者可以替每個帳號逐一設定各分頁的權限（隱藏、唯讀、可編輯），並由 API 層強制把關。

**Architecture:** 在 `requireAdmin` 之後加一層 `authorizeAdmin` middleware，用一份集中的「路由 → 分頁」規則表判斷租戶管理者的每個請求。規則表沒列到的路由一律拒絕，另有測試確保每條已註冊的路由都在表上。帳號存在新的 `adminAccountStore`，同時支援 file 和 db 兩種後端。每個請求都重新讀取帳號，所以停用、改權限、重設密碼都會立即生效。前端從 `/me` 取得身分與權限，據此過濾分頁；唯讀分頁用 `<fieldset disabled>` 包起來。

**Tech Stack:** Express 4、Prisma（db 後端）、bcrypt、jsonwebtoken、zod、jest + supertest（server）；React 18、react-router、vitest（admin）。

**Spec:** `docs/superpowers/specs/2026-11-10-tenant-admin-accounts-design.md`

## Global Constraints

- 超級管理者沿用 `ADMIN_PASSWORD`，登入帳號名稱固定為 `admin`（保留字，不能拿來建立租戶管理者）。
- `x-admin-key` 的權限等同超級管理者，行為不變。
- 登入時沒帶 `username`，視為 `admin`，相容舊的呼叫方式。
- 可設定權限的分頁共 14 個：`settings` `ai` `sso` `users` `directorySync` `knowledge` `forms` `permissions` `appearance` `webhook` `usage` `feedback` `reports` `audit`。「總覽」一律可見；「資料庫查詢」（`database`）只有超級管理者能用，不列入權限設定。
- 權限只有三種：`hidden`、`read`、`write`。沒有設定的分頁就是 `hidden`，新帳號預設全部 `hidden`。
- 唯讀等於只能用 GET（HEAD 視同 GET）；POST、PUT、PATCH、DELETE 一律 403。
- `quotaMonthlyLlmTokens` 只有超級管理者能改。
- 規則表沒列到的路由，租戶管理者一律 403。
- 錯誤訊息用繁體中文，透過 `AppError`（`server/src/utils/app-error.ts`）丟出。
- 帳號名稱的格式：`/^[a-z0-9][a-z0-9._-]{2,31}$/`，全平台唯一。密碼長度 10 到 128 字元，bcrypt cost 12。
- 租戶管理者 token：audience 是 `hyagent:tenant-admin`，效期 8 小時，payload 是 `{ sub: accountId, role: 'tenant-admin', tenantId, credentialVersion }`。
- 任何地方都不能記錄或回傳密碼及 `passwordHash`。

## Review Focus

1. **換 tenant id 或改寫路徑**：租戶管理者把網址裡的 `:id` 換成別的租戶，或用大小寫不同、結尾多一個 `/`、URL encode 過的 id，都要 403。Express 的路由比對預設不分大小寫，也允許結尾有 `/`，所以規則比對要跟 Express 一樣寬鬆，比對 tenant id 時則要先 decode 再做完全相等的比較。這項由 Task 1 的測試涵蓋。
2. **帳號失效後的舊 token**：帳號停用、刪除、重設密碼或自己改密碼之後，舊 token 在下一個請求就要回 401。這項由 Task 4 的測試涵蓋。
3. **`PATCH /tenants/:id` 的 body 混了不同層級的欄位**：只要 body 裡有 `quotaMonthlyLlmTokens`，或有任何不認得的欄位，整個請求就 403，不能只套用其他欄位。這項由 Task 1 的測試涵蓋。
4. **新增了管理端點卻沒登記**：租戶管理者打這個端點要 403，路由覆蓋測試也要失敗。這項由 Task 1 和 Task 4 的測試涵蓋。
5. **唯讀帳號呼叫觸發類的 POST**：例如 `POST /knowledge/query-test`、`POST /knowledge/suggestion`、`POST /sessions/revoke`，都要 403，而且被擋下的嘗試要寫進稽核。這項由 Task 1 和 Task 4 的測試涵蓋。

---

### Task 1：共用的權限型別與路由規則表

**Files:**
- Create: `shared/src/admin-permissions.ts`
- Modify: `shared/src/index.ts`（re-export）
- Create: `server/src/modules/admin-account/admin-route-policy.ts`
- Test: `server/tests/admin-route-policy.test.ts`

**Interfaces:**
- Produces（shared）：
  - `ADMIN_TAB_KEYS`：上述 14 個分頁 key 的 `as const` 陣列
  - `type AdminTabKey`
  - `type AdminTabLevel = 'hidden' | 'read' | 'write'`
  - `type AdminTabPermissions = Partial<Record<AdminTabKey, AdminTabLevel>>`
  - `tabLevel(p: AdminTabPermissions, tab: AdminTabKey): AdminTabLevel`
  - `type AdminMe = { kind: 'super' } | { kind: 'tenant-admin'; accountId: string; username: string; displayName: string; tenantId: string; permissions: AdminTabPermissions }`
- Produces（server）：
  - `type RouteAccess = { kind: 'public' } | { kind: 'super' } | { kind: 'self' } | { kind: 'tenant' } | { kind: 'tab'; tab: AdminTabKey; alsoReadableBy?: AdminTabKey[] } | { kind: 'tenantPatch' }`
  - `interface RouteRule { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*'; pattern: string; access: RouteAccess }`
  - `ADMIN_ROUTE_RULES: RouteRule[]`
  - `findRouteRule(method: string, path: string): { rule: RouteRule; params: Record<string, string> } | null`
  - `TENANT_PATCH_FIELDS: Record<string, AdminTabKey | 'super'>`
  - `decideTenantAdmin(input: { method: string; path: string; body: unknown; tenantId: string; permissions: AdminTabPermissions }): { allow: true } | { allow: false; reason: string }`

**規則表的語法：**
- `pattern` 是相對於 `adminRouter` 的路徑。`:name` 比對一段，結尾的 `/**` 比對零到多段。
- 由上往下比對，第一個符合的規則生效。
- 比對時字面段落不分大小寫，結尾的 `/` 會先去掉，params 會先 decode。
- `HEAD` 視同 `GET`。

**規則表的內容**（`*` 表示任何 method；GET 歸主分頁和 `alsoReadableBy` 列出的分頁，寫入只歸主分頁）：

| method | pattern | access |
| --- | --- | --- |
| POST | `/auth/login` | public |
| GET | `/me` | self |
| PUT | `/me/password` | self |
| `*` | `/tenants/:id/admin-accounts/**` | super |
| GET | `/tenants/:id` | tenant |
| PATCH | `/tenants/:id` | tenantPatch |
| POST | `/tenants/:id/keys` | tab `settings` |
| `*` | `/tenants/:id/llm-config` | tab `ai` |
| `*` | `/tenants/:id/assertion-keys/**` | tab `sso` |
| `*` | `/tenants/:id/assertion-settings` | tab `sso` |
| `*` | `/tenants/:id/sessions/**` | tab `sso` |
| `*` | `/tenants/:id/users/**` | tab `users` |
| `*` | `/tenants/:id/departments/**` | tab `users` |
| `*` | `/tenants/:id/directory-sync/**` | tab `directorySync`，alsoReadableBy `users` |
| `*` | `/tenants/:id/knowledge/**` | tab `knowledge` |
| `*` | `/tenants/:id/forms/**` | tab `forms` |
| `*` | `/tenants/:id/policy` | tab `permissions`，alsoReadableBy `knowledge` |
| `*` | `/tenants/:id/webhooks/**` | tab `webhook` |
| GET | `/tenants/:id/usage` | tab `usage` |
| `*` | `/tenants/:id/feedback/**` | tab `feedback` |
| `*` | `/tenants/:id/reports/**` | tab `reports` |
| GET | `/tenants/:id/audit` | tab `audit` |
| `*` | `/**` | super（兜底：`/tenants` 列表與建立、刪除租戶、`/skills`、`/scopes`、`/mcp-servers/**`、`/db-intelligence/**`、`/audit`，以及所有沒列到的路由） |

`DELETE /tenants/:id` 刻意沒有規則：上面的 `GET`、`PATCH /tenants/:id` 只比對各自的 method，所以 DELETE 會落到最後的兜底 `super`，租戶管理者不能刪除自己的租戶。測試要涵蓋這一點。

`TENANT_PATCH_FIELDS`：`name`、`allowedOrigins`、`guestAccess`、`egressPolicy` 對應 `settings`；`appearance` 對應 `appearance`；`quotaMonthlyLlmTokens` 對應 `super`。

**`decideTenantAdmin` 的判斷順序：**
1. 找不到規則，或 access 是 `super`：拒絕。
2. access 是 `public` 或 `self`：允許。
3. 其餘情況下 `params.id` 必須等於帳號的 `tenantId`，否則拒絕。
4. `tenant`：允許。
5. `tab`：如果是 GET，主分頁或任一 `alsoReadableBy` 分頁的權限不是 `hidden` 就允許；如果是寫入，主分頁的權限必須是 `write`。
6. `tenantPatch`：body 必須是物件；每個 key 都必須在 `TENANT_PATCH_FIELDS` 裡，而且對應的分頁權限是 `write`。遇到 `super` 或不認得的 key 就拒絕；body 是空物件也拒絕。

`reason` 用繁體中文寫給人看，例如「沒有『知識庫』的編輯權限」「只有超級管理者能修改月度 token 配額」。

- [ ] **Step 1：寫失敗的測試** `server/tests/admin-route-policy.test.ts`

```ts
const perms = { knowledge: 'read', settings: 'write', appearance: 'read' } as const;
const t = (method: string, path: string, body?: unknown) =>
  decideTenantAdmin({ method, path, body, tenantId: 'aaa111', permissions: perms }).allow;

it('只能存取自己的租戶', () => {
  expect(t('GET', '/tenants/aaa111/knowledge')).toBe(true);
  expect(t('GET', '/tenants/bbb222/knowledge')).toBe(false);
  expect(t('GET', '/TENANTS/aaa111/knowledge/')).toBe(true);
  expect(t('GET', '/tenants/aaa111%2F..%2Fbbb222/knowledge')).toBe(false);
});
it('唯讀只能 GET／HEAD', () => {
  expect(t('HEAD', '/tenants/aaa111/knowledge')).toBe(true);
  expect(t('POST', '/tenants/aaa111/knowledge/query-test')).toBe(false);
  expect(t('POST', '/tenants/aaa111/knowledge/suggestion')).toBe(false);
});
it('hidden 分頁讀寫都拒絕', () => { expect(t('GET', '/tenants/aaa111/webhooks')).toBe(false); });
it('alsoReadableBy：知識庫唯讀可讀 policy，但不能寫', () => {
  expect(t('GET', '/tenants/aaa111/policy')).toBe(true);
  expect(t('PUT', '/tenants/aaa111/policy')).toBe(false);
});
it('PATCH /tenants/:id 依欄位判斷', () => {
  expect(t('PATCH', '/tenants/aaa111', { name: 'x', allowedOrigins: [] })).toBe(true);
  expect(t('PATCH', '/tenants/aaa111', { name: 'x', quotaMonthlyLlmTokens: 0 })).toBe(false);
  expect(t('PATCH', '/tenants/aaa111', { appearance: {} })).toBe(false); // appearance 只有 read
  expect(t('PATCH', '/tenants/aaa111', { unknownField: 1 })).toBe(false);
  expect(t('PATCH', '/tenants/aaa111', {})).toBe(false);
});
it('平台層與兜底一律拒絕', () => {
  for (const [m, p] of [['GET', '/tenants'], ['POST', '/tenants'], ['DELETE', '/tenants/aaa111'],
    ['GET', '/skills'], ['GET', '/mcp-servers'], ['GET', '/db-intelligence/s1/data-sources'],
    ['GET', '/audit'], ['GET', '/tenants/aaa111/admin-accounts'], ['GET', '/tenants/aaa111/brand-new-endpoint']]) {
    expect(t(m, p)).toBe(false);
  }
});
it('self 與 tenant 規則', () => {
  expect(t('GET', '/me')).toBe(true);
  expect(t('GET', '/tenants/aaa111')).toBe(true);
  expect(t('GET', '/tenants/bbb222')).toBe(false);
});
```

- [ ] **Step 2：執行測試，確認失敗**
  執行：`cd server && npx jest tests/admin-route-policy.test.ts`
  預期：FAIL，找不到模組

- [ ] **Step 3：實作** `shared/src/admin-permissions.ts` 和 `admin-route-policy.ts`
  `pattern` 在模組載入時先編譯成 RegExp（加 `i` flag），params 用 `decodeURIComponent` 解碼，解碼失敗就視為不符合。

- [ ] **Step 4：執行測試，確認通過**
  執行：`cd server && npx jest tests/admin-route-policy.test.ts && npx tsc --noEmit -p .`
  預期：PASS，型別檢查沒有錯誤

- [ ] **Step 5：Commit**
  `git commit -m "feat(admin): 新增後台分頁權限型別與路由規則表"`

---

### Task 2：後台帳號 store

**Files:**
- Create: `server/src/modules/admin-account/admin-account.types.ts`
- Create: `server/src/modules/admin-account/admin-account.store.ts`
- Create: `server/src/modules/admin-account/password.ts`
- Modify: `server/prisma/schema.prisma`（新增 `AdminAccountRow`）
- Create: `server/db/migrations/0022_admin_accounts.sql`
- Modify: `server/src/index.ts`（在 listen 前 `initAdminAccountStore()`，照 `initWebhookStore` 的寫法）
- Modify: `server/src/modules/admin/admin.controller.ts`（刪除租戶時呼叫 `adminAccountStore.removeByTenant`）
- Test: `server/tests/admin-account-store.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `AdminTabPermissions`
- Produces：
  - `interface AdminAccount { id: string; tenantId: string; username: string; displayName: string; passwordHash: string; status: 'active' | 'disabled'; permissions: AdminTabPermissions; credentialVersion: number; createdAt: string; updatedAt: string; lastLoginAt?: string }`
  - `type PublicAdminAccount = Omit<AdminAccount, 'passwordHash' | 'credentialVersion'>`，以及 `toPublicAccount(a: AdminAccount): PublicAdminAccount`
  - `adminAccountStore`：
    - `create(input: { tenantId; username; displayName; passwordHash; permissions? }): AdminAccount`：username 重複就丟 `AppError.conflict('帳號名稱已被使用')`
    - `get(id): AdminAccount | undefined`
    - `getByUsername(username): AdminAccount | undefined`：不分大小寫
    - `listByTenant(tenantId): AdminAccount[]`
    - `update(id, patch: Partial<Pick<AdminAccount, 'displayName' | 'status' | 'permissions' | 'passwordHash' | 'lastLoginAt'>> & { bumpCredential?: boolean }): AdminAccount | undefined`
    - `remove(id): boolean`
    - `removeByTenant(tenantId): number`
    - `clear(): void`：僅供測試
  - `hashPassword(plain: string): Promise<string>`（cost 12）、`verifyPassword(plain: string, hash: string): Promise<boolean>`、`DUMMY_HASH: string`（帳號不存在時用來做假比對，讓回應時間一致）

store 的寫法照 `server/src/modules/webhook/webhook.store.ts`：記憶體 Map，file 後端用 `dataFile('oa-agent-admin-accounts.json')`，db 後端每個帳號一列（`id`、`tenant_id`、`username` 加 unique、`data jsonb`、`created_at`），寫入走 `DbWriteQueue('admin_accounts')`。SQL migration 的檔頭照 `0021_knowledge_access_logs.sql` 的格式，註明「經 Supabase SQL Editor 人工套用，必須早於帶此版本的程式部署」。

- [ ] **Step 1：寫失敗的測試**
  - 建立帳號後可以用 `get`、`getByUsername('ALICE')`（大小寫不同）取回。
  - username 重複會丟 409。
  - 新帳號的 `permissions` 是 `{}`、`credentialVersion` 是 0。
  - `update` 搭配 `{ bumpCredential: true }` 時 `credentialVersion` 加 1。
  - `removeByTenant` 只刪除該租戶的帳號。
  - `verifyPassword` 對正確的密碼回 true、錯誤的密碼回 false。
  - `toPublicAccount` 的結果沒有 `passwordHash`。
- [ ] **Step 2：執行測試，確認失敗**：`cd server && npx jest tests/admin-account-store.test.ts`
- [ ] **Step 3：實作上列檔案；在 `deleteTenant` 成功後呼叫 `removeByTenant`**
- [ ] **Step 4：執行測試，確認通過**：`cd server && npx jest tests/admin-account-store.test.ts && npx tsc --noEmit -p . && npx prisma validate`
- [ ] **Step 5：Commit** `feat(admin): 新增租戶管理者帳號 store`

---

### Task 3：登入、`/me`、修改自己的密碼

**Files:**
- Modify: `server/src/utils/jwt.ts`
- Modify: `server/src/modules/admin/admin.auth.controller.ts`、`admin.schema.ts`（`adminLoginSchema` 加上 `username?: string`）
- Modify: `server/src/modules/admin/admin.routes.ts`（新增 `GET /me`、`PUT /me/password`，掛在 `requireAdmin` 之後）
- Test: `server/tests/admin-login-tenant-admin.test.ts`

**Interfaces:**
- Consumes：Task 2 的 store 和 password 函式、Task 1 的 `AdminMe`
- Produces：
  - `signTenantAdminToken(a: { accountId: string; tenantId: string; credentialVersion: number }): string`
  - `verifyTenantAdminToken(token: string): { sub: string; role: 'tenant-admin'; tenantId: string; credentialVersion: number }`
  - `POST /auth/login`：body `{ username?, password }`，回傳 `{ data: { token: string; me: AdminMe } }`
  - `GET /me`：回傳 `{ data: AdminMe }`。從 `res.locals.adminPrincipal` 組出來（principal 由 Task 4 寫入）；`api-key` 也回 `{ kind: 'super' }`。
  - `PUT /me/password`：body `{ currentPassword, newPassword }`，回傳 `{ data: { token } }`

**行為：**
- 登入時沒帶 username，或 username 是 `admin`（不分大小寫）：走現有的 `ADMIN_PASSWORD` 流程。
- 其他帳號：不存在、停用或密碼錯，一律回 `AppError.unauthorized('帳號或密碼錯誤')`。帳號不存在時仍要對 `DUMMY_HASH` 跑一次 `verifyPassword`。登入成功就更新 `lastLoginAt`。
- `PUT /me/password`：超級管理者呼叫時回 400「超級管理者密碼由伺服器設定 ADMIN_PASSWORD 管理」。舊密碼錯就回 401；新密碼長度不符就由 zod 回 422。成功時更新雜湊並 `bumpCredential`，回傳新 token，舊 token 從此失效（Task 4 會驗證）。

Task 3 要用到 Task 4 的 principal 才能測 `/me` 和 `/me/password`，所以這兩支的整合測試放在 Task 4，本 Task 只測 login 和 jwt。

- [ ] **Step 1：寫失敗的測試**（supertest 打 `createApp()`）
  - `{ password: ADMIN_PASSWORD }` 和 `{ username: 'admin', password }` 都拿到 token，而且 `me.kind` 是 `'super'`。
  - 租戶管理者用正確的密碼可以登入，`me` 帶有 `tenantId` 和 `permissions`。
  - 密碼錯誤、帳號停用、帳號不存在，都回 401，而且訊息完全相同。
  - 用 `verifyAdminToken` 驗證租戶管理者的 token 會丟錯（audience 不同）。
- [ ] **Step 2：執行測試，確認失敗**：`cd server && npx jest tests/admin-login-tenant-admin.test.ts`
- [ ] **Step 3：實作**
- [ ] **Step 4：執行測試，確認通過**：同上，再加 `npx tsc --noEmit -p .`
- [ ] **Step 5：Commit** `feat(admin): 後台登入支援租戶管理者帳號`

---

### Task 4：`requireAdmin` 辨識身分、`authorizeAdmin` 把關、稽核記錄操作者

**Files:**
- Modify: `server/src/middlewares/require-admin.ts`
- Create: `server/src/middlewares/authorize-admin.ts`
- Modify: `server/src/modules/audit/admin-audit.ts`（擴充 `AdminActor`；summary 加上帳號名稱）
- Modify: `server/src/modules/admin/admin.routes.ts`（順序：`requireAdmin` → `adminAuditTrail` → `authorizeAdmin` → 各路由，讓被拒絕的嘗試也寫進稽核）
- Test: `server/tests/admin-authorize.test.ts`、`server/tests/admin-route-coverage.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `decideTenantAdmin`、`findRouteRule`，Task 2 的 store，Task 3 的 `verifyTenantAdminToken`
- Produces：
  - `type AdminPrincipal = { kind: 'super' } | { kind: 'api-key' } | { kind: 'tenant-admin'; account: AdminAccount }`，寫入 `res.locals.adminPrincipal`
  - `type AdminActor = 'admin' | 'admin-api-key' | \`tenant-admin:${string}\``，冒號後面是 accountId。這是字串聯集，`KeyOperator.via` 舊資料不受影響。
  - `authorizeAdmin(req, res, next)`：principal 是租戶管理者時呼叫 `decideTenantAdmin({ method: req.method, path: req.path, body: req.body, ... })`，拒絕就丟 `AppError.forbidden(reason)`。其他 principal 直接放行。

**行為：**
- `requireAdmin` 收到租戶管理者 token 時：帳號必須存在、`status === 'active'`、`tenantId` 和 `credentialVersion` 都跟 token 相符，否則回 401。
- `adminAuditTrail` 記錄租戶管理者的操作時，`userId` 是 `tenant-admin:<accountId>`，summary 的開頭加上 `帳號 <username>｜`。
- multipart 上傳的路由（例如 `POST /knowledge/files`）在 `authorizeAdmin` 執行時 `req.body` 還沒解析，但這些路由不是 `tenantPatch`，不需要讀 body，所以沒有影響。

**路由覆蓋測試：** 列舉 `adminRouter.stack` 上有 `route` 的每一層，取出它的 method 和 path。子 router 沒辦法從 stack 還原掛載路徑，所以直接 import `userAdminRouter`（`/tenants/:id/users`）、`departmentAdminRouter`（`/tenants/:id/departments`）、`directorySyncAdminRouter`（`/tenants/:id/directory-sync`）、`dbiAdminRouter`（`/db-intelligence/:serverId`），手動加上前綴後一起列舉。斷言每一條都能被 `findRouteRule` 比對到，而且**不是落到兜底的 `/**`**，除非它在一份明確列出的「平台層路由」允許清單裡。這樣以後新增租戶路由卻忘了登記，測試就會失敗。

- [ ] **Step 1：寫失敗的測試** `admin-authorize.test.ts`（supertest，用 Task 3 的 login 拿 token）
  - 擁有 `knowledge: 'read'` 的帳號：`GET /api/admin/tenants/<own>/knowledge` 回 200；`POST .../knowledge/query-test` 回 403；`GET /api/admin/tenants/<other>/knowledge` 回 403；`GET /api/admin/tenants` 回 403。
  - 被擋下的 POST 會在該租戶的稽核裡留下一筆 `ok: false`、`userId` 以 `tenant-admin:` 開頭的紀錄。
  - 超級管理者 token 和 `x-admin-key` 照常打得到 `GET /api/admin/tenants`。
  - 帳號被 `update({ status: 'disabled' })` 之後，同一個 token 打 `GET /me` 回 401。
  - 權限被改成 `{}` 之後，下一個請求就回 403。
  - `PUT /me/password` 成功後，舊 token 回 401，新 token 回 200。
  - `GET /me` 對租戶管理者回傳 `permissions`；對超級管理者回傳 `{ kind: 'super' }`。
- [ ] **Step 2：寫失敗的測試** `admin-route-coverage.test.ts`（照上面的說明）
- [ ] **Step 3：執行測試，確認失敗**：`cd server && npx jest tests/admin-authorize.test.ts tests/admin-route-coverage.test.ts`
- [ ] **Step 4：實作**
- [ ] **Step 5：執行測試，確認通過**：`cd server && npx jest tests/admin tests/audit && npx tsc --noEmit -p . && npx eslint src`
  既有的 admin 和 audit 測試必須全部維持通過。
- [ ] **Step 6：Commit** `feat(admin): 依分頁權限把關租戶管理者的管理 API`

---

### Task 5：帳號管理 API（只限超級管理者）

**Files:**
- Create: `server/src/modules/admin-account/admin-account.routes.ts`（掛在 `/tenants/:id/admin-accounts`，`Router({ mergeParams: true })`）
- Create: `server/src/modules/admin-account/admin-account.schema.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`（掛載這個 router）
- Modify: `server/tests/admin-route-coverage.test.ts`（把這個子 router 加進列舉）
- Test: `server/tests/admin-account-api.test.ts`

**Interfaces:**
- Consumes：Task 2 的 store、`toPublicAccount`、`hashPassword`
- Produces（回應一律包在 `{ data }` 裡，帳號一律是 `PublicAdminAccount`）：
  - `GET /` → `PublicAdminAccount[]`
  - `POST /`：body `{ username, displayName, password }` → 201 加帳號
  - `PATCH /:accountId`：body `{ displayName?, status?, permissions? }` → 帳號
  - `PUT /:accountId/password`：body `{ password }` → `{ id }`，同時 `bumpCredential`
  - `DELETE /:accountId` → `{ id }`

**驗證：**
- `username` 用 Global Constraints 的格式；`admin` 回 422「admin 為保留帳號」；重複回 409。
- `password` 長度 10 到 128。
- `permissions` 的 key 只能是 `ADMIN_TAB_KEYS`，值只能是三種權限之一；`database` 這類不認得的 key 回 422。
- `displayName` 長度 1 到 50。
- `:accountId` 不屬於 `:id` 這個租戶時回 404。

- [ ] **Step 1：寫失敗的測試**
  - 超級管理者可以建立、列出、修改權限、停用、重設密碼、刪除帳號；所有回應都沒有 `passwordHash`。
  - 租戶管理者 token 打這組 API，即使是自己的租戶也回 403。
  - `username: 'admin'` 回 422；重複的 username 回 409；`permissions: { database: 'read' }` 回 422；帳號屬於別的租戶時回 404。
  - 重設密碼後，該帳號的舊 token 回 401。
  - 稽核紀錄的 summary 只有欄位名稱，不包含密碼的值。
- [ ] **Step 2：執行測試，確認失敗**：`cd server && npx jest tests/admin-account-api.test.ts`
- [ ] **Step 3：實作**
- [ ] **Step 4：執行測試，確認通過**：`cd server && npx jest tests/admin-account-api.test.ts tests/admin-route-coverage.test.ts && npx tsc --noEmit -p .`
- [ ] **Step 5：Commit** `feat(admin): 新增租戶管理者帳號管理 API`

---

### Task 6：回應內容調整（單一租戶 API、機密欄位遮罩、稽核 IP 遮蔽）

**Files:**
- Modify: `server/src/modules/admin/admin.controller.ts`、`admin.routes.ts`
- Test: `server/tests/admin-tenant-admin-views.test.ts`

**Interfaces:**
- Produces：
  - `GET /tenants/:id` → `{ data: publicTenant(tenant) }`，租戶不存在時回 404
  - `GET /tenants/:id/webhooks`：每筆的 `secret` 改成 `maskKey(secret)`（`maskKey` 來自 `server/src/modules/tenant/llm-config.service.ts`）。超級管理者也一樣遮罩。`POST` 建立時的回應照舊回傳完整 secret。
  - `GET /tenants/:id/audit`：principal 是租戶管理者時，`userId` 不等於自己 `tenant-admin:<accountId>` 的紀錄，要從 summary 拿掉 `｜來源 <ip>` 這一段（regex：`/｜來源 [^｜]*/g`）。

- [ ] **Step 1：寫失敗的測試**
  - 租戶管理者有 `audit: 'read'`：自己那幾筆保留 `來源`，超級管理者那幾筆沒有 `來源`。
  - 超級管理者看到的 audit 不受影響。
  - webhook 列表的 secret 跟原值不同，而且不包含原值的中段。
  - `GET /tenants/:id` 對自己的租戶回 200，回應裡沒有 `llmConfig`、`directorySyncKeys`。
  - 逐一檢查 `GET /tenants/:id/directory-sync`、`GET /tenants/:id/llm-config`、`GET /tenants/:id/assertion-keys` 的回應，確認沒有明文金鑰。如果發現明文，就在這個 Task 一併遮罩，並加一個斷言。
- [ ] **Step 2：執行測試，確認失敗**：`cd server && npx jest tests/admin-tenant-admin-views.test.ts`
- [ ] **Step 3：實作**
- [ ] **Step 4：執行測試，確認通過**：`cd server && npx jest tests/admin tests/webhook && npx tsc --noEmit -p .`
- [ ] **Step 5：Commit** `feat(admin): 租戶管理者檢視時遮罩機密與他人來源 IP`

---

### Task 7：後台前端，依身分與權限呈現

**Files:**
- Modify: `admin/src/api.ts`
  - `login(username: string, password: string): Promise<{ token: string; me: AdminMe }>`
  - `getMe(): Promise<AdminMe>`
  - `changeMyPassword(currentPassword: string, newPassword: string): Promise<{ token: string }>`
  - `getTenant(id: string): Promise<Tenant>`
- Modify: `admin/src/auth.tsx`
  - context 改成 `{ authed; me: AdminMe | null; isSuper: boolean; level(tab: AdminTabKey): AdminTabLevel; login(username, password); logout; refreshMe() }`
  - 有 token 但 `me` 還沒載入時呼叫 `getMe()`；如果回 401 就登出
  - 超級管理者的 `level()` 一律回 `write`
- Modify: `admin/src/pages/LoginPage.tsx`：加上「帳號」欄位，預設值留空，留空時送 `admin`。登入後依身分導向：超級管理者到 `/`，租戶管理者到 `/tenants/<tenantId>`。
- Modify: `admin/src/App.tsx`：租戶管理者打開 `/`、`/skills`、`/mcp-servers`、`/audit`，或別人租戶的 `/tenants/:id/**`，一律導回自己的租戶。
- Modify: `admin/src/components/AppLayout.tsx`：租戶管理者看不到平台層的導覽，頂部列顯示顯示名稱，並提供「修改密碼」對話框和登出。
- Modify: `admin/src/pages/TenantDetailPage.tsx`
  - 改用 `api.getTenant(id)` 載入租戶
  - 分頁過濾規則：`overview` 一律顯示；`database` 只有超級管理者看得到；其他分頁在 `level(tab) !== 'hidden'` 時才顯示
  - 網址的 `?tab=` 指到看不到的分頁時，退回 `overview`
  - 權限是 `read` 的分頁，內容包在 `<fieldset disabled className="tab-readonly">` 裡，上方顯示提示「此分頁為唯讀，如需修改請聯絡平台管理者」
  - 租戶管理者看不到「租戶清單」按鈕
  - `FormDesignerPage` 套用 `forms` 分頁的權限，唯讀時一樣用 fieldset 包起來
- Modify: `admin/src/pages/tabs/OverviewTab.tsx`：接收 `level` prop，看不到的分頁就不呼叫對應的 API，也不顯示那張卡片。對應關係：`getDirectorySync` 是 directorySync 或 users；`getKnowledge` 和 `getKnowledgeAclReport` 是 knowledge；`getTenantPolicy` 是 permissions 或 knowledge；`listDirectoryUsers` 是 users；`listForms` 是 forms。
- Modify: `admin/src/pages/tabs/AuditTab.tsx`：不是超級管理者就不呼叫 `getPlatformAudit`。
- Modify: `admin/src/pages/tabs/SettingsTab.tsx`：不是超級管理者時，配額欄位顯示為唯讀，送出的 `updateTenant` body **不能包含** `quotaMonthlyLlmTokens`，否則整個請求會被 403。
- Modify: `admin/src/index.css`：`.tab-readonly` 的樣式（fieldset 去掉邊框和內距，`min-width: 0`）
- Test: `admin/src/auth.test.tsx`、修改 `admin/src/pages/TenantDetailPage.test.tsx`、`admin/src/pages/tabs/SettingsTab.test.tsx`（新檔）

**Interfaces:**
- Consumes：Task 1 的 shared 型別、Task 3 和 Task 6 的 API

- [ ] **Step 1：寫失敗的測試**
  - `TenantDetailPage`：`me` 是 `{ kind: 'tenant-admin', permissions: { knowledge: 'read', forms: 'write' } }` 時，導覽只出現總覽、知識庫、表單；知識庫的內容在 disabled 的 fieldset 裡；表單的內容不在裡面；看不到「租戶清單」按鈕。
  - 超級管理者看得到全部 16 個分頁。
  - `?tab=webhook` 對沒有 webhook 權限的帳號會退回總覽。
  - `SettingsTab`：租戶管理者儲存時，`updateTenant` 收到的 body 沒有 `quotaMonthlyLlmTokens`。
  - `auth`：登入回傳的 `me` 會被保存；`getMe` 回 401 時會登出。
- [ ] **Step 2：執行測試，確認失敗**：`cd admin && npx vitest run src/auth.test.tsx src/pages/TenantDetailPage.test.tsx src/pages/tabs/SettingsTab.test.tsx`
- [ ] **Step 3：實作**
- [ ] **Step 4：執行測試，確認通過**：`cd admin && npx vitest run && npx tsc --noEmit`
- [ ] **Step 5：Commit** `feat(admin-ui): 依後台身分與分頁權限呈現租戶頁面`

---

### Task 8：後台前端，「後台管理者」分頁

**Files:**
- Modify: `admin/src/api.ts`：`listAdminAccounts(tenantId)`、`createAdminAccount(tenantId, body)`、`updateAdminAccount(tenantId, accountId, patch)`、`resetAdminAccountPassword(tenantId, accountId, password)`、`deleteAdminAccount(tenantId, accountId)`，對應 Task 5 的 API。另新增 `AdminAccount` 型別（等同 `PublicAdminAccount`）。
- Create: `admin/src/pages/tabs/AdminAccountsTab.tsx`
- Modify: `admin/src/pages/TenantDetailPage.tsx`：在「權限」群組加上 `adminAccounts` 分頁（標籤「後台管理者」），只有超級管理者看得到。
- Test: `admin/src/pages/tabs/AdminAccountsTab.test.tsx`

**畫面：**
- 帳號列表：帳號、顯示名稱、狀態、最後登入時間、操作（編輯權限、停用或啟用、重設密碼、刪除）。刪除用既有的 `components/confirm.tsx` 確認。
- 新增帳號表單：帳號、顯示名稱、初始密碼，前端也先檢查格式和長度。
- 權限編輯：14 列，每列是分頁中文名稱加上三個選項（隱藏／唯讀／可編輯）。中文名稱沿用 `TAB_GROUPS` 的 label，不要另外寫一份。提供「全部隱藏」「全部唯讀」快捷鍵。未儲存的變更接上既有的 `UnsavedGuard` 機制。
- 重設密碼：在對話框裡輸入新密碼，成功時提示「該帳號已登入的裝置會被登出」。

- [ ] **Step 1：寫失敗的測試**
  - 列表會顯示帳號，而且沒有任何密碼欄位。
  - 把「知識庫」改成唯讀並儲存，`updateAdminAccount` 收到 `{ permissions: { ..., knowledge: 'read' } }`。
  - 新增帳號時密碼不到 10 字元，不送出並顯示錯誤。
  - 刪除要先確認才會呼叫 API。
- [ ] **Step 2：執行測試，確認失敗**：`cd admin && npx vitest run src/pages/tabs/AdminAccountsTab.test.tsx`
- [ ] **Step 3：實作**
- [ ] **Step 4：執行測試，確認通過**：`cd admin && npx vitest run && npx tsc --noEmit`
- [ ] **Step 5：Commit** `feat(admin-ui): 新增後台管理者帳號管理分頁`

---

## 收尾

- [ ] 跑全部的測試：`cd server && npx jest && npx tsc --noEmit -p . && npx eslint .`，以及 `cd admin && npx vitest run && npx tsc --noEmit`
- [ ] 在 `server/.env.example` 的 `ADMIN_PASSWORD` 附近註明：「這是超級管理者（帳號 admin）的密碼；租戶管理者帳號在後台建立」
- [ ] 部署注意事項：db 後端要先在 Supabase 套用 `0022_admin_accounts.sql`，再部署程式。寫進最後一個 commit 的說明裡。
