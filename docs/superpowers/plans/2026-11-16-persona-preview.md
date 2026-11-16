# AI 角色預覽 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「AI 角色」頁不用存檔就能預覽 AI 實際收到的角色指示（員工、訪客分開），文字由 server 用與真實對話同一個函式產生。

**Architecture:** `persona.ts` 拆出純函式 `buildPersonaLines`，`personaLines` 改為讀租戶後呼叫它。新增 `POST /admin/tenants/:id/persona-preview`（只需 persona 讀取權限，路由規則加「POST 視為讀取」標記）。後台 `PersonaPreview` 元件 400ms debounce 呼叫預覽 API。

**Tech Stack:** Express + zod + jest/supertest（server）、React + vitest + Testing Library（admin）。

**Spec:** `docs/superpowers/specs/2026-11-16-assistant-persona-design.md`（「預覽 system prompt」一節）

## Global Constraints

- 預覽只回角色區塊；平台規則在畫面以一行說明帶過，不由 API 回傳。
- 預覽 API 不寫入任何資料；權限只需 `persona` 讀取（read 或 write 皆可，hidden 拒絕）。
- body：`{ assistantPersona: <同 PATCH 格式，各側可為 null>, locale?: 'zh-Hant' | 'en' }`；回傳 `{ data: { member: string[], guest: string[] } }`。
- AI 名稱取租戶已存的 `appearance.assistantName`。
- 預覽與真實對話必須共用 `buildPersonaLines`，不得另寫一份文字。
- 畫面：debounce 400ms；中文／English 切換；某側為空顯示「維持預設行為，不加角色指示」；平台規則說明行——員工：「⋯ 以下接平台規則（不得捏造、寫入需確認等），不可修改」，訪客：「⋯ 以下接平台規則；訪客的回答不附知識庫出處」。預覽失敗只在預覽區顯示「預覽暫時無法產生」，不影響編輯與存檔。

## Review Focus

1. 唯讀管理者（persona: read）按預覽 → 200；hidden → 403（Task 2 測試）。
2. 預覽送不合法 preset 或超長 notes → 422，與 PATCH 同一套驗證（Task 2 測試）。
3. 快速連續輸入只發一次請求；舊請求晚回來不得蓋掉新結果（Task 3 測試）。
4. 某側為 null／預設且無文字 → 該側顯示「維持預設行為」（Task 3 測試）。
5. 預覽 API 失敗 → 編輯與存檔仍可用（Task 3 測試）。

---

### Task 1: 拆出 `buildPersonaLines`

**Files:**
- Modify: `server/src/modules/conversation/persona.ts`
- Test: `server/tests/persona-lines.test.ts`（追加）

**Interfaces:**
- Produces: `export function buildPersonaLines(input: { persona?: AssistantPersonaPatch | AssistantPersona; assistantName?: string; isGuest: boolean; locale?: string }): string[]`（`AssistantPersonaPatch` 從 `tenant.store` 匯入；各側為 null 時視同未設定）
- `personaLines(tenantId, userId, locale)` 簽章不變，改為呼叫 `buildPersonaLines`。

- [ ] **Step 1: 追加失敗測試**
  - `buildPersonaLines({ persona: { member: { preset: 'hr' } }, isGuest: false })` 與用同設定的租戶呼叫 `personaLines(id, 'HYW103')` 結果相同。
  - `buildPersonaLines({ persona: { member: null, guest: { preset: 'cs', contact: '02' } }, isGuest: false })` → `[]`；`isGuest: true` → 含 `02`。
  - `assistantName: '小華'` 時第一行為名稱句。
- [ ] **Step 2:** `cd server && npx jest tests/persona-lines.test.ts` → FAIL（未匯出）
- [ ] **Step 3: 實作**：把現有 `personaLines` 主體搬進 `buildPersonaLines`，`personaLines` 只負責讀租戶並轉呼叫。
- [ ] **Step 4:** `npx jest tests/persona-lines.test.ts tests/persona-prompts.test.ts` → PASS
- [ ] **Step 5: Commit** `refactor(conversation): 拆出 buildPersonaLines 供預覽共用`

---

### Task 2: 預覽 API 與「POST 視為讀取」權限

**Files:**
- Modify: `server/src/modules/admin-account/admin-route-policy.ts`（`RouteAccess` 的 tab 變體加 `treatAsRead?: true`；新規則）
- Modify: `server/src/modules/admin/admin.schema.ts`（`personaPreviewSchema`）、`admin.controller.ts`（`previewPersona`）、`admin.routes.ts`
- Test: `server/tests/admin-route-policy.test.ts`（追加）、`server/tests/persona-preview-api.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 `buildPersonaLines`；Task 1（前一個計畫）`assistantPersonaSchema`。
- Produces: `POST /api/admin/tenants/:id/persona-preview` → `{ data: { member: string[]; guest: string[] } }`

- [ ] **Step 1: 失敗測試**
  - policy：`decideTenantAdmin({ method: 'POST', path: '/tenants/aaa111/persona-preview', permissions: { persona: 'read' } })` → allow；`{}` → deny；`{ persona: 'write' }` → allow。
  - API（`signTenantAdminToken` 建 persona: read 的帳號；寫法參考 `admin-account-api.test.ts:63-66`）：
    - 送 `{ assistantPersona: { member: { preset: 'cs-assist', notes: '夥伴' }, guest: { preset: 'cs', contact: '02-1234' } } }` → 200，`data.member` 含「夥伴」、不含「02-1234」；`data.guest` 含「02-1234」。
    - `locale: 'en'` → 優先順序聲明為英文版。
    - 租戶 `appearance.assistantName = '小華'` → 兩側第一行都是名稱句。
    - 呼叫後 `tenantStore.getTenant(tid)?.assistantPersona` 仍是原值（不寫入）。
    - `persona` hidden 的帳號 → 403；preset `'hr'` 放在 guest 側 → 422；notes 501 字 → 422。
- [ ] **Step 2:** `npx jest tests/admin-route-policy.test.ts tests/persona-preview-api.test.ts` → FAIL
- [ ] **Step 3: 實作**
  - policy：tab 存取在 `treatAsRead` 為真時走讀取判斷；規則 `{ method: 'POST', pattern: '/tenants/:id/persona-preview', access: { kind: 'tab', tab: 'persona', treatAsRead: true } }`，放在兜底規則之前。
  - schema：`personaPreviewSchema = z.object({ assistantPersona: assistantPersonaSchema, locale: z.enum(['zh-Hant', 'en']).optional() }).strict()`。
  - controller：`ensureTenant` 後呼叫 `buildPersonaLines` 兩次（isGuest false/true），回傳。
- [ ] **Step 4:** 同 Step 2 → PASS；`npm run typecheck` 無錯誤
- [ ] **Step 5: Commit** `feat(admin): 新增 AI 角色預覽 API（唯讀權限即可）`

---

### Task 3: 後台預覽區塊

**Files:**
- Modify: `admin/src/api.ts`（`previewPersona`）
- Create: `admin/src/pages/tabs/PersonaPreview.tsx`、`admin/src/pages/tabs/PersonaPreview.test.tsx`
- Modify: `admin/src/pages/tabs/PersonaTab.tsx`（在欄位下方放 `<PersonaPreview tenantId persona={persona} />`，唯讀時也顯示）

**Interfaces:**
- Consumes: Task 2 API；既有 `toPersonaPatch`。
- Produces: `api.previewPersona(tenantId: string, body: { assistantPersona: PersonaPatch; locale?: 'zh-Hant' | 'en' }) => Promise<{ member: string[]; guest: string[] }>`；`PersonaPreview({ tenantId, persona }: { tenantId: string; persona: AssistantPersona })`

- [ ] **Step 1: 失敗測試**（`vi.useFakeTimers()`，mock `api.previewPersona`）
  - 掛載後 400ms 呼叫一次，參數為 `toPersonaPatch(persona)` 與 `locale: 'zh-Hant'`；顯示回傳的每一行與兩條平台規則說明行（原文見 Global Constraints）。
  - 400ms 內 rerender 三次不同 persona → 只呼叫一次，參數是最後一次。
  - 先發的請求較晚 resolve → 畫面顯示的是後發請求的結果。
  - 回傳 `member: []` → 員工框顯示「維持預設行為，不加角色指示」，且不顯示該側平台規則說明行。
  - 點「English」→ 以 `locale: 'en'` 重新呼叫。
  - API reject → 顯示「預覽暫時無法產生」。
  - `PersonaTab` 測試追加：預覽 API reject 時「儲存 AI 角色」仍可點且送出正確 patch。
- [ ] **Step 2:** `cd admin && npx vitest run src/pages/tabs/PersonaPreview.test.tsx src/pages/tabs/PersonaTab.test.tsx` → FAIL
- [ ] **Step 3: 實作**：`useEffect` + `setTimeout(400)` debounce；以遞增的 request id 丟棄過期回應；框內用 `<pre className="persona-preview">` 保留換行。
- [ ] **Step 4:** `npx vitest run && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(admin): AI 角色頁新增 system prompt 預覽`

---

## 收尾

- [ ] server、admin 全部測試，repo 根目錄 `npm run lint`、`npm run typecheck` 通過。
