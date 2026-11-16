# 依功能覆寫角色 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四個功能（knowledge／form／agent／assistant）可各自覆寫員工與訪客的角色；預設沿用。

**Architecture:** `assistantPersona` 每側加 `services` 覆寫表；`buildPersonaLines`／`personaLines` 多一個 `service` 參數，四個服務各傳自己的 key；預覽 API 與畫面加功能選擇。

**Spec:** `docs/superpowers/specs/2026-11-16-assistant-persona-design.md`（「依功能覆寫角色」）

## Global Constraints
- 功能 key：`knowledge`、`form`、`agent`、`assistant`。沒有 key＝沿用；`default`＝此功能不加角色描述。
- 覆寫只換角色描述；名稱、補充說明、聯絡管道、優先順序聲明不變。
- 沒有覆寫 → 所有 prompt 與現在相同（`persona-baseline-prompts.json`）。
- 員工側覆寫只能用員工 preset，訪客側只能用訪客 preset（zod 擋）。

## Review Focus
1. 只設覆寫、其他皆空的一側：存檔保留、prompt 生效（Task 1、3）。
2. 覆寫成 `default`：該功能沒有角色描述，但補充說明仍在（Task 1）。
3. 訪客側覆寫用了員工 preset → 422（Task 1）。
4. 預覽切到填表：顯示填表覆寫的角色，且不顯示知識庫規則（Task 2、3）。
5. 存檔資料裡有未知功能 key 或未知 preset → 不丟錯（Task 1）。

---

### Task 1: 資料、驗證與 prompt 套用（server）
**Files:** `shared/src/index.ts`、`server/src/modules/conversation/persona.ts`、四個 agent-service、`admin.schema.ts`；Test：`server/tests/persona-per-service.test.ts`
**Interfaces:** shared `PersonaServiceKey = 'knowledge'|'form'|'agent'|'assistant'`；`buildPersonaLines({ persona, assistantName, isGuest, locale, service? })`；`personaLines(tenantId, userId, locale?, service?)`
- [ ] 失敗測試：覆寫取代角色描述、沿用時同原本、`default` 覆寫只剩補充說明與聲明、未知 key／preset 不丟錯、四個 builder 各自讀自己的覆寫（例如 form 覆寫 hr 時填表 prompt 含 HR 描述、知識庫不含）、schema 擋跨組 preset 與未知功能 key
- [ ] 實作、通過、`persona-prompts`／`persona-lines` 照舊通過、typecheck
- [ ] Commit `feat(conversation): 角色可依功能覆寫`

### Task 2: 預覽 API 支援功能（server）
**Files:** `admin.schema.ts`、`admin.controller.ts`、`operation-summaries.ts`；Test：`persona-preview-api.test.ts`
- [ ] 失敗測試：`service: 'form'` 回填表覆寫的角色；不帶 service 時等同 knowledge；未知 service 422
- [ ] 實作、通過、server 整套
- [ ] Commit `feat(admin): AI 角色預覽可選功能`

### Task 3: 後台覆寫欄位與預覽功能選單
**Files:** `admin/src/pages/tabs/PersonaSection.tsx`、`persona.util.ts`、`PersonaPreview.tsx`、`api.ts` 及測試
- [ ] 失敗測試：每側四個下拉，第一項「沿用（目前角色名稱）」；選擇後 onChange 帶 `services`；選回沿用時移除該 key；`toPersonaPatch` 只有覆寫的一側保留；預覽有功能選單，切到填表以 `service: 'form'` 呼叫且不顯示規則展開、顯示「此功能的平台規則不在預覽範圍」
- [ ] 實作、通過、admin 整套、typecheck、lint
- [ ] Commit `feat(admin): AI 角色可依功能覆寫，預覽可切換功能`
