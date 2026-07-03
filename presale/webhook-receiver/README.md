# Webhook 接收端示範（獨立服務）

模擬「整合方接收 OA 表單結果回拋」的那一段。表單在 OA 送出後，OA 會 POST `form.submitted`
事件到這個服務；本服務示範接收端標準三步：**驗章 → 去重 → 快回 2xx**，並把結果印出來（模擬寫入對方系統）。

驗章用 SDK 的 `constructWebhookEvent`（`@oa-agent/sdk/server`）。

## 取得密鑰（二選一）

- **A. 手動**：先用管理 API 登記端點拿到 `whsec_…`，填到 `.env` 的 `WEBHOOK_SECRET`。
- **B. 自動**：`.env` 設 `ADMIN_API_KEY` + `TENANT_ID`，本服務啟動時會自動向 OA 管理 API
  登記自己（`RECEIVER_URL`）並取回 secret。

## 執行

```bash
# 從 repo 根目錄（OA server 需已啟動）
node examples/webhook-receiver/server.mjs
open http://localhost:4300       # 收件匣頁面
```

然後產生一筆事件（二選一）：

- **真人操作**：在示範網站（[tenant-backend](../tenant-backend) 或 [sdk-custom-ui](../sdk-custom-ui)）用**同一個租戶**完成一張表單送出。
- **一鍵觸發（免 LLM）**：`node examples/webhook-receiver/trigger.mjs` —— SSO → 建對話 → 填欄位 → 送出，立刻觸發一筆 `form.submitted`。

事件會出現在這個服務的 console，並在收件匣頁面 **<http://localhost:4300/>**（根路徑，不是 `/webhook`）顯示。
收件匣存記憶體，接收端重啟即歸零。

> 注意：webhook 是綁「租戶」的。登記端點時用哪個租戶，就只會收到那個租戶的表單送出事件。

## 接收端三步（程式重點）

```js
// 1) 驗章（用原始 body；失敗 → 400）
const event = constructWebhookEvent({
  payload: rawBody,
  signature: req.headers['x-oa-signature'],
  timestamp: req.headers['x-oa-timestamp'],
  secret: WEBHOOK_SECRET,
});
// 2) 去重（用 event.id，避免重試造成重複建單）
if (seen.has(event.id)) return res.writeHead(200).end();
// 3) 快回 2xx，重活丟背景（OA 對非 2xx 會重試）
res.writeHead(200).end('ok');
```

## 手動登記端點（方式 A 的 curl）

```bash
curl -X POST http://localhost:3000/api/admin/tenants/<TENANT_ID>/webhooks \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4300/webhook"}'
# 回傳的 data.secret 就是 WEBHOOK_SECRET
```
