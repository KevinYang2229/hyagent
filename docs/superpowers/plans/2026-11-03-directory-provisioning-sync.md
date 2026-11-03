# 使用者目錄自動建立與 Webhook 同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 員工自動登入後自動進入使用者目錄，OA 以專用金鑰簽章的 webhook 同步人員異動，且不影響原有自動登入。

**Architecture:** 目錄項目與租戶各加選填欄位，舊資料不需搬移。登入成功後在背景建立或更新目錄；新的 `/api/directory-sync/events` 端點用獨立金鑰、獨立 parser 與速率限制接收事件，由純函式套用後一次寫入。後台新增「人員同步」分頁，既有 `SsoTab` 不動。

**Tech Stack:** Express、zod、Jest + supertest（server）、React + Vitest（admin）。

**Spec:** [設計文件](../specs/2026-11-03-directory-provisioning-sync-design.md)；對外契約：[HANDOFF-DIRECTORY-SYNC.md](../../HANDOFF-DIRECTORY-SYNC.md)。

## Global Constraints

- 不可影響原有自動登入，與其他需求衝突時以此為優先。
- 開關關閉時：登入路徑、回應、錯誤碼、Session、`getApplicant` 結果都不變。
- `ssoAutoProvision`、`directorySyncEnabled` 預設關閉。
- 不修改 `HyAgentAssertionVerifier`、`TenantKeyRegistry`、`SsoTab.tsx`、`/assertion-keys` 路由與登入的 `aud`。
- 不修改既有自動登入測試：`server/tests/assertion-*.test.ts`、`auth-exchange-endpoint.test.ts`、`sso-identity-profile.test.ts`（只能新增檔案）。
- 同步 `aud` 固定為 `hyagent:directory-sync`，`sub` 固定為 `directory-sync`。
- 上限：每次 500 筆事件、內容 1 MB、每租戶 10,000 人。
- 日誌只記錄租戶、`kid` 與筆數，不可含 `sub`、姓名等內容。
- 同步請求不可呼叫 `recordClockOffset`。
- 程式與介面文案用繁體中文，風格比照周圍程式碼。
- commit 只加明確路徑，不可包含與本功能無關的 `server/.env.example`；訊息格式比照既有的 `feat(scope): 繁中說明`，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. **`occurredAt` 不是 UTC 或遠在未來：** 一律轉成毫秒比較，超過現在 5 分鐘的事件以 `INVALID_OCCURRED_AT` 拒絕，否則此人之後的更新都會被略過（Task 3）。
2. **批次內同一人多筆且亂序：** 依陣列順序逐筆套用，結果等於依時間順序（Task 3）。
3. **寫入失敗後重送離職事件：** 記憶體已更新時，重送會變成舊事件；相同時間的刪除事件要再次作廢 Session，否則離職者會留在線上（Task 3、Task 4）。
4. **同一新員工同時登入多次：** 只能有一筆資料（Task 5）。
5. **`sub` 不符合目錄格式（超過 200 字元、含前後空白）：** 不建立目錄、不影響登入，也不把 `sub` 寫進日誌（Task 5）。

---

## 檔案結構

| 檔案 | 責任 |
| --- | --- |
| `server/src/modules/tenant/tenant.types.ts` | 新增欄位型別 |
| `server/src/modules/tenant/tenant.store.ts` | 同步金鑰方法、`updateTenant` 新欄位 |
| `server/src/modules/user/user.directory.ts` | 移除內部欄位、帳密資格判斷、`isExternallyManaged` |
| `server/src/modules/user/user.admin.ts` | 保留內部欄位、鎖定 OA 管理欄位 |
| `server/src/modules/user/directory-sync.apply.ts`（新）| 套用事件的純函式 |
| `server/src/modules/user/directory-sync.routes.ts`（新）| webhook 端點：parser、速率限制、驗證、回應 |
| `server/src/modules/user/directory-sync.admin.ts`（新）| 開關、金鑰、狀態的後台 API |
| `server/src/modules/user/directory-provision.ts`（新）| 登入後的背景建立與更新 |
| `admin/src/pages/tabs/DirectorySyncTab.tsx`（新）| 「人員同步」分頁 |

---

### Task 1: 資料模型與內部欄位保護

**Files:**
- Modify: `server/src/modules/tenant/tenant.types.ts`、`server/src/modules/tenant/tenant.store.ts:380-428`
- Modify: `server/src/modules/user/user.directory.ts`、`server/src/modules/auth/auth.service.ts:52,79`、`server/src/modules/auth/credential-version.ts:39`
- Modify: `server/src/modules/user/user.admin.ts`、`server/src/modules/admin/admin.controller.ts:97`
- Test: `server/tests/directory-entry-fields.test.ts`

**Interfaces:**
- Produces:
  - `type DirectoryOrigin = 'manual' | 'sso' | 'sync'`
  - `type DirectoryEntry = Applicant & { deputyIds?: string[]; origin?: DirectoryOrigin; syncedAt?: string }`
  - `Tenant` 新增選填：`userDirectory: DirectoryEntry[]`、`ssoAutoProvision: boolean`、`directorySyncEnabled: boolean`、`directorySyncKeys: TenantPublicKey[]`、`directoryTombstones: Record<string, string>`、`directorySyncStatus: { at: string; applied: number; stale: number; rejected: number }`
  - `updateTenant` 接受 `ssoAutoProvision`、`directorySyncEnabled`、`directoryTombstones`、`directorySyncStatus`
  - `isExternallyManaged(entry: DirectoryEntry): boolean`：`origin` 為 `sso`／`sync`，或有 `syncedAt`
  - `isPasswordLoginUser(userId: string, tenantId?: string): boolean`：在目錄內且 `origin` 為空或 `manual`

- [ ] **Step 1: 寫失敗測試**

```ts
it('getApplicant 不回傳內部欄位', () => {
  // 目錄有 { id:'a', name:'A', department:'D', origin:'sync', syncedAt:ISO }
  expect(getApplicant('a', tenant.id)).toEqual({ id: 'a', name: 'A', department: 'D' });
});
it.each(['sso', 'sync'])('origin=%s 不能帳密登入', (origin) => {
  expect(() => authService.login('a', env.AUTH_DEV_PASSWORD, tenant.id)).toThrow('帳號或密碼錯誤');
});
it('沒有 origin 的舊資料仍可帳密登入', () => { /* login 成功 */ });
it('webhook 接手的 manual 帳號仍可帳密登入', () => { /* origin:'manual' + syncedAt，login 成功 */ });
it('PATCH 鎖定帳號回 409 DIRECTORY_FIELD_MANAGED', async () => { /* origin:'sso'，改 name */ });
it('PATCH／DELETE 其他人時，保留他人的 origin 與 syncedAt', async () => {});
it('POST 帶 origin 無效，新帳號視為手動', async () => { /* 回應的 origin 為空 */ });
it('PUT 依 id 保留既有 origin、syncedAt，輸入值被忽略', async () => {});
it('PUT 改鎖定帳號的姓名或部門回 409', async () => {});
it('後台租戶檢視與 /api/tenant 回應不含 directoryTombstones、directorySyncKeys', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd server && npx jest tests/directory-entry-fields.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

- `getApplicant` 同時移除 `origin`、`syncedAt`。
- `login`、`refresh`、`credential-version` 三處的 `isKnownUser` 改用 `isPasswordLoginUser`；這三處都只服務帳密登入，SSO Session 不經過。
- `user.admin.ts` 的 `profile` 加上選填的 `origin`、`syncedAt`，讓內部重新驗證不會失敗；POST 輸入用 `.omit` 去掉這兩個欄位。PUT 依 id 從現有資料覆寫它們。
- `name`、`department`、`email`、`title`、`company` 不一致且 `isExternallyManaged` 時，PUT／PATCH 回 409。

- [ ] **Step 4: 確認通過，且既有測試不受影響**

Run: `cd server && npx jest tests/directory-entry-fields.test.ts tests/auth-password-login.test.ts tests/tenant-directory-security.test.ts tests/sso-identity-profile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenant/tenant.types.ts server/src/modules/tenant/tenant.store.ts server/src/modules/user/user.directory.ts server/src/modules/user/user.admin.ts server/src/modules/auth/auth.service.ts server/src/modules/auth/credential-version.ts server/src/modules/admin/admin.controller.ts server/tests/directory-entry-fields.test.ts
git commit -m "feat(directory): 目錄加入來源欄位並限制帳密登入資格"
```

### Task 2: 同步專用金鑰

**Files:**
- Modify: `server/src/modules/tenant/tenant.store.ts`（`addPublicKey` 只加一個檢查）
- Create: `server/src/modules/user/directory-sync.admin.ts`
- Modify: `server/src/modules/admin/admin.routes.ts:102-103`（掛路由）
- Test: `server/tests/directory-sync-keys.test.ts`

**Interfaces:**
- Consumes: Task 1 的欄位；`parsePublicKey`、`checkCanAddKey`、`KeyRevocationReason`
- Produces:
  - `tenantStore.listDirectorySyncKeys(tenantId): TenantPublicKey[]`
  - `tenantStore.addDirectorySyncKey(tenantId, { publicKey, label? }, operator?): { key: TenantPublicKey; created: boolean } | undefined`
  - `tenantStore.revokeDirectorySyncKey(tenantId, kid, reason, operator?): TenantPublicKey | undefined`
  - 後台 API（前綴 `/api/admin/tenants/:id/directory-sync`）：
    - `GET /` → `{ data: { ssoAutoProvision, directorySyncEnabled, keys, status } }`
    - `PATCH /` body `{ ssoAutoProvision?, directorySyncEnabled? }`，回傳同 GET
    - `POST /keys` body `{ publicKey, label? }` → `{ data: { key, created } }`
    - `POST /keys/:kid/revoke` body `{ reason }` → `{ data: { key } }`

- [ ] **Step 1: 寫失敗測試**

```ts
it('貼上私鑰被拒絕', () => {});
it('最多 2 把啟用中', () => {});
it('公鑰已是登入金鑰時，不能登記為同步金鑰', () => {});
it('公鑰已是同步金鑰時，不能登記為登入金鑰', () => {});
it('可以撤銷最後一把同步金鑰', () => {});
it('撤銷同步金鑰後，登入金鑰與該租戶 Session 都不變', async () => {
  // listPublicKeys 不變，authSessionStore 既有 Session 仍可驗證
});
it('沒有同步金鑰的租戶，addPublicKey 行為與原本相同', () => {});
it('後台 API 需要管理員權限，開關更新後 GET 反映新值', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd server && npx jest tests/directory-sync-keys.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

上傳時用 `parsePublicKey` 算出 `kid`，若 `kid` 存在於另一組金鑰（不論是否已撤銷）就拋出與 `tenant-keys.ts` 相同類型的錯誤，訊息為「此公鑰已登記於另一用途，同步與登入必須使用不同金鑰」。撤銷時不呼叫 `checkCanRevoke` 與 `revokeByKid`。變更後 `await tenantStore.persistCritical()`。

- [ ] **Step 4: 確認通過**

Run: `cd server && npx jest tests/directory-sync-keys.test.ts tests/assertion-exchange.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenant/tenant.store.ts server/src/modules/user/directory-sync.admin.ts server/src/modules/admin/admin.routes.ts server/tests/directory-sync-keys.test.ts
git commit -m "feat(directory-sync): 新增同步專用金鑰與後台 API"
```

### Task 3: 套用事件的純函式

**Files:**
- Create: `server/src/modules/user/directory-sync.apply.ts`
- Test: `server/tests/directory-sync-apply.test.ts`

**Interfaces:**
- Consumes: `DirectoryEntry`
- Produces:

```ts
type SyncResult = { eventId: string; status: 'applied' | 'stale' | 'rejected'; reason?: string };
function applyDirectoryEvents(input: {
  users: DirectoryEntry[];
  tombstones: Record<string, string>;
  events: unknown[];
  nowMs: number;
}): {
  users: DirectoryEntry[];
  tombstones: Record<string, string>;
  results: SyncResult[];
  revokeUserIds: string[];
  changed: boolean;
};
```

`reason` 的值：`INVALID_EVENT`、`INVALID_USER`、`INVALID_OCCURRED_AT`、`DIRECTORY_FULL`。

- [ ] **Step 1: 寫失敗測試**

```ts
it('upsert 建立新人，origin 為 sync，syncedAt 為正規化 ISO', () => {});
it('upsert 更新既有人員：沒帶的 title/company/email 被清除', () => {});
it('upsert 保留 deputyIds、region、origin', () => {});
it('manual 帳號被接手後 origin 仍是 manual', () => {});
it('sso 帳號被接手後 origin 仍是 sso，且有 syncedAt', () => {});
it('occurredAt 相同或較舊回 stale，資料不變', () => {});
it('不同時區表示同一時刻視為相同：+08:00 與 Z', () => {});
it('occurredAt 超過現在 5 分鐘回 rejected INVALID_OCCURRED_AT', () => {});
it('occurredAt 無法解析回 rejected INVALID_OCCURRED_AT', () => {});
it('批次內同一人亂序：結果為最新那筆', () => {});
it('delete 移出目錄、寫入刪除紀錄、從他人 deputyIds 移除，並列入 revokeUserIds', () => {});
it('delete 不存在的人：仍寫入刪除紀錄、回 applied', () => {});
it('重送相同 occurredAt 的 delete：回 stale，但仍列入 revokeUserIds', () => {});
it('刪除後遲到的舊 upsert 不會復活', () => {});
it('晚於刪除紀錄的 upsert 重新建立（復職）', () => {});
it('超過 10,000 人回 rejected DIRECTORY_FULL，更新既有人員不受影響', () => {});
it('一筆不合法時，其他筆照常套用', () => {});
it('email 不合法、缺 name 或 department 回 rejected INVALID_USER', () => {});
it('超過 30 天的刪除紀錄被清除，未滿 30 天保留', () => {});
it('全部 stale 時 changed 為 false', () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd server && npx jest tests/directory-sync-apply.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `applyDirectoryEvents`**

每筆用 zod `safeParse` 驗證，欄位限制與 `user.admin.ts` 的 `profile` 相同。不可修改輸入參數。比較時間一律用 `Date.parse` 的毫秒值，不比較字串。`syncedAt`、刪除紀錄都存 `new Date(ms).toISOString()`。

- [ ] **Step 4: 確認通過**

Run: `cd server && npx jest tests/directory-sync-apply.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/user/directory-sync.apply.ts server/tests/directory-sync-apply.test.ts
git commit -m "feat(directory-sync): 實作事件套用與新舊判斷"
```

### Task 4: Webhook 端點

**Files:**
- Create: `server/src/modules/user/directory-sync.routes.ts`
- Modify: `server/src/app.ts:72`（parser 掛在全域 `express.json` 前）、`server/src/app.ts:115`（router 掛在 `authRouter` 後）
- Modify: `server/src/config/env.ts`（`DIRECTORY_SYNC_RATE_LIMIT_MAX`，預設 120）
- Test: `server/tests/directory-sync-endpoint.test.ts`；helper 放在同檔，用 `server/tests/helpers/assertion-signer.ts` 的 `issueAssertion` 帶 `audience` 與 `body_sha256`

**Interfaces:**
- Consumes: Task 2 的 `directorySyncKeys`、Task 3 的 `applyDirectoryEvents`
- Produces:
  - `directorySyncBodyParser`：`express.raw({ type: '*/*', limit: '1mb' })` 加上把超限轉成 413 `TOO_MANY_EVENTS` 的錯誤處理
  - `directorySyncRouter`：`POST /api/directory-sync/events`，契約依 HANDOFF §5–§7

- [ ] **Step 1: 寫失敗測試**

```ts
it('合法請求回 200 data.results，目錄已更新', async () => {});
it('開關關閉回 403 DIRECTORY_SYNC_DISABLED', async () => {});
it('登入金鑰簽的同步請求回 401 UNKNOWN_KID', async () => {});
it('同步金鑰簽的憑證打 /api/auth/sso/exchange 被拒絕', async () => {});
it('aud=hyagent 回 401 INVALID_AUDIENCE', async () => {});
it('內容與 body_sha256 不符回 400 BODY_HASH_MISMATCH', async () => {});
it('重用同一張 JWT 回 401 TOKEN_REPLAYED', async () => {});
it('其他租戶的金鑰不能改此租戶目錄', async () => {});
it('撤銷的金鑰回 401 KEY_REVOKED', async () => {});
it('JSON 不合法或缺 events 回 400 INVALID_BODY', async () => {});
it('501 筆事件回 413 TOO_MANY_EVENTS；超過 1 MB 也是', async () => {});
it('user.deleted 後該員工 Session 立即失效，其他人不受影響', async () => {});
it('persistCritical 失敗回 500、不作廢 Session；重送後 Session 被作廢', async () => {});
it('同步觸發 429 時，/api/auth/sso/exchange 仍可用', async () => {});
it('同步請求不改變 clockOffsetStats', async () => {});
it('其他路由的 JSON parsing 不變：/api/auth/sso/exchange 正常', async () => {});
it('成功後 directorySyncStatus 記錄筆數，不含人員資料', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd server && npx jest tests/directory-sync-endpoint.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

處理順序：

1. 取 Bearer token（缺少回 401 `UNAUTHORIZED`）→ `peekIssuer` → `tenantStore.getTenantFromPrimary`，查無回 `TENANT_NOT_FOUND`。
2. 建立 `new HyAgentAssertionVerifier({ registry, replayStore: claimReplayStore, audience: 'hyagent:directory-sync', clockSkewSeconds })`，registry 為本檔自己實作、查 `directorySyncKeys` 的 `AssertionKeyRegistry`；呼叫 `verifyAndConsumeWithKey`。
3. 檢查開關；比對原始內容的 SHA-256 與 `body_sha256`；解析 JSON；檢查事件數。
4. 用 `tenantStore.getTenant` 取最新資料，呼叫 `applyDirectoryEvents`，在同一段同步程式內 `updateTenant`（中間不可 `await`）；`changed` 為 false 時只更新狀態。
5. `await tenantStore.persistCritical()` 成功後，才對 `revokeUserIds` 逐一呼叫 `authSessionStore.revokeBySub`，再回 200。

錯誤用 `toErrorResponse`；其他代碼也用相同的扁平格式，`requestId` 取自 `x-request-id`。速率限制用 `rateLimit` 建立獨立實例，訊息為扁平格式的 `RATE_LIMITED`。

- [ ] **Step 4: 確認通過**

Run: `cd server && npx jest tests/directory-sync-endpoint.test.ts tests/auth-exchange-endpoint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/user/directory-sync.routes.ts server/src/app.ts server/src/config/env.ts server/tests/directory-sync-endpoint.test.ts
git commit -m "feat(directory-sync): 新增接收人員異動的 webhook 端點"
```

### Task 5: 登入後自動建立

**Files:**
- Create: `server/src/modules/user/directory-provision.ts`
- Modify: `server/src/modules/auth/assertion-exchange.ts`（`authSessionStore.create` 之後新增一段）
- Test: `server/tests/directory-provision.test.ts`

**Interfaces:**
- Consumes: `AssertionClaims`、Task 1 的欄位
- Produces:
  - `provisionFromClaims(tenantId: string, claims: AssertionClaims): void`：同步執行，可能拋錯
  - `scheduleSsoProvision(tenantId: string, claims: AssertionClaims): void`：`setImmediate` 後執行，捕捉所有例外並記警告

- [ ] **Step 1: 寫失敗測試**

```ts
it('開關關閉：不呼叫 scheduleSsoProvision，目錄不變', async () => {});
it('開啟：新員工建立，origin 為 sso，欄位對應 name/deptName/jobPostName/companyName/email', async () => {});
it('email 不合法時略過 email，其餘照建', () => {});
it('只有 sub 時，姓名用 sub、部門用 UNKNOWN_DEPARTMENT', () => {});
it('origin=sso 且無 syncedAt：資料不同才更新', () => { /* 相同時不呼叫 updateTenant */ });
it('origin=sso 且有 syncedAt：不更新', () => {});
it('origin=manual：不更新', () => {});
it('目錄滿 10,000 人：不建立，登入成功', async () => {});
it('sub 超過 200 字元或含前後空白：不建立，登入成功，日誌不含 sub', async () => {});
it('刪除紀錄晚於 iat：不建立；iat 較晚：建立', () => {});
it('同一新員工連續觸發兩次：只有一筆', () => {});
it('provisionFromClaims 拋錯：exchange 回應與開關關閉時相同', async () => {});
it('exchange 不等待背景工作：updateTenant 延遲時仍立即回傳', async () => {});
it('有刪除紀錄、目錄缺人時，只要憑證有效仍可登入', async () => {});
it('免登入訪客不寫入目錄', async () => {});
it('開啟且寫入前的第一個請求：getApplicant 走 Session 憑證，資料相同', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd server && npx jest tests/directory-provision.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

`exchange` 內只新增：

```ts
if (tenant.ssoAutoProvision === true) scheduleSsoProvision(tenant.id, claims);
```

`provisionFromClaims` 用 `tenantStore.getTenant` 取最新資料，讀取到 `updateTenant` 之間不可有 `await`；開關在執行當下再檢查一次，並不呼叫 `persistCritical`。欄位對應的 key 與 `applicantFromSso` 相同。

- [ ] **Step 4: 確認所有自動登入測試未修改且通過**

Run: `cd server && npx jest tests/directory-provision.test.ts tests/assertion- tests/auth-exchange-endpoint.test.ts tests/auth-guest-endpoint.test.ts tests/sso-identity-profile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/user/directory-provision.ts server/src/modules/auth/assertion-exchange.ts server/tests/directory-provision.test.ts
git commit -m "feat(directory): 自動登入後在背景建立目錄資料"
```

### Task 6: 「人員同步」分頁

**Files:**
- Create: `admin/src/pages/tabs/DirectorySyncTab.tsx`、`admin/src/pages/tabs/DirectorySyncTab.test.tsx`
- Modify: `admin/src/api.ts`、`admin/src/pages/TenantDetailPage.tsx:19-39,134`

**Interfaces:**
- Consumes: Task 2 的後台 API
- Produces: `api.getDirectorySync`、`api.updateDirectorySync`、`api.addDirectorySyncKey`、`api.revokeDirectorySyncKey`；頁籤 key `directorySync`，標籤「人員同步」，放在「使用者目錄」之後

- [ ] **Step 1: 寫失敗測試**

```ts
it('顯示兩個開關的目前狀態，切換後呼叫 updateDirectorySync', async () => {});
it('開啟同步但沒有啟用中金鑰時顯示提醒', async () => {});
it('上傳公鑰成功後顯示金鑰；created=false 視為錯誤', async () => {});
it('撤銷金鑰需先選原因，並說明不影響登入', async () => {});
it('顯示最近同步狀態；沒有資料時顯示尚未同步', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd admin && npx vitest run src/pages/tabs/DirectorySyncTab.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作 `DirectorySyncTab`**

版面與文案比照 `SsoTab` 的卡片，但不修改也不 import `SsoTab`；上傳說明要寫明「這組金鑰只用於人員同步，不可與自動登入共用」。

- [ ] **Step 4: 確認通過**

Run: `cd admin && npx vitest run src/pages/tabs/DirectorySyncTab.test.tsx && npx tsc --noEmit`
Expected: PASS，無型別錯誤

- [ ] **Step 5: Commit**

```bash
git add admin/src/pages/tabs/DirectorySyncTab.tsx admin/src/pages/tabs/DirectorySyncTab.test.tsx admin/src/api.ts admin/src/pages/TenantDetailPage.tsx
git commit -m "feat(admin): 新增人員同步分頁"
```

### Task 7: 使用者目錄與部門提醒

**Files:**
- Modify: `admin/src/api.ts:46-52`（`DirectoryUser` 加 `origin?`、`syncedAt?`）
- Modify: `admin/src/pages/tabs/UsersTab.tsx`、`admin/src/pages/tabs/DepartmentsSection.tsx`
- Test: `admin/src/pages/tabs/UsersTab.test.tsx`（新增案例）、`admin/src/pages/tabs/DepartmentsSection.test.tsx`

**Interfaces:**
- Consumes: Task 1 回傳的 `origin`、`syncedAt`；Task 6 的 `api.getDirectorySync`（`UsersTab` 載入 `directorySyncEnabled` 後，以 prop 傳給 `DepartmentsSection`）；既有 `DepartmentSummary`（是否有角色的欄位以 `grantSummary` 用到的欄位為準）

- [ ] **Step 1: 寫失敗測試**

```ts
it('顯示來源標記：手動、自動登入、OA 同步', async () => {});
it('OA 管理的帳號沒有編輯按鈕', async () => {});
it('webhook 接手的 manual 帳號標示 OA 同步，也沒有編輯按鈕', async () => {});
it('刪除 OA 管理帳號時提示會重新建立，停權請在 OA 處理', async () => {});
it('手動帳號的編輯與刪除行為不變', async () => {});
it('有人員但沒有角色的部門顯示提醒；都有角色時不顯示', async () => {});
it('directorySyncEnabled 開啟時，改名或刪除部門提示會被 OA 蓋回', async () => {});
```

- [ ] **Step 2: 執行確認失敗**

Run: `cd admin && npx vitest run src/pages/tabs/UsersTab.test.tsx src/pages/tabs/DepartmentsSection.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作**

標記用既有的 `badge` 樣式。提醒文案：「{部門} 有 {N} 位人員，但沒有任何角色；若部門在 OA 改過名，請更新角色的適用部門。」

- [ ] **Step 4: 確認通過**

Run: `cd admin && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add admin/src/api.ts admin/src/pages/tabs/UsersTab.tsx admin/src/pages/tabs/UsersTab.test.tsx admin/src/pages/tabs/DepartmentsSection.tsx admin/src/pages/tabs/DepartmentsSection.test.tsx
git commit -m "feat(admin): 目錄顯示資料來源並提醒無角色的部門"
```

### Task 8: 文件更新與整體驗證

**Files:**
- Modify: `docs/HANDOFF-DIRECTORY-SYNC.md`、`docs/HANDOFF-SSO.md`、`docs/HyAgent客戶網站自動登入規格.md`（§4.2.3）、`docs/HyAgent客戶端整合手冊.md`
- Modify: `server/src/modules/user/user.directory.ts`（優先序註解）
- Create: `server/tests/directory-sync-handoff.test.ts`

- [ ] **Step 1: 寫對接文件範例的測試**

把 `HANDOFF-DIRECTORY-SYNC.md` §5.3 的 `sendEvents` 簽章步驟原樣放進測試，打實際端點，並跑完 §9 能自動化的項目（新增、異動、清除職稱、刪除、重送、亂序）。

- [ ] **Step 2: 執行測試並修正落差**

Run: `cd server && npx jest tests/directory-sync-handoff.test.ts`
Expected: PASS。若失敗，修正文件或程式，讓兩者與設計文件一致。

- [ ] **Step 3: 更新文件**

- 對接文件移除「實作前草稿」狀態，改寫目前支援的環境。
- 規格 §4.2.3 與 `HANDOFF-SSO.md` 補上：開啟自動建立後，資料會進目錄；收到 webhook 後以 webhook 為準。
- 整合手冊加上對接文件連結。
- `user.directory.ts` 註解說明新的來源與優先序。

- [ ] **Step 4: 驗證不影響自動登入與整體**

Run:

```bash
git diff --name-only main -- server/src/lib/assertion admin/src/pages/tabs/SsoTab.tsx server/tests/assertion-exchange.test.ts server/tests/assertion-issuer.test.ts server/tests/assertion-keygen.test.ts server/tests/assertion-verifier.test.ts server/tests/auth-exchange-endpoint.test.ts server/tests/sso-identity-profile.test.ts
cd server && npx jest
cd ../admin && npx vitest run && npx tsc --noEmit
```

Expected: 第一行除了本分支開始前已存在的差異，沒有本計畫造成的變更；測試全部 PASS。

- [ ] **Step 5: 用真實程式手動確認**

用 `run` skill 啟動 server 與 admin，開啟兩個開關，實際走一次：自動登入 → 目錄出現此人 → webhook 改部門 → 權限更新 → 刪除 → 被登出；再關掉開關，確認自動登入正常。

- [ ] **Step 6: Commit**

```bash
git add docs/HANDOFF-DIRECTORY-SYNC.md docs/HANDOFF-SSO.md "docs/HyAgent客戶網站自動登入規格.md" "docs/HyAgent客戶端整合手冊.md" server/src/modules/user/user.directory.ts server/tests/directory-sync-handoff.test.ts
git commit -m "docs(directory-sync): 更新對接文件與自動登入規格"
```
