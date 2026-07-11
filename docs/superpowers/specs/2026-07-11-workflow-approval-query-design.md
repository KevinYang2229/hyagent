# Workflow：查簽核進度／我的申請／催辦 — 設計

**日期**：2026-07-11
**狀態**：設計（已與使用者確認方向）
**定位**：藍圖 Phase 2 最後一塊。讓員工在對話中問「我的假單簽到哪了？」「我有哪些申請？」並可接「幫我催一下」。

## 決策紀錄

| # | 決策 | 選定 |
|---|---|---|
| D1 | 對話入口 | **給 Agent 當工具**（非獨立第五服務）：兩個唯讀工具標 `agentExposed`，由既有 Agent 回答；催辦複用 `email.propose`→確認→寄出（含稽核）。原藍圖的獨立 Workflow 服務不再需要——Agent 已具備多輪、確認閘、稽核。 |
| D2 | 資料來源 | 新增**每租戶「我的申請」store**（送出時記錄）；簽核進度**查詢時重算**（stub＝`computeApprovals` 時間推演，與現有 Demo 一致）。真 OA 的 `getApprovalStatus` 連接器方法留為 seam，接真規格時於工具 handler 換資料來源，上層不動。 |
| D3 | 身分綁定 | 兩個工具**一律以 `ctx.userId`/`ctx.tenantId` 為準**：`listMyRequests` 不收 userId 參數；`getApprovalStatus` 收 `oaRequestId` 但必須驗證該筆屬於呼叫者（否則查無），杜絕跨使用者窺探（Phase 1 review 的教訓）。 |
| D4 | 權限 | 唯讀查詢用 `oa:read`（BASE，全員可查自己的）；不新增 scope。 |

## 架構

### 1. Submissions store（`server/src/modules/workflow/submission.store.ts`）
比照既有 store（in-memory + `dataFile()` 持久化、每租戶上限 200 筆捨最舊）：

```ts
interface SubmissionRecord {
  oaRequestId: string;
  formId: string;
  formTitle: string;   // 記錄當下的表單標題（表單之後改名/刪除仍可顯示）
  userId: string;
  submittedAt: string;
}
submissionStore.record(tenantId, rec)
submissionStore.listByUser(tenantId, userId, limit?)  // 新→舊
submissionStore.find(tenantId, oaRequestId)           // 供 getApprovalStatus 查（回 undefined 表無）
submissionStore.clear()                               // 測試
```

**記錄點**：`form-submit.registry.ts` 的 `resolveSubmit` 包裝層（`notifyOnSubmit` 旁）——所有送出路徑（domain services + 通用送出）的唯一漏斗，成功後 best-effort 記一筆（失敗吞掉不影響送出）。

### 2. 兩個唯讀工具（加在 `oa.tools.ts`）
- **`oa.listMyRequests`**：input `{}`（身分取 ctx）；回 `[{oaRequestId, formTitle, submittedAt, current}]`——`current` 為即時算出的目前關卡摘要（如「直屬主管（待審）」或「已全部核准」）。`scopes:['oa:read']`、`agentExposed:true`、不稽核（唯讀）。
- **`oa.getApprovalStatus`**：input `{oaRequestId}`；先 `submissionStore.find` 並驗 `userId===ctx.userId`，查無或非本人→回「查無此申請」訊息（不拋 404，讓 LLM 能好好回話）；有→`getDefinition(tenantId, formId)` + `computeApprovals(stepDefs(def), submittedAt)` 回完整關卡列表。同上 scope/exposed。
- 進度重算細節：與現有送出時相同的時間推演（Demo 語意「隨時間自動核准」），查詢時以**當下時間**重算 → 幾天後再問會看到進度前進。表單定義已刪時 fallback：回「僅剩送出紀錄、無法取得關卡明細」。

### 3. Agent 接線
- **關鍵字**（0-token 路由）：`agent.task` keywords 加 `簽核進度`、`簽到哪`、`我的申請`、`申請進度`、`簽核狀態`、`催辦`。刻意用完整片語、**不用**裸「簽核」——避免把「簽核規定是什麼」這類知識問句搶走（該走 kb）。
- **System prompt** 加工作方式：查詢用這兩個工具；使用者要催辦時→用 `email.propose` 擬催辦信（出示草稿、待確認）；不確定收件人就問使用者。
- 催辦全程走既有寄信確認閘＋稽核，**零新機制**。

## 安全性質
- 只能查自己的：兩工具身分綁 ctx，`getApprovalStatus` 驗擁有者。
- 唯讀不稽核、無副作用；催辦寄信沿用 email.propose→確認→email.send（audit 已涵蓋）。
- store 記錄 best-effort，不影響送出。

## 測試策略
- store：record/listByUser（新→舊、只回本人）/find/上限捨舊/租戶隔離。
- 記錄點：resolveSubmit 成功後有記錄（含 formTitle）；store 拋錯不影響送出結果。
- 工具：listMyRequests 只回 ctx.userId 的；getApprovalStatus 本人可查（回關卡）、他人的 oaRequestId 回查無；agentExposed 出現在 availableFor。
- Agent e2e（fake LLM）：腳本呼 `oa_listMyRequests`（底線名）→ 回覆含單號。
- 路由：「我的申請進度」關鍵字 0-token 到 agent；「簽核規定是什麼」不被搶（留給一般路由）。
- 全部用新建租戶（隔離已就緒）。

## 非目標（v1）
- 不做「代簽/核准」動作（那是簽核者的事，且有副作用，需另議確認閘）。
- 不改 OAConnector 介面（真 OA 規格到位時再加 `getApprovalStatus?` 並於工具內優先採用）。
- 不做 admin 端申請總覽（先服務員工本人）。
