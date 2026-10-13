# AI 回覆回饋機制設計

日期：2026-10-13
分支：`feature/reply-feedback`（從 `bugfix/block-markdown-image-exfil` 分出；沿用該分支的稽核分頁與後台稽核機制）

## 1. 目的與成功標準

讓使用者對每則 AI 回覆按讚或倒讚，並讓管理員據此找出問題、修正、追蹤處理結果，形成**由人把關的改善循環**。

本功能**不會**讓 Agent 自動從評價學習。評價不回灌 prompt、不做微調，理由：

- widget 公開嵌入客戶網站，評價可被灌票；回灌等於新增一條 prompt injection 管道。
- 範例含提問者的問答與知識庫內容，放進其他人的 prompt 會繞過知識庫 ACL、跨使用者洩漏。
- 回灌後無法驗證變好或變差。

**成功標準**

1. 網頁版（含 widget）與三個行動 App 的 AI 回覆都能讚／倒讚，倒讚可選原因與補充說明，可改評、可撤回。
2. 後台看得到問答全文、當時的檢索紀錄，能判斷是「沒檢索到」還是「檢索到但答錯」。
3. 管理員可從回饋一鍵以提問者身分重跑檢索測試，並把回饋標為已處理。
4. 評價不能偽造回答內容，也不能評價別人的對話。

**不做**：評測集與後台執行評測（下一期另開設計）、評價匯出、跨租戶總覽、評價回灌 prompt。

## 2. 伺服器：回覆編號與檢索紀錄

### 2.1 回覆紀錄

`Session` 新增：

```ts
replies?: ReplyRecord[]; // 只保留最近 20 則，超出捨最舊

interface ReplyRecord {
  id: string;            // replyId，randomUUID
  question: string;      // 觸發這則回覆的使用者訊息原文
  answer: string;        // 回覆全文
  serviceId: string;     // knowledge | agent | form | report | …（回覆當下的 activeServiceId）
  at: string;            // ISO
  trace?: ReplyTrace;
}
```

- `POST /conversations/:id/messages` 與建立對話時帶的第一則訊息（`POST /conversations` 的 `message`）產生的回覆會建立紀錄並在回應帶 `replyId`。
- 不建立紀錄的：開場問候、系統訊息、確認卡片執行結果（`/actions/:id/confirm`）、取消與表單送出結果。
- 20 則而非更多：回覆含 trace，對話資料以 JSON 整包存放，需控制大小。

### 2.2 檢索紀錄（trace）

```ts
interface ReplyTrace {
  model?: string;                 // LLMResult.model
  retrieval?: {
    query: string;                // 實際檢索用的問句（多輪改寫後）
    poolSize: number;             // 重排前候選數
    usedTables: boolean;          // 是否帶入資料表內容
    chunks: Array<{
      rank: number;               // 1-based
      id: string;
      title: string;
      url?: string;
      score?: number;
      excerpt: string;            // content 前 300 字
    }>;
  };
  tools?: Array<{ name: string; ok: boolean }>; // 依呼叫順序，不記輸入
  reportId?: string;
}
```

- 由各 AgentService 在 `AgentTurnResult` 新增選填的 `trace` 回傳，conversation service 寫進 `ReplyRecord`。
- 知識庫問答：填 `retrieval` 與 `model`。檢索失敗或查無資料時 `chunks` 為空陣列（這本身就是診斷依據）。
- 智慧代理：在 dispatchTool 記錄每次呼叫的工具名稱與成敗；`model` 取最後一次 LLM 呼叫。
- 報告：填 `reportId`。表單：不帶 trace。
- trace 只在伺服器與後台使用，**不回傳給前台**。

### 2.3 評價 API（使用者端）

```
PUT    /api/conversations/:id/replies/:replyId/feedback
DELETE /api/conversations/:id/replies/:replyId/feedback
```

PUT body：

```json
{ "rating": "up", "reason": "wrong", "comment": "…" }
```

- `rating`：`up` | `down`，必填。
- `reason`：`wrong`（答錯了）| `not_answered`（沒回答到問題）| `outdated`（資料過時）| `inappropriate`（內容不恰當）| `other`；選填，**只有 `down` 時接受**，`up` 帶了回 422。
- `comment`：選填，trim 後最多 500 字，同樣只有 `down` 時接受。
- 掛在既有的 `/api/conversations` 路由下，沿用 `resolveTenant → requireAuth → tenantRateLimit`；不掛月配額（不呼叫 LLM）。
- 對話須屬於目前的使用者與租戶（與既有對話 API 相同的檢查），`replyId` 須存在於該對話的 `replies`，否則 404。
- 同一使用者對同一則回覆只有一筆（upsert）。從 `down` 改為 `up` 時清除 reason 與 comment。改評會把處理狀態重設為 `open`。
- DELETE 撤回評價；不存在時也回 204（冪等）。
- 回應：PUT 回 `{ data: { rating, reason?, comment? } }`；DELETE 回 204。

## 3. 伺服器：評價儲存

### 3.1 資料

```ts
interface ReplyFeedback {
  id: string;              // randomUUID
  tenantId: string;
  userId: string;
  sessionId: string;
  replyId: string;
  serviceId: string;
  question: string;        // 快照
  answer: string;          // 快照
  trace?: ReplyTrace;      // 快照
  rating: 'up' | 'down';
  reason?: FeedbackReason;
  comment?: string;
  status: 'open' | 'resolved';
  resolutionNote?: string; // ≤200 字
  createdAt: string;
  updatedAt: string;
}
```

- 唯一鍵：`(tenantId, sessionId, replyId, userId)`。
- 快照在第一次評價時從 `ReplyRecord` 複製；之後改評只更新評價欄位，不重抓快照。
- 快照與對話分開保存：對話被保留政策清掉後，評價仍在。

### 3.2 持久化

- 新模組 `server/src/modules/feedback/`：`feedback.store.ts`、`feedback.routes.ts`（使用者端）、`feedback.admin.controller.ts`、`feedback.schema.ts`。
- 沿用既有 store 模式：記憶體 Map ＋ `file`（JSON 檔）或 `db`（Postgres write-through，開機載回）。
- db：新增 `server/db/migrations/0020_reply_feedback.sql` 與 `schema.prisma` 的 `ReplyFeedbackRow`；索引 `(tenant_id, created_at desc)`、`(tenant_id, status, rating)`，以及唯一索引 `(tenant_id, session_id, reply_id, user_id)`。
- 保存期限：`FEEDBACK_RETENTION_DAYS`（預設 180，範圍 1–3650），每日清除 `updated_at` 早於期限者；file 模式同樣清除。
- 刪除租戶時級聯清除（併入既有的租戶刪除清理流程）。

### 3.3 個資

問答快照可能含個資，只有平台管理員能透過後台讀取。快照不另外加密：完整對話紀錄本身以明文存放，單獨加密快照沒有實質效果；日後做個資遮蔽時一併處理。

## 4. 前台：網頁版（client，含 widget）

- 有 `replyId` 的 AI 回覆，在 `msg-meta` 列的複製鈕旁加 👍／👎 圖示鈕，樣式同 `.msg-action`，平時隨 hover 顯示。
- **已評價的那顆固定顯示並呈選取狀態**（理由同報告入口：帶狀態的元素不可隱藏）。
- 👍：送出 `up`；再按一次撤回。
- 👎：立即送出 `down`，並在該則回覆下方展開面板：
  - 原因選項（單選、可不選）：答錯了／沒回答到問題／資料過時／內容不恰當／其他。
  - 一行補充說明（≤500 字）。
  - 「送出」：以同一筆 PUT 補上 reason 與 comment。「略過」或點面板外：關閉，保留倒讚。
  - 再按一次 👎：撤回並關閉面板。
- 送出後原位短暫顯示「感謝回饋」。
- 樂觀更新：先改畫面再送；失敗還原並以既有錯誤提示呈現。
- `ChatMessage` 新增 `replyId?: string`、`feedback?: { rating; reason?; comment? }`。
- 文字放 `client/src/i18n.ts`，中英文。
- 新增 `client/src/FeedbackButtons.tsx`（按鈕＋倒讚面板），App.tsx 只負責接上。

## 5. 前台：行動 App（mobile/packages/app-core）

- `ChatMessage` 的 agent 型別新增 `replyId?`、`feedback?`；`turnReceived` 時帶入 `replyId`。
- `MessageBubble.tsx` 的 AI 回覆動作列加 👍／👎，**常駐顯示**（行動裝置沒有 hover）。
- 👎 開啟底部面板（RN `Modal`，與 `ConfirmModal` 同風格）：原因選項、補充說明、送出／略過。
- `endpoints.ts` 新增 `setFeedback`、`clearFeedback`；`ChatProvider` 提供 `rate(messageId, rating, detail?)`，樂觀更新、失敗還原。
- 三個 App（store、lib-one、space-me）都使用共用核心，不需各自改。

## 6. 共同規則

- 開場問候、系統訊息、確認卡片執行結果不顯示評價按鈕（沒有 `replyId` 即不顯示）。
- 重開對話後畫面不保留舊回覆的評價狀態；伺服器資料不受影響。
- 訪客（widget 未登入）可評價，計入既有限流。

## 7. 後台：「回饋」分頁

位置：租戶頁新增分頁 `?tab=feedback`。

### 7.1 統計

- 期間：7／30／90 天（預設 30）。
- 總評價數、按讚比例。
- 各服務的讚／倒讚數。
- 倒讚原因分布。
- 待處理（`status=open` 且 `rating=down`）數量醒目標示。

### 7.2 清單

- 每頁 10 筆、無限捲動，游標分頁（同稽核紀錄：固定高度捲動區、底部哨兵、固定表頭）。
- 篩選：評價（全部／倒讚／讚）、服務、原因、處理狀態；**預設「待處理的倒讚」**。
- 欄位：時間、使用者、服務、評價與原因、問題前段（單行省略）。

### 7.3 詳情

- 問題、回答、補充說明。回答**以純文字（`white-space: pre-wrap`）顯示，不渲染 markdown**：後台不需要排版，也避免回答內容中的連結或圖片被利用。
- 檢索紀錄：片段表格（名次、分數、標題、來源連結、節錄）、模型、呼叫過的工具。
- 初步判斷（一行，依序套用第一條成立者）：
  1. 知識庫回覆且 `chunks` 為空 → 「沒檢索到資料：知識庫可能缺這份內容，或提問者沒有權限看到」
  2. 原因為 `outdated` → 「資料可能過時：請更新下列來源」
  3. 原因為 `wrong` 且有片段 → 「有檢索到資料：請確認片段內容是否正確，或是模型理解錯誤」
  4. 其他 → 不顯示判斷
- 修正捷徑：
  - 「用這題測試檢索」：切到知識庫分頁的檢索測試，帶入問題，`asUserId` 設為提問者（既有 `query-test` 已支援）。
  - 片段來源網址可直接開啟。
- 處理狀態：待處理／已處理，可附處理說明（≤200 字）。

### 7.4 後台 API

```
GET   /api/admin/tenants/:id/feedback?rating&serviceId&reason&status&before&limit
GET   /api/admin/tenants/:id/feedback/stats?days=7|30|90
PATCH /api/admin/tenants/:id/feedback/:feedbackId   { status, resolutionNote? }
```

- 清單回傳 `{ items, nextCursor }`，`limit` 預設 10、上限 50。游標為 `(createdAt, id)` 編碼的不透明字串，依 `createdAt desc, id desc` 排序（改評不會讓項目在翻頁中跳位），翻頁中有新評價不重複不漏。
- PATCH 屬後台變更，由既有的 `adminAuditTrail` 自動寫入稽核紀錄。
- 統計在記憶體中依期間計算（每租戶資料量在保存期限內可控）；db 模式同樣以記憶體資料計算，開機載回期限內全部資料。

## 8. 錯誤處理

| 情況 | 回應 |
|---|---|
| 對話不存在或租戶不符 | 404 |
| 對話屬於他人 | 403（與既有對話 API 一致） |
| replyId 不在對話的回覆紀錄中（含已被擠出最近 20 則） | 404，前台提示「這則回覆已無法評價」 |
| `up` 帶 reason／comment、欄位格式錯誤 | 422 |
| 超過限流 | 429（既有） |
| 儲存失敗 | 500，前台還原按鈕狀態 |

## 9. 測試

- server：
  - 回覆紀錄：只有 messages 端點產生、保留最近 20 則、trace 內容（知識庫片段、代理工具序列）。
  - 評價 API：upsert、改評清除原因與重設狀態、撤回冪等、`up` 帶原因 422、他人對話與不存在的 replyId 404。
  - store：file／db round-trip、保存期限清除、租戶刪除級聯。
  - 後台：篩選、游標分頁、統計數字、PATCH 寫入稽核。
- client：`FeedbackButtons` 的讚、倒讚面板、撤回、失敗還原。
- mobile：reducer 帶入 replyId、`MessageBubble` 按鈕與面板、`ChatProvider.rate` 失敗還原。
- admin：回饋分頁的篩選、無限捲動、詳情判斷文字、「用這題測試檢索」帶入參數。

## 10. 部署

- db 模式須先套用 `0020_reply_feedback.sql`。
- 新環境變數 `FEEDBACK_RETENTION_DAYS`（選填）寫入 `server/.env.example` 與 `DEPLOY.zeabur.md`。
- 前台與後端須一併部署：舊版前台不認得 `replyId`，只是不顯示按鈕，不會出錯。
