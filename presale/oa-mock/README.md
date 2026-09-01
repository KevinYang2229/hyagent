# 模擬 OA 系統（給 `OA_CONNECTOR=http` 開發用）

在本機頂替「真 OA」，讓你不必等對方系統開通就能端到端跑完 **對話 → 送出 → 拿真單號**，
並直接看到「依 `oa.schema.json` 映射後**實際送出的 body**」。

> 串接說明見 [`docs/HANDOFF-OA-HTTP.md`](../../docs/HANDOFF-OA-HTTP.md)。

## 執行

```bash
# 終端機 A：mock OA
node presale/oa-mock/server.mjs                 # → http://localhost:4100

# 終端機 B：server 切到 http 模式
OA_CONNECTOR=http OA_BASE_URL=http://localhost:4100 npm run dev -w server
```

在對話中送出一張表單後，終端機 A 會印出：

```
[oa-mock] POST /api/leave-requests → OA-000001
  收到的 body（＝ oa.schema fieldMap 映射後的結果）：
    {
      "userId": "kevin",
      "leaveType": "annual",
      ...
    }
```

對話回的 `oaRequestId` 應為 `OA-000001`。**看到 `STUB-` 開頭就代表 `OA_CONNECTOR` 沒切到 `http`。**

## 端點

| Method | Path | 說明 |
| --- | --- | --- |
| POST / PUT | **任何路徑** | 送出。記錄 body，回 `{ requestId, status }`。刻意不寫死路徑——端點由各表單的 `oa.schema.json` 決定 |
| GET | `/api/leave-balances?userId=` | 假別剩餘時數。這個路徑**寫死在** [`http.connector.ts`](../../server/src/lib/oa/http.connector.ts) 的 `LEAVE_BALANCE_PATH`，不由 schema 驅動 |
| GET | `/__requests` | 檢視目前為止收到的所有送出（含 body） |
| DELETE | `/__requests` | 清空紀錄 |

## 故障注入（驗錯誤路徑用）

設定見 [`.env.example`](.env.example)，複製為 `.env` 後生效：

| 變數 | 用途 |
| --- | --- |
| `MOCK_STATUS` | 改成 `oa.schema.json` 的 `statusMap` **沒列**的值（如 `UNKNOWN`），驗證「未命中一律 fallback `pending`」 |
| `MOCK_FAIL_STATUS` | 一律回這個狀態碼。`400`＝欄位錯、`500`＝OA 掛了，驗證連接器丟 `AppError.internal` 的路徑 |
| `MOCK_DELAY_MS` | 回應前延遲。設 `16000` 可驗證連接器的 **15 秒逾時** |
| `MOCK_REQUIRE_TOKEN` | 要求 `Authorization: Bearer <值>`，對應 server 的 `OA_API_KEY`。驗證認證標頭有正確帶出 |

例：驗證 OA 回 500 時使用者看到什麼

```bash
MOCK_FAIL_STATUS=500 node presale/oa-mock/server.mjs
```

## 這支不做什麼

- **不驗證欄位內容**。它只回單號，不會告訴你 `fieldMap` 對不對——那要靠真 OA 的規格書比對。
- **不模擬簽核流程**。簽核狀態查詢在 `OAConnector` 介面裡還不存在（見 HANDOFF 第 5.1 節）。
- **不處理附件本體**。附件目前只送 metadata（見 HANDOFF 第 5.2 節）。
