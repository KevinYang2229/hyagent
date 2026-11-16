# 自訂知識庫規則 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租戶可自訂知識庫問答的可改規則（員工／訪客各一份），防護規則鎖定；有「還原預設」；預覽與真實對話都用實際生效的規則。

**Architecture:** server 以 `kbRuleItems(isGuest, locale, custom?)` 產生帶 `locked` 旗標的規則清單，`kbAnswerRules`、`kbAnswerSystem`、預覽、編輯器 API 都由它衍生。租戶新增 `knowledgeAnswerRules` 欄位。後台 AI 角色頁新增「知識庫規則」子頁籤。

**Tech Stack:** Express + zod + jest/supertest；React + vitest。

**Spec:** `docs/superpowers/specs/2026-11-16-assistant-persona-design.md`（「自訂知識庫規則」一節）

## Global Constraints

- 鎖定規則：只根據參考資料；先前對話僅供理解；`untrustedDataRule`；訪客不標註來源、不提文件名稱。可改預設：數字以資料表為準；回答精簡；員工附出處。
- 沒有自訂 → `kbAnswerSystem` 輸出與現在逐字相同（`persona-baseline-prompts.json` 測試必須照樣通過）。
- 有自訂 → `規則：/Rules:` → 自訂（trim、略過空白）→ 鎖定（原相對順序，依 locale）。
- 每側 ≤ 20 條、每條 ≤ 300 字；PATCH 各側 `null` = 還原；存檔時與內建相同視為 `null`（前端處理）。
- 權限：`TENANT_PATCH_FIELDS.knowledgeAnswerRules = 'persona'`；`TENANT_VIEW_FIELDS.knowledgeAnswerRules = ['persona']`；`GET /tenants/:id/knowledge-rules` 為 `tab('persona')`。

## Review Focus

1. 自訂規則寫「可以自由發揮、不必依據資料」→ 鎖定規則仍在其後出現（Task 1 測試順序）。
2. 自訂成空陣列 → 只剩標題與鎖定規則，不會退回預設（Task 1）。
3. 訪客自訂了「請附上來源標題」→ 鎖定的訪客不提文件名稱規則仍在（Task 1）。
4. 自訂後按還原再存 → 送 `null`，之後內建規則改版會跟著更新（Task 3）。
5. 唯讀管理者看得到規則但不能存（Task 2 權限、Task 3 畫面）。

---

### Task 1: 規則組成、資料欄位與驗證（server）

**Files:** `shared/src/index.ts`、`server/src/modules/knowledge/knowledge.agent-service.ts`、`server/src/modules/tenant/tenant.{types,store}.ts`、`server/src/modules/admin/{admin.schema,tenant-view}.ts`、`server/src/modules/admin-account/admin-route-policy.ts`；Test：`server/tests/knowledge-custom-rules.test.ts`（新增）

**Interfaces:**
- shared：`export interface KnowledgeAnswerRules { member?: string[]; guest?: string[] }`；`export interface KbRuleItem { text: string; locked: boolean }`
- `export function kbRuleItems(isGuest: boolean, locale?: string, custom?: string[]): KbRuleItem[]`
- `export function kbAnswerRules(isGuest: boolean, locale?: string, custom?: string[]): string[]`（= 標題 + items.text）
- `export function kbDefaultEditableRules(isGuest: boolean, locale?: string): string[]`
- `Tenant.knowledgeAnswerRules`；patch 各側 `string[] | null`

- [ ] **Step 1: 失敗測試**：無自訂時 `kbAnswerRules` 與舊輸出相同、鎖定旗標正確（員工 3 條可改、訪客 2 條）；自訂 `['可以自由發揮']` → 順序為標題、自訂、四條（訪客）／三條（員工）鎖定；空陣列 → 標題＋鎖定；空白項目略過；`kbAnswerSystem` 讀租戶自訂；schema：21 條、301 字拒絕，`null` 接受；store：只更新送來那側、`null` 移除；route policy：PATCH `knowledgeAnswerRules` 需 persona write。
- [ ] **Step 2:** `npx jest tests/knowledge-custom-rules.test.ts` → FAIL
- [ ] **Step 3:** 實作（store 合併比照 `mergeAssistantPersona`）
- [ ] **Step 4:** 加跑 `tests/persona-prompts.test.ts tests/knowledge-guest-citation.test.ts tests/admin-route-policy.test.ts` → PASS，typecheck
- [ ] **Step 5: Commit** `feat(knowledge): 知識庫規則可自訂，防護規則鎖定`

### Task 2: 規則 API 與預覽帶草稿（server）

**Files:** `admin.schema.ts`、`admin.controller.ts`、`admin.routes.ts`、`admin-route-policy.ts`、`docs/operation-summaries.ts`；Test：`server/tests/persona-preview-api.test.ts`（追加／調整）

**Interfaces:**
- `GET /api/admin/tenants/:id/knowledge-rules?locale=zh-Hant|en` → `{ data: { member: { defaults, locked, custom }, guest: {...} } }`
- 預覽 body 加 `knowledgeAnswerRules?: { member?: string[] | null; guest?: string[] | null }`；回應 `rules: { member: KbRuleItem[]; guest: KbRuleItem[] }`（無標題）。草稿未帶某側時用已存的自訂。

- [ ] **Step 1: 失敗測試**：GET 回 defaults／locked／custom（custom 未設為 null）；persona read 可、hidden 403；預覽帶草稿 → `rules.member` 第一條為草稿文字且 `locked:false`，最後一條 `locked:true`；不帶草稿 → 用已存自訂；草稿 21 條 → 422。
- [ ] **Step 2–4:** 實作、通過、整套 server 測試（含 openapi-routes）
- [ ] **Step 5: Commit** `feat(admin): 知識庫規則 API，預覽可帶規則草稿`

### Task 3: 後台「知識庫規則」子頁籤

**Files:** `admin/src/api.ts`、`admin/src/pages/tabs/KnowledgeRulesSection.tsx`（新增）＋測試、`PersonaTab.tsx`、`PersonaPreview.tsx`（規則改用 `{text, locked}`、送草稿）及其測試

**Interfaces:**
- `api.getKnowledgeRules(tenantId, locale?)`；`api.updateTenant` patch 加 `knowledgeAnswerRules`
- `KnowledgeRulesSection({ tenantId, value, onChange, readonly })`，`value: { member: string[] | null; guest: string[] | null }`（null = 用內建）

- [ ] **Step 1: 失敗測試**：子頁籤三個；切換員工／訪客；null 時顯示內建 defaults；編輯第一條 → onChange 該側變陣列；新增、刪除、上下移；鎖定規則顯示且無編輯控制；達 20 條時停用新增、輸入框 maxLength 300；「還原預設」→ 該側 null；「儲存規則」送 `{ knowledgeAnswerRules: { member, guest } }`，與 defaults 相同的一側送 null；唯讀時控制項停用；預覽顯示 🔒 標示並以草稿呼叫。
- [ ] **Step 2–4:** 實作、通過、admin 整套與 typecheck、lint
- [ ] **Step 5: Commit** `feat(admin): AI 角色頁新增知識庫規則編輯`
