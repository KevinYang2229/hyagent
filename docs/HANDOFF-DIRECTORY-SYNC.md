# 人員資料同步對接文件（OA → HyAgent）

> **狀態：端點已實作，每個租戶需由 HyAgent 管理員在後台「人員同步」分頁開啟後才會生效**（未開啟時回 `403 DIRECTORY_SYNC_DISABLED`）。本文件不指定任何環境已部署：正式對接前，請先向 HyAgent 團隊確認要使用的主機網址（下文的 `{hyagent-host}`），以及你們租戶的同步開關已開啟。

本文件給 OA 工程師，說明 OA 要改哪些地方，才能把人員資料同步到 HyAgent 的使用者目錄。

## 1. 整體運作

```text
員工從 OA 自動登入 ───────────► HyAgent：目錄沒有此人就建立
OA 人員異動、離職 ── webhook ─► HyAgent：更新或移除
OA 分批推送完整名單 ─ webhook ─► HyAgent：首次匯入與定期校正
```

規則只有一條：**OA 是姓名、部門、職稱、公司、Email 的資料來源。** 這些欄位收到 webhook 後，在同步開關開啟期間，HyAgent 後台不能手動修改。代理人與地區仍由 HyAgent 維護，不會被覆蓋。

HyAgent 只被動接收，不會主動向 OA 查詢資料，所以事件能否送達由 OA 負責（§6）。

原有的自動登入不受同步影響：同步失敗、撤銷同步金鑰，都不會影響員工登入。

## 2. OA 要做的事

| # | 項目 | 章節 |
| --- | --- | --- |
| 1 | 產生**同步專用**金鑰對，把公鑰交給 HyAgent 管理員 | §3 |
| 2 | 確認登入憑證帶齊人員欄位 | §4 |
| 3 | 實作簽章與發送 | §5 |
| 4 | 人員異動與離職時發送事件，失敗要重送 | §6、§7 |
| 5 | 上線前推送一次完整名單，之後定期校正 | §8 |

## 3. 同步專用金鑰

同步**不可**沿用自動登入的金鑰。兩組金鑰互不通用，同一把公鑰也無法同時登記在兩邊。

| 項目 | 要求 |
| --- | --- |
| 演算法 | ES256（EC P-256，建議）或 RS256（RSA ≥ 2048 bits）|
| 交付給 HyAgent | 只給公鑰（SPKI PEM 或 JWK）|
| 私鑰保管 | 只留在 OA 後端，建議放 KMS／Vault／環境變數，**不要**放進 repo |
| 數量 | 最多 2 把同時啟用（供輪替）|

在 OA 自己的環境產生金鑰對：

```bash
node hyagent-keygen.mjs ES256 ./keys-directory-sync
# 產出 hyagent-<kid>.public.pem（交給 HyAgent）與 .private.pem（OA 保管）
```

`hyagent-keygen.mjs` 是 HyAgent 於導入時提供的單一檔案，**請向 HyAgent 團隊索取**（也就是 HyAgent repo 內的 `sdk/bin/keygen.mjs`）。它沒有相依套件，不需 `npm install`，複製到任何裝有 Node.js 18 以上的機器就能執行。其他取得金鑰對的方式：

- 已安裝 `@hyagent/sdk`：`npx hyagent-keygen ES256 ./keys-directory-sync`。
- 使用 OpenSSL 或 KMS 產生：OpenSSL 不會計算 `kid`，請用 `node hyagent-keygen.mjs --kid <公鑰 PEM>` 取得，或以後台登記後顯示的值為準。

管理員會在 HyAgent 後台的「人員同步」分頁登記公鑰。**如果私鑰外洩**，請通知管理員撤銷，並產生新的一組。

**輪替：** 先登記新公鑰，讓新舊兩把並存，OA 改用新私鑰簽章並確認同步正常後，再請管理員撤銷舊公鑰。

## 4. 登入憑證要帶的欄位

員工第一次登入時，HyAgent 用自動登入憑證的內容建立資料，所以現有的憑證要帶齊下列欄位。這裡用的是**登入金鑰**，不是同步金鑰。

| 欄位 | 內容 |
| --- | --- |
| `sub` | 員工的不可變內部 ID，**必須和 webhook 的 `user.id` 相同** |
| `name` | 姓名 |
| `email` | Email |
| `hyagent:profile.deptName` | 部門名稱 |
| `hyagent:profile.jobPostName` | 職稱 |
| `hyagent:profile.companyName` | 公司 |

```ts
const assertion = issueAssertion({
  privateKey: process.env.HYAGENT_PRIVATE_KEY!, // 登入金鑰
  tenant: 'your-tenant-id',
  subject: user.id,
  profile: {
    name: user.name,
    email: user.email,
    'hyagent:profile': { deptName: user.deptName, jobPostName: user.title, companyName: user.company },
  },
});
```

> **`sub` 和 `user.id` 不一致時，同一個人會變成兩筆資料。** 請勿使用 Email 當 ID，因為 Email 可能變更或重新配發。

## 5. 發送請求

```http
POST https://{hyagent-host}/api/directory-sync/events
Authorization: Bearer <JWT>
Content-Type: application/json
```

### 5.1 簽章內容

每次請求都要**重新簽一張** JWT，包含重試時。

| 位置 | 欄位 | 值 |
| --- | --- | --- |
| header | `alg` | `ES256` 或 `RS256` |
| header | `typ` | `JWT` |
| header | `kid` | 公鑰依 RFC 7638 算出的值（keygen 檔名中的 `<kid>`）|
| payload | `iss` | 貴方的 Tenant ID |
| payload | `aud` | `hyagent:directory-sync`（固定值）|
| payload | `sub` | `directory-sync`（固定值，填其他值會收到 `401 INVALID_CLAIMS`）|
| payload | `iat`、`exp` | Unix 秒數；建議有效 60 秒，上限 300 秒 |
| payload | `jti` | 每次都不同的隨機字串，長度 8–128 |
| payload | `body_sha256` | 請求內容的 SHA-256（小寫 hex）|

header **不得**包含 `jku`、`jwk`、`x5u`、`x5c`。JWT 長度上限為 4096 bytes。請確認雙方主機都有 NTP 校時。

### 5.2 常見錯誤

- **雜湊要算「實際送出的那串 bytes」：** 先把內容序列化成字串，對它算雜湊，再原樣送出。如果 HTTP 函式庫重新序列化物件，雜湊會對不上。
- **ES256 簽章要 64 bytes 的 R‖S 格式：** 許多函式庫預設輸出 DER，會被拒絕。使用標準 JWT 函式庫通常已處理好。

### 5.3 範例（Node，不用 SDK）

```js
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function sendEvents(events) {
  const body = JSON.stringify({ events });
  const now = Math.floor(Date.now() / 1000);

  const header = b64url({ alg: 'ES256', typ: 'JWT', kid: process.env.HYAGENT_SYNC_KID });
  const payload = b64url({
    iss: process.env.HYAGENT_TENANT_ID,
    aud: 'hyagent:directory-sync',
    sub: 'directory-sync',
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    body_sha256: createHash('sha256').update(body).digest('hex'),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(process.env.HYAGENT_SYNC_PRIVATE_KEY),
    dsaEncoding: 'ieee-p1363', // ES256 必須是 R‖S；RS256 不需要這行
  }).toString('base64url');

  return fetch(`${process.env.HYAGENT_HOST}/api/directory-sync/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${header}.${payload}.${signature}`, 'content-type': 'application/json' },
    body,
  });
}
```

其他語言請使用標準 JWT 函式庫，並依 §5.1 設定 header 與 payload。

已使用 HyAgent SDK 時，也可以這樣簽：

```ts
const token = issueAssertion({
  privateKey: process.env.HYAGENT_SYNC_PRIVATE_KEY!, // 同步金鑰，不是登入金鑰
  tenant: process.env.HYAGENT_TENANT_ID!,
  subject: 'directory-sync',
  audience: 'hyagent:directory-sync',
  profile: { body_sha256: sha256Hex },
});
```

## 6. 事件格式

每次最多 **500 筆事件**，內容不超過 **1 MB**。

```json
{
  "events": [
    {
      "eventId": "evt_01",
      "type": "user.upserted",
      "occurredAt": "2026-11-03T08:00:00.000Z",
      "user": {
        "id": "E1024",
        "name": "王小明",
        "department": "資訊部",
        "title": "工程師",
        "company": "範例公司",
        "email": "e1024@example.com"
      }
    },
    {
      "eventId": "evt_02",
      "type": "user.deleted",
      "occurredAt": "2026-11-03T08:01:00.000Z",
      "userId": "E2048"
    }
  ]
}
```

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `eventId` | 是 | OA 產生的事件 ID，用於對照回應與追查 |
| `type` | 是 | `user.upserted`（新增或異動）或 `user.deleted`（離職）|
| `occurredAt` | 是 | **資料在 OA 異動的時間**（不是發送時間），UTC ISO 8601，含毫秒。超過 HyAgent 現在時間 5 分鐘會被拒絕（`INVALID_OCCURRED_AT`）|
| `user.id` | 是 | 等於登入憑證的 `sub`，最長 200 字元，前後空白會被去除 |
| `user.name` | 是 | 最長 200 字元，前後空白會被去除 |
| `user.department` | 是 | 最長 200 字元，前後空白會被去除 |
| `user.title`、`user.company` | 否 | 最長 200 字元 |
| `user.email` | 否 | 必須是合法 Email |
| `userId` | delete 必填 | 要移除的員工 ID，最長 200 字元，前後空白會被去除 |

**`user` 物件的欄位是封閉的。** 只接受上表的 `id`、`name`、`department`、`title`、`company`、`email`；多帶任何其他欄位（例如 `phone`、`origin`、`deputyIds`），整筆事件都會被拒絕（`INVALID_USER`），不會只忽略多餘的欄位。

**選填欄位沒有值時，請直接省略這個 key，不要送 `null`**（`"title": null` 同樣會被拒絕為 `INVALID_USER`）。

**文字不可含無法儲存的字元：** 含 NUL（`\u0000`）或單獨代理字元（沒有成對的 `\ud800`–`\udfff`）的文字會被拒絕（`INVALID_USER`；`userId` 則是 `INVALID_EVENT`）。從資料庫匯出時請先清理。

**一定要送完整資料。** `user.upserted` 是整筆更新：沒帶 `title`、`company`、`email` 代表清除該欄位，不是維持原值。

### 什麼時候發送

| OA 發生的事 | 事件 |
| --- | --- |
| 新進員工 | `user.upserted` |
| 姓名、部門、職稱、公司、Email 異動 | `user.upserted` |
| 部門改名 | 該部門每位員工各一筆 `user.upserted`，**並先通知 HyAgent 管理員**（見下）|
| 離職 | 先在 OA 停權，再發 `user.deleted` |
| 復職 | `user.upserted`，`occurredAt` 為復職時間（權限見下）|

> **部門改名會影響權限。** HyAgent 的角色以部門名稱對應，「資訊部」改成「資訊處」後，這些人會失去原部門的角色，直到管理員更新角色設定。請事先協調改名時間。

> **離職一定要先在 OA 停權。** HyAgent 會移除此人並立即登出，但如果 OA 繼續簽發登入憑證，這個人再次登入時又會被建立。

> **離職會清除個人權限，復職不會自動恢復。** `user.deleted` 會一併移除 HyAgent 管理員直接指派給此人的權限與角色。復職後，部門角色會依部門名稱自動生效；原本個人的權限與角色必須請管理員重新指派。

建議在 OA 異動的資料庫交易完成後才發送，例如先寫入 outbox 資料表，再由背景工作發送，避免「資料沒改成，事件卻已送出」或相反的情況。

## 7. 回應與重試

### 成功（200）

`200` 只代表請求已處理，**仍要檢查每筆事件的 `status`**。

```json
{
  "data": {
    "results": [
      { "eventId": "evt_01", "status": "applied" },
      { "eventId": "evt_02", "status": "stale" },
      { "eventId": "evt_03", "status": "rejected", "reason": "INVALID_USER" }
    ]
  }
}
```

| `status` | 意義 | OA 的處理 |
| --- | --- | --- |
| `applied` | 已套用 | 無 |
| `stale` | `occurredAt` 不晚於 HyAgent 已有的資料，已略過 | 無，重送或亂序時屬正常 |
| `rejected` | 這筆資料不合法或超過目錄上限（每租戶 10,000 人），其他筆不受影響 | 依 `reason` 修正後，以新的請求送出，不要無限重試 |

`rejected` 的 `reason` 只有四種：

| `reason` | 原因 | 修正方式 |
| --- | --- | --- |
| `INVALID_EVENT` | 缺 `eventId`，`type` 不是 `user.upserted`／`user.deleted`，或 `user.deleted` 的 `userId` 缺少、空白、超過 200 字元，或含 NUL／單獨代理字元 | 補齊或修正事件 |
| `INVALID_USER` | `user` 缺必填欄位、超過長度、`email` 格式錯誤、夾帶多餘欄位、選填欄位送了 `null`，或文字含 NUL／單獨代理字元 | 見 §6 |
| `INVALID_OCCURRED_AT` | `occurredAt` 缺少、不是合法時間字串，或比 HyAgent 現在時間晚超過 5 分鐘 | 檢查格式與主機時鐘 |
| `DIRECTORY_FULL` | 這是新員工，但目錄已達 10,000 人 | 聯絡 HyAgent 團隊，不要重試 |

### 失敗

失敗回應格式為 `{ "error": "<代碼>", "message": "…", "requestId": "…" }`。程式只判斷 `error`，`message` 僅供除錯。回報問題時請附上 `requestId`。

| HTTP | 常見代碼 | 原因 | 處理 |
| --- | --- | --- | --- |
| 400 | `INVALID_BODY`、`BODY_HASH_MISMATCH` | 格式錯誤、雜湊不符（§5.2）| 修正，不要原樣重試 |
| 401 | `UNAUTHORIZED` | 缺少 `Authorization: Bearer <JWT>` header | 修正請求 |
| 401 | `UNKNOWN_KID`、`KEY_REVOKED`、`INVALID_SIGNATURE`、`INVALID_AUDIENCE`、`INVALID_ISSUER`、`INVALID_CLAIMS`、`TOKEN_EXPIRED`、`TOKEN_REPLAYED` | 金鑰、簽章、時鐘、`jti` 或 `sub` 不是 `directory-sync` | 修正，並通知負責人 |
| 403 | `DIRECTORY_SYNC_DISABLED` | 此租戶未開啟同步 | 聯絡 HyAgent 管理員 |
| 404 | `TENANT_NOT_FOUND` | `iss` 查無此租戶（Tenant ID 填錯）| 核對 `iss`，不要原樣重試 |
| 413 | `TOO_MANY_EVENTS`、`ASSERTION_TOO_LARGE` | 超過大小限制 | 拆批 |
| 429 | `RATE_LIMITED` | 超過速率限制（見下）| 等到 `RateLimit` 的 `reset` 後重試 |
| 5xx、逾時 | | 暫時性失敗 | 重試 |

### 速率限制

預設每個來源 IP 在一個計數視窗內最多 **120 次請求**（HyAgent 端可用 `DIRECTORY_SYNC_RATE_LIMIT_MAX` 調整），視窗預設為 15 分鐘。被限制的請求也會計入。因為每次請求最多 500 筆事件，一個視窗可送的事件數遠大於 10,000 人的名單，正常使用不會碰到；只要把事件合併成批次、不要一個事件發一次請求。

`429` 回應的 `Retry-After` 是**上限**，固定為整個計數視窗的長度（預設 `900` 秒），不是距離恢復的剩餘秒數。**等到 `RateLimit` header 的 `reset`（標準草案格式，視窗剩餘秒數）就夠了**；沒有解析這個 header 時，等滿 `Retry-After` 也一定足夠。

### 重試規則

- **要重試：** `429`、`5xx`、逾時、網路錯誤。建議以指數退避（1 秒、2 秒、4 秒…，上限 1 小時）；`429` 等到 `RateLimit` 的 `reset` 即可（`Retry-After` 是上限）。持續失敗 24 小時就發出告警。
- **事件內容不變，但 JWT 要重簽：** 同一張 JWT 重送會收到 `TOKEN_REPLAYED`。逾時後即使 HyAgent 其實已處理過，重送也是安全的，舊事件會回 `stale`。
- **`user.deleted` 回 `5xx` 一定要重送：** 重送才會把沒做完的步驟（移除個人權限、登出）做完，即使這次回的是 `stale`。
- **順序：** 亂序送達不會出錯，HyAgent 以 `occurredAt` 判斷新舊，但 `occurredAt` 相同時，後到的那筆會被略過，所以時間請精確到毫秒。

## 8. 完整名單推送

上線前先推送一次，員工就不必先登入才能設定權限。之後建議**每週**重送一次，修正漏掉的異動。

1. 把在職員工分批，每批最多 500 筆 `user.upserted`，總上限 10,000 人。
2. `occurredAt` 使用該筆資料的最後異動時間；沒有這個欄位時，使用**開始讀取資料前**取得的時間。不要用發送當下的時間，否則可能蓋掉推送期間發生的異動。
3. 一批成功後再送下一批，並檢查每筆的 `status`。

> **名單不會刪人。** 沒出現在名單中的人不會被移除，離職一律要發 `user.deleted`。校正時，請一併重送近期離職人員的 `user.deleted`，補上可能漏掉的事件。

## 9. 驗收清單

**前置作業**

- [ ] 同步專用金鑰對已產生，公鑰已登記，私鑰未進 repo
- [ ] 登入憑證帶齊 §4 的欄位，且 `sub` 與 `user.id` 相同
- [ ] 已和 HyAgent 管理員核對部門名稱與角色設定

**同步行為**

- [ ] 新增員工後，HyAgent 目錄出現此人，部門正確
- [ ] 異動部門後，目錄更新，下一個請求就依新部門判定權限
- [ ] 不帶 `title` 送出後，HyAgent 的職稱被清除
- [ ] 發送 `user.deleted` 後，此人移出目錄，正在使用的 Session 被登出
- [ ] 復職（新的 `user.upserted`）後，部門角色生效，原本的個人權限沒有恢復
- [ ] 同一事件重送回 `stale`，資料不變
- [ ] 舊事件晚於新事件送達，資料維持最新

**錯誤處理**

- [ ] 用登入金鑰簽的同步請求被拒絕（`UNKNOWN_KID`）
- [ ] 竄改內容後收到 `BODY_HASH_MISMATCH`
- [ ] 重用同一張 JWT 收到 `TOKEN_REPLAYED`
- [ ] 模擬 HyAgent 回 `5xx` 或逾時，OA 會重新簽章並重試
- [ ] 持續失敗時，負責人會收到告警

**上線**

- [ ] 完整名單推送成功，沒有未處理的 `rejected`
- [ ] 確認員工仍可正常自動登入
