# 交接：表單送出串接真 OA（`OA_CONNECTOR=http`）

> 對象：接手把表單送進真 OA 系統的開發者。
> 前置閱讀：[`README.md`](../README.md) 的「部署拓撲」一節、[`schemas/README.md`](../schemas/README.md)。
> 姊妹文件：[`HANDOFF-SSO.md`](HANDOFF-SSO.md)（身分那一半）。

## 0. 先講最重要的一件事

**連接器程式已經寫完了，你不該修改它。**

[`server/src/lib/oa/http.connector.ts`](../server/src/lib/oa/http.connector.ts) 是完成品：它負責 HTTP 傳輸（逾時、認證標頭、錯誤處理、log），
而「送到哪個端點、送哪些欄位、回應怎麼解讀」全部由**各表單的 `schemas/<formId>/oa.schema.json`** 驅動，
經 [`oa.mapper.ts`](../server/src/lib/oa/oa.mapper.ts) 這兩個純函式套用。

```
你要改的  →  schemas/<formId>/oa.schema.json     （每張表單一份，純 JSON）
你不該改  →  server/src/lib/oa/http.connector.ts  （傳輸層，與表單無關）
你不該改  →  server/src/lib/oa/oa.mapper.ts       （映射引擎，與表單無關）
你不該改  →  上層的 leave / business-trip / outing service（送出守門、驗證、簽核計算）
```

例外只有第 5 節列的三個缺口——那三處是**介面本身還沒有**的東西，需要動程式，且應先與專案負責人確認做法。

## 1. 資料流

```
使用者在對話中回「確認」
   ↓
conversation → resolveSubmit(formId)                       form-submit.registry.ts
   ↓  （leave / business-trip / outing 有專屬 service，其餘走通用送出）
service：validateAll(def, values) → 組出 source
   ↓
toolRegistry.invoke('oa.submitForm', { formId, oa: def.oa, source }, ctx)
   ↓  （scopes: ['oa:write']、audit: true → 每次送出都留稽核）
getConnector('oa') → OA_CONNECTOR=stub | http
   ↓
httpOAConnector.submitForm()
   ├─ buildOABody(oa.request, source)          ← fieldMap / constants
   ├─ fetch(`${OA_BASE_URL}${oa.endpoint}`)
   └─ parseOAResponse(oa.response, raw)        ← idField / statusField / statusMap
   ↓
{ oaRequestId, status, raw } → 回上層算簽核 → 回對話
```

## 2. `source` 有哪些欄位（決定 fieldMap 左邊能寫什麼）

`source` 是**表單值 merge 衍生欄位**，各表單不同。這是 `fieldMap` 的鍵能取用的完整集合：

| formId | source 內容 | 出處 |
| --- | --- | --- |
| `leave-request` | `{ ...values, userId, region, hours }` | [`leave.service.ts`](../server/src/modules/leave/leave.service.ts) |
| `business-trip-domestic` | `{ ...values, userId }` | [`business-trip.service.ts`](../server/src/modules/business-trip/business-trip.service.ts) |
| `outing-registration` | `{ ...values, userId }` | [`outing.service.ts`](../server/src/modules/outing/outing.service.ts) |
| 其他（含 Designer 自建） | `{ ...values, userId }` | [`form-submit.registry.ts`](../server/src/modules/conversation/form-submit.registry.ts) |

- `values` = 該表單 `data.schema.json` 的欄位，且**已通過 `validateAll`**（含跨欄商規）。
- `region`、`hours` 是請假專屬的衍生值：`region` 取自申請人 profile，`hours` 由 [`leave.hours.ts`](../server/src/modules/leave/leave.hours.ts) 依地區工時政策換算（排除午休）。
- **`source` 裡沒有的東西，`fieldMap` 就取不到**。真 OA 若需要部門代碼、成本中心之類的欄位，得先在對應 service 的 `source` 加上去——那是要動程式的，請先提出來討論，不要自己在 mapper 裡加邏輯。

## 3. `oa.schema.json` 契約

```jsonc
{
  "endpoint": "/api/leave-requests",   // 接在 OA_BASE_URL 之後（base 的結尾斜線會被去掉）
  "method": "POST",                    // 只支援 POST | PUT，省略視為 POST
  "request": {
    "fieldMap": {                      // "source 的鍵": "OA body 的鍵"
      "userId": "EmployeeNo",
      "leaveType": "LeaveTypeCode"
    },
    "constants": { "FormType": "LEAVE" }  // 固定欄位，直接併入 body
  },
  "response": {
    "idField": "requestId",            // 從 OA 回應取單號的欄位名
    "statusField": "status",           // 省略時用 "status"
    "statusMap": {                     // OA 狀態字串 → 本系統的 accepted|pending|rejected
      "OK": "accepted",
      "WAIT": "pending"
    }
  }
}
```

### 四條必須記住的隱含規則（都在 [`oa.mapper.ts`](../server/src/lib/oa/oa.mapper.ts)）

1. **`fieldMap` 同時是 allowlist**：沒列出的欄位**不會**送給 OA。想多送一個欄位就得加一行——這是刻意的，避免表單新增欄位時無聲地把內部資料外洩給 OA。
2. **值為 `undefined` 的欄位不帶**（key 完全不出現，不是送 `null`）。OA 端若把「缺鍵」和「null」當不同語意，要在 `constants` 補預設值。
3. **`constants` 後套用**，鍵相同時會覆蓋 `fieldMap` 的結果。
4. **回應解析很寬容**：`idField` 取不到會退回 `raw.id`，兩者都沒有才丟 `AppError.internal('OA response missing request id')`；`statusMap` 未命中一律 fallback `'pending'`。
   → 意思是 **OA 回了預期外的狀態字串不會報錯，只會安靜地變成「待處理」**。串接時請把 OA 的所有狀態值列全，否則問題會延後到使用者問「我的單怎麼一直在待處理」才爆出來。

## 4. 連接器的既有行為（不用你實作，但要知道）

| 行為 | 現況 | 位置 |
| --- | --- | --- |
| 逾時 | 15 秒（`AbortSignal.timeout`） | `REQUEST_TIMEOUT_MS` |
| 認證 | `OA_API_KEY` 有值 → `Authorization: Bearer <值>`；留空則不帶 | `authHeaders()` |
| 網路失敗 / 逾時 | log error → 丟 `AppError.internal('OA system request failed')` | `submitForm` |
| OA 回非 2xx | log error（含 status 與原始 body）→ 丟 `AppError.internal('OA system rejected request (HTTP xxx)')` | `submitForm` |
| 額度查詢失敗 | **降級回空陣列**，不阻斷對話（畫面就不顯示剩餘時數） | `getLeaveBalance` |
| Content-Type | 固定 `application/json` | `submitForm` |

**尚未實作、需要你判斷要不要補的：**

- **無重試**。網路抖一下就是送出失敗、使用者看到錯誤。
- **無 idempotency key**。若日後加重試，OA 端必須支援冪等，否則會產生重複單據。**加重試之前一定要先確認 OA 端的冪等機制**。
- **錯誤訊息不區分**。OA 回 400（欄位錯）和 500（OA 掛了）對使用者都是同一句話。前者其實應該把 OA 的訊息帶回對話讓使用者修正。

## 5. 三個目前對不上真 OA 的缺口

這三處是**介面層面就缺**的東西，不是填 schema 能解決的。動工前請先確認範圍與做法。

### 5.1 簽核狀態是假的（本次最大的一塊）

`OAConnector` 介面（[`types.ts`](../server/src/lib/oa/types.ts)）目前只有兩個方法：

```ts
export interface OAConnector {
  readonly name: string;
  submitForm(input: OASubmitInput): Promise<OASubmitResult>;
  getLeaveBalance?(userId: string): Promise<LeaveBalance[]>;
}
```

**沒有查詢簽核狀態的方法。** 現在 [`oa.tools.ts`](../server/src/modules/tools/oa.tools.ts) 的 `oa.listMyRequests` 與 `oa.getApprovalStatus`
是用 `computeApprovals(stepDefs(def), submittedAt)` **依送出時間推演**出來的假進度（Demo 每 15 秒推進一關），
資料來源是本地的 `submissionStore`，跟真 OA 完全無關。

串真 OA 時要做的：

1. 在 `OAConnector` 加一個選用方法（例如 `getApprovalStatus?(oaRequestId): Promise<ApprovalStep[]>`）。
2. `httpOAConnector` 實作它；`stubOAConnector` 維持時間推演（Demo 才跑得動）。
3. 改 `oa.listMyRequests` / `oa.getApprovalStatus` 兩支工具：連接器有這方法就走真查詢，沒有就 fallback 現行推演。
4. **身分綁定不能鬆**：現行 `oa.getApprovalStatus` 會比對 `rec.userId !== ctx.userId`，查無或非本人一律回「查無」，不洩漏他人單據是否存在。改成真查詢後這道門仍要在——不能因為 OA 回得出資料就直接吐給使用者。

端點該不該由 schema 驅動（每張表單查詢路徑可能不同）也請一併決定。

### 5.2 附件只有 metadata，沒有檔案本體

`attachments` 已在 leave / business-trip 的 `fieldMap` 裡，但 [`Attachment`](../shared/src/index.ts) 的形狀是：

```ts
{ id: string; name: string; mime: string; size: number; description?: string }
```

**沒有 URL、沒有 bytes。** 檔案本體存在 `attachmentStore`（記憶體 + `DATA_BACKEND=db` 時落 `attachments` 表）。
所以現在送給 OA 的 `attachments` 只是一串「檔名 + 大小」，OA 拿不到檔案。

需要確認：OA 端收附件的方式是 multipart 上傳、先傳檔拿 URL 再帶進表單、還是 base64 內嵌？
確定後才知道要在連接器加什麼（很可能需要在 `submitForm` 之前多一趟上傳）。

### 5.3 `getLeaveBalance` 的端點寫死在程式裡

```ts
const LEAVE_BALANCE_PATH = '/api/leave-balances';   // http.connector.ts
```

不由 schema 驅動（因為它不屬於任何一張表單）。真 OA 路徑不同就得改這一行常數。
若額度查詢還要帶其他參數（年度、公司別），也是改程式。可考慮改由 env 或設定檔提供。

## 6. 本機開發與驗收

### 6.1 用 mock OA 開發（不必等真 OA 開通）

```bash
# 終端機 A：mock OA（依 oa.schema.json 契約回應）
node presale/oa-mock/server.mjs                 # 預設 http://localhost:4100

# 終端機 B：server 切到 http 模式
OA_CONNECTOR=http OA_BASE_URL=http://localhost:4100 npm run dev -w server
```

mock server 會把收到的 body 印在 console，可直接對照 `fieldMap` 是否如預期。

### 6.2 端到端 curl

```bash
# 1. 登入取 token（dev mock 帳號；密碼見 server/.env 的 AUTH_DEV_PASSWORD，預設 oa1234）
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"kevin","password":"oa1234"}' | jq -r .data.accessToken)

# 2. 建對話並起首輪
CID=$(curl -s -X POST localhost:3000/api/conversations \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"message":"我明天要請特休一天，家裡有事"}' | jq -r .data.id)

# 3. 逐輪補欄位，直到出現確認摘要（status=confirming）
curl -s -X POST localhost:3000/api/conversations/$CID/messages \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"message":"確認"}' | jq .data
```

送出成功回的 `oaRequestId` 應為 **mock OA 給的單號**，不再是 `STUB-xxxxxxxx`。
看到 `STUB-` 開頭就代表 `OA_CONNECTOR` 沒切到 `http`。

### 6.3 測試

`oa.mapper.ts` 的純函式測試在 [`server/tests/oa-mapper.test.ts`](../server/tests/oa-mapper.test.ts)——**那是這份契約的可執行版本**，
改 mapper 行為前先看它，改完要讓它繼續綠。

```bash
npm test -w server -- oa-mapper          # 只跑 mapper
npm test                                 # 全部（server jest + admin/client/sdk vitest）
npm run typecheck && npm run lint        # CI 會跑，先自己跑過
```

> ⚠️ CI 紅了代表線上很可能也是壞的——Zeabur 的 CD **不看 CI 結果，push 即部署**。

## 7. 驗收清單

- [ ] 三張內建表單的 `oa.schema.json` 都對上真 OA 的欄位名與端點
- [ ] OA 的**所有**狀態值都列進 `statusMap`（漏列會安靜地變成 `pending`）
- [ ] `OA_CONNECTOR=http` 時未設 `OA_BASE_URL` 會 boot fail-fast（env 已有守門，確認沒被繞過）
- [ ] 送出成功：對話回真實 OA 單號，`submissionStore` 有紀錄，稽核有 `oa.submitForm` 一筆
- [ ] 送出失敗（OA 回 4xx/5xx、逾時）：使用者看到可理解的訊息，log 有完整 status 與 body
- [ ] 附件方案已確認並實作（5.2）
- [ ] 簽核狀態改為真查詢，且**非本人一律回「查無」**的身分綁定仍在（5.1）
- [ ] `oa-mapper.test.ts` 全綠；`npm run typecheck && npm test && npm run lint` 全綠
