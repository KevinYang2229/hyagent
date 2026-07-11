# Tool Audit Log — 設計

**日期**：2026-07-11
**狀態**：設計（已與使用者確認方向）
**動機**：Agent 現在能寄信（有副作用），需要「誰、何時、對誰做了什麼」的稽核軌跡供安全/合規查核。`toolRegistry.invoke`（所有工具唯一執行入口）自 Phase 0 即留有稽核鉤子（目前僅 logger.debug）。

## 決策紀錄（brainstorming 已確認）

| # | 決策 | 選定 |
|---|---|---|
| D1 | 稽核範圍 | **側重「有副作用」的動作**（email.send、oa.submitForm 等寫入），讀取類不稽核 |
| D2 | 是否記「被擋下的嘗試」 | **要**：權限不足(403)、驗證失敗(422) 也記（能抓濫權/濫用嘗試） |
| D3 | 隱私 | 只記**安全摘要**（收件人+主旨、表單+單號），不記完整信件內容/PII |
| D4 | 呈現 | admin 唯讀「稽核」分頁 + `GET /tenants/:id/audit` |

## 架構

### 1. 標記可稽核工具（`ToolDef`）
```ts
readonly audit?: boolean;                               // 是否寫入稽核
auditSummary?(input: unknown, result?: unknown): string; // 安全摘要（不含 PII）
```
標記：
- `email.send`：`audit:true`，`auditSummary=(i)=>`收件人 ${i.to}｜主旨 ${i.subject}``
- `oa.submitForm`：`audit:true`，`auditSummary=(i,r)=>`表單 ${i.formId}｜單號 ${r?.oaRequestId ?? '—'}``
- （`email.propose` 不寄、不記；`oa.getLeaveBalance` 唯讀、不記。）

### 2. 稽核 store（每租戶 + 磁碟持久化）
`server/src/modules/audit/audit.store.ts`，比照 usage/scope-policy 的 in-memory + `os.tmpdir()` JSON 模式。
- 每筆 `AuditEntry { toolId; userId; at: string; ok: boolean; summary: string; error?: string }`。
- 每租戶保留**最近 N 筆**（如 500）上限，超過捨最舊，避免無限成長。
- API：`record(tenantId, entry)`、`list(tenantId, limit?)`、`clear()`（測試）。

### 3. 記錄點：`toolRegistry.invoke`
對 `tool.audit === true` 的工具，於 4 個結果點各記一筆（`ctx` 已有 tenantId/userId）：
```
lookup → 若 audit：
  scope 不足   → record(ok:false, error:'權限不足'),   throw 403
  驗證失敗     → record(ok:false, error:'輸入驗證失敗'), throw 422
  handler 成功 → record(ok:true, summary)
  handler 失敗 → record(ok:false, error: message)
```
`summary` 由 `tool.auditSummary(input, result?)` best-effort 取得（try/catch；失敗則退回工具 id）。非 audit 工具維持原行為（僅 logger.debug）。

### 4. admin
- `GET /api/admin/tenants/:id/audit` → 回最近 N 筆（時間新→舊）。
- admin 新增「稽核」分頁（TenantDetailPage tab）：唯讀表格——時間 / 工具 / 使用者 / 摘要 / 狀態（成功｜被擋｜失敗）。

## 測試策略
- audit.store：record/list/上限捨舊/clear（單元）。
- invoke 稽核：audit 工具 → 成功記一筆(ok)、無權限記一筆(ok:false,權限不足)、驗證失敗記一筆；非 audit 工具不記。
- email.send/oa.submitForm 的 auditSummary 產出安全摘要（含收件人+主旨、不含 html body）。
- admin：GET /audit 回列表。
- 沿用既有「新建租戶」避免共用 default 污染（見近期 scope-enforcement 教訓）。

## 非目標（v1）
- 不記完整輸入/信件內容（只安全摘要）。
- 不做匯出、篩選、告警（先唯讀列表）。
- 不接外部 SIEM（先本地 store；正式再接 Prisma/外部）。

## 風險與緩解
| 風險 | 緩解 |
|---|---|
| auditSummary 讀到未驗證 input 而拋錯 | best-effort try/catch，退回工具 id |
| 稽核 store 無限成長 | 每租戶最近 N 筆上限 |
| tmpfile 與 dev 共用污染測試 | 測試用新建租戶；持久化細節同其他 store（正式接 Prisma） |
| 摘要含 PII | 僅收件人+主旨（不含 body）；由各工具的 auditSummary 控管欄位 |
