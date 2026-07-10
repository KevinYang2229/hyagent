# Agent 提議寄信、經確認後送出 — 設計

**日期**：2026-07-11
**狀態**：設計（已與使用者確認方向）
**前置**：Phase 2C 已建 Email 連接器 + `email.send` 工具（scope `email:write`、目前不暴露給 Agent）。

## 目標

讓 Agent（LLM 自選工具的對話服務）能協助使用者寄信，但**寄出必須經使用者明確確認**——LLM 只能「提議」，真正送出由伺服器端的確定性確認閘觸發，LLM 無法自行寄出或被 prompt injection 誘導繞過。

## 決策紀錄（brainstorming 已確認）

| # | 決策 | 選定 |
|---|---|---|
| D1 | 收件人限制 | **不限**（可寄任意信箱，含外部）→ 確認閘成為防外洩的唯一最後防線 |
| D2 | 確認機制 | **確定性確認閘**（比照表單送出守門），非交給 LLM 判斷 |
| D3 | 工具切分 | **兩工具**：`email.propose`（暴露 Agent、不寄）+ `email.send`（不暴露、只由確認閘呼叫） |
| D4 | 所送即所存 | 實際寄的是 propose 當下存入 session 的結構化草稿，非 LLM 事後生成文字 |
| D5 | v1 延後 | 限流、行內編輯（改對話重擬）、收件人白名單 |

## 架構

沿用 Agent 服務既有的 tool-loop，並比照 `form.agent-service` 送出守門的「快速路徑 + 確定性閘」模式。

### 資料流

```
使用者：「幫我寄信給王經理說會議改期」
  → Agent tool-loop：LLM 呼 email.propose({to, subject, html})
      → 不寄；存入 session.pendingEmail；回 LLM「草稿已存，請出示並徵求確認」
  → Agent 回覆：出示草稿（收件人 / 主旨 / 內文）並問「確認寄出？」

使用者：「確認」
  → Agent.handleTurn 開頭偵測：session.pendingEmail 存在 且 本輪為確認語意
      → 確定性直接 toolRegistry.invoke('email.send', session.pendingEmail, ctx)
      → 清 pendingEmail；回「已寄出（messageId…）」
  （LLM 全程碰不到真正的 email.send）
```

### 元件

**1. `email.propose` 工具（新增）**
- 位置：`server/src/modules/tools/email.tools.ts`（與 `email.send` 同檔）。
- `agentExposed: true`；`scopes: ['email:write']`；input `{ to, subject, html }`（同 `email.send`）。
- handler **不寄信**：回傳一個標記讓上層知道這是「提議」。因工具 handler 無法直接寫 session，實際存 pending 的動作由 **Agent 服務的 dispatchTool 包裝層**處理（見下），或 handler 回傳結構化草稿、由 Agent dispatchTool 攔截存入 session。
  - 採後者：`email.propose` handler 純回 `{ proposed: true, draft: input }`；Agent 的 `dispatchTool` 在 name==='email.propose' 時把 draft 存入 `session.pendingEmail`，回給 LLM「草稿已存，請出示收件人/主旨/內文並請使用者確認，勿自行宣稱已寄出」。

**2. `email.send` 工具（沿用，維持不暴露）**
- `agentExposed` 不設 → 不進 Agent 的 `availableFor` → LLM 看不到、呼不到。
- 只由 Agent 服務的確認閘以 `toolRegistry.invoke('email.send', session.pendingEmail, ctx)` 呼叫。

**3. Agent 服務確認閘（`agent.agent-service.ts` handleTurn）**
- handleTurn 開頭（進 tool-loop 前）：
  ```
  if (session.pendingEmail && isEmailConfirmation(userText)) {
    const result = await toolRegistry.invoke('email.send', session.pendingEmail, ctx); // 確定性送出
    session.pendingEmail = undefined;
    reply = `已寄出，messageId：${result.messageId}。`;
    return { reply };
  }
  if (session.pendingEmail && isEmailCancellation(userText)) {
    session.pendingEmail = undefined; // 取消；續走一般 tool-loop 讓 LLM 回應
  }
  ```
- 否則走既有 tool-loop（含 `email.propose` 於可用工具內、依 scope）。
- `isEmailConfirmation` / `isEmailCancellation`：沿用 form 的 `SUBMIT_CONFIRMATION_RE` / `SUBMIT_NEGATION_RE` 同義詞（確認/寄出/送出/OK；否定：不要/取消/先不要…）。

**4. Session 型別（`conversation.types.ts`）**
- 加 `pendingEmail?: { to: string; subject: string; html: string }`。

### 安全性質

- **LLM 不能自行寄信**：`email.send` 不暴露；`email.propose` 只存草稿。真正送出由伺服器端確認閘觸發（與表單送出守門同構、injection 無法繞過）。
- **所送即所存**：確認閘寄的是 `session.pendingEmail`（propose 當下的結構化草稿），非 LLM 事後文字 → 使用者確認時看到的收件人/內容＝實際會寄的。
- **收件人可見**：因不限信箱，Agent 出示草稿時必須明列收件人（system prompt 指示），讓使用者能攔下寄錯/外洩。
- **權限**：仍需 `email:write`（租戶於權限分頁授予）；未授予 → Agent 連 `email.propose` 都不在 `availableFor`。
- **一次一封**：`pendingEmail` 單一欄位，新 propose 覆蓋舊的 → 無批次濫寄。

## 測試策略（以 fake LLMProvider 驅動，零外部依賴）

- **提議不寄**：LLM 呼 `email.propose` → `stubSentEmails` 為空、`session.pendingEmail` 已存。
- **確認才寄**：pendingEmail 存在 + 使用者「確認」→ `stubSentEmails` 有 1 封、內容＝pendingEmail、pending 清空。
- **取消不寄**：pendingEmail 存在 + 使用者「取消」→ 未寄、pending 清空。
- **LLM 直接呼 email.send 被擋**：`email.send` 不在 `availableFor`；Agent dispatchTool 允許清單不含之 → 幻想呼叫回「工具不可用」、不寄。
- **未授予 email:write**：Agent 的 `availableFor` 不含 `email.propose`；即使 LLM 硬呼也被 allowlist 擋。

## 非目標（v1）

- 限流（每人/租戶送信上限）——確認閘已是每封一次人工放行，延後。
- 行內編輯草稿——改用對話請 Agent 重擬（覆蓋 pendingEmail）。
- 收件人白名單——D1 選不限。
- 真實 SMTP——沿用 `EMAIL_CONNECTOR=stub|smtp`；測試走 stub。

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| 不限收件人 → injection 誘導外洩 | 確定性確認閘 + 出示收件人；使用者為最後放行者。真要更嚴再加 D1 白名單。 |
| LLM 宣稱「已寄出」但其實只提議 | dispatchTool 對 propose 明確回「勿宣稱已寄出，請徵求確認」；且真正寄出只在確認閘、回覆帶 messageId。 |
| pendingEmail 殘留跨話題 | 新 propose 覆蓋；確認/取消後清空；非確認語意時保留一輪供出示。 |
