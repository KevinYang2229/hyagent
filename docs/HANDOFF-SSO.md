# SSO handoff（Identity Assertion）

整合方在自己的後端完成登入後，以**自家私鑰**簽發一張短效的 Identity Assertion，交給 widget 或 SDK。
前端呼叫 `POST /api/auth/sso/exchange` 換取 HyAgent Session。

**HyAgent 只持有公鑰，不持有任何可偽造貴方使用者身分的秘密。** 私鑰從不離開貴方環境——
這是改造前的共享密鑰（`ssoSecret`）做不到的：那把密鑰雙方都有，我們有能力簽出任何一位使用者的身分。

> 完整規範見 [HyAgent客戶網站自動登入規格.md](HyAgent客戶網站自動登入規格.md)（協定正本，兩者若有出入以它為準）；
> 要交給整合方工程師照著做的操作版是 [HyAgent客戶端整合手冊.md](HyAgent客戶端整合手冊.md)。
> **（HyAgent 內部）** 實作過程與剩餘缺口見 [SSO-ASSERTION-PLAN-AND-RECORD.md](SSO-ASSERTION-PLAN-AND-RECORD.md)，不對外交付。

## 金鑰

| 項目 | 要求 |
| --- | --- |
| 演算法 | **RS256**（RSA ≥ 2048 bits）或 **ES256**（EC P-256） |
| 公鑰格式 | SPKI PEM 或 JWK，由貴方提供，我方在後台登記 |
| `kid` | 由公鑰依 RFC 7638 算出（JWK Thumbprint），**不需也不能自訂** |
| 數量 | 每租戶最多 **2 把**啟用中，且至少保留 1 把（供輪替） |
| 私鑰保管 | 留在貴方後端。建議 KMS / Vault / 環境變數，**不要**放進 repo |

產生金鑰對——**在貴方自己的環境執行**，我方不經手私鑰。兩種方式擇一：

```bash
# ① keygen CLI：零相依單一檔案，Node 18+ 直接跑，不需 npm install
node hyagent-keygen.mjs ES256 ./keys
#    產出 keys/hyagent-<kid>.public.pem（給我方登記）與 .private.pem（貴方保管，0600）
#    --kid <PEM 檔> 可核對既有金鑰的指紋，例如以 OpenSSL 產生時
```

```ts
// ② 已在用 SDK 時，直接呼叫
import { generateKeyPair } from '@hyagent/sdk/server';

const { publicKeyPem, privateKeyPem, kid } = generateKeyPair('ES256');
// publicKeyPem → 交給 HyAgent 登記；privateKeyPem → 留在貴方環境
```

## 簽章契約

| 欄位 | 要求 |
| --- | --- |
| algorithm | RS256 或 ES256（**不接受** HMAC 類演算法） |
| header | 需帶 `kid`；**不得**含 `jku` / `jwk` / `x5u` / `x5c` |
| iss | **貴方的 Tenant ID**（換發時據此決定租戶） |
| aud | `hyagent`（固定值） |
| sub | 宿主使用者唯一識別，不可空白 |
| iat / exp | 必填；`exp - iat` 建議 60 秒、上限 300 秒 |
| jti | 必填，每次不同。**一次性**——同一張送兩次第二次會被拒 |
| 其他 claims | `name`、`email`、`roles` 等自訂欄位原樣帶過，HyAgent 不解讀語意 |
| 大小 | 序列化後 ≤ 4096 bytes |

> `roles` 等角色欄位**不作為 HyAgent 的授權依據**，所有 SSO 登入一律換發 employee。
> 業務權限請在 HyAgent 後台以帳號／群組／套餐 scope 配置。

使用 SDK：

```ts
import { issueAssertion } from '@hyagent/sdk/server';

const assertion = issueAssertion({
  privateKey: process.env.HYAGENT_PRIVATE_KEY!,
  tenant: 'your-tenant-id',
  subject: authenticatedUser.id,
  profile: { name: authenticatedUser.name },
});
```

ES256 若要自行實作，注意簽章**必須**是 64 bytes 的 R‖S 串接（`dsaEncoding: 'ieee-p1363'`），
Node 預設的 DER 編碼會被拒。RS256 沒有這個陷阱。

## 換發

```http
POST /api/auth/sso/exchange
Content-Type: application/json
Origin: https://your-site.example.com

{"assertion":"<貴方後端簽發的 Assertion>"}
```

成功回 `201`：

```json
{ "data": { "sessionToken": "hyas_…", "expiresIn": 3600, "user": { "sub": "507", "name": "…" } } }
```

| 項目 | 說明 |
| --- | --- |
| 租戶來源 | Assertion 的 `iss`。`x-api-key` 只影響外觀設定與 CORS，**不參與身分判定** |
| `sessionToken` | 不透明字串，前端**不得**解析其內容。之後所有請求帶 `Authorization: Bearer <sessionToken>` |
| `expiresIn` | 預設 3600 秒，可逐租戶設定 300～28800 |
| 續期 | 沒有 refresh token。到期前重走一次簽發流程即可 |
| 來源檢查 | 嵌入 Widget 的頁面必須在該租戶的 Allowed Origins 內，否則 `ORIGIN_NOT_ALLOWED`，見下 |

失敗回應為 `{ "error": "<代碼>", "message": "…", "requestId": "…" }`。
常見代碼：`UNKNOWN_KID`（公鑰沒登記或 kid 不對）、`KEY_REVOKED`、`TOKEN_EXPIRED`、
`TOKEN_REPLAYED`（同一張送了兩次）、`INVALID_ISSUER`（`iss` 不等於 Tenant ID）、
`ORIGIN_NOT_ALLOWED`。

> **不得**把 `error` / `message` 直接顯示給終端使用者——那是給整合者看的診斷資訊。

### 來源檢查（Allowed Origins）

擋的是兩件事：**憑證被側錄後拿到別站兌換**，以及 **Widget 被未授權站台嵌入**。
它是縱深防禦的第三道（前兩道是 60 秒有效期與 `jti` 一次性），能擋瀏覽器裡的重放，
擋不住直接送 HTTP 請求的攻擊者——那種情境由前兩道負責。

判定依據依呼叫端而不同：

| 呼叫端 | 依據 | 你要登記的網域 |
| --- | --- | --- |
| Widget（iframe） | 面板讀到的 `document.referrer`，即**嵌入 Widget 的頁面** | 你放 `<script>` 的那些頁面網域 |
| headless SDK | 瀏覽器設定的 `Origin`，即**跑 SDK 的頁面** | 同上 |

兩者都是瀏覽器設定的值，嵌入方無法偽造。**不需要**、也不應該把 HyAgent 自己的網域
加進 Allowed Origins——那對所有租戶都一樣，加了等於讓這道檢查失效。

> **注意**：若你的頁面設了 `Referrer-Policy: no-referrer`，Widget 仍能運作——
> widget.js 會在它建立的 iframe 上明確指定 `referrerpolicy="origin"`，元素層級的設定
> 優先於頁面層級。但若你是**自行**嵌入面板 iframe 而未指定該屬性，面板讀不到來源，
> 換發會以 `ORIGIN_NOT_ALLOWED` 被拒（fail closed）。

## 結束 Session

```http
POST /api/auth/logout
Authorization: Bearer <sessionToken>
```

回 `204`。

## 把 token 交給 widget

**唯一的交付方式是 `data-token-url`**：指向宿主自家的 **Identity Endpoint**。

```html
<script src="https://{hyagent-host}/sdk/widget.js"
        data-key="pk_…"
        data-token-url="/api/mybot/identity"></script>
```

`src` 用 **HyAgent 提供給你的網域**（`{hyagent-host}`）——widget 與聊天面板都由 HyAgent 託管，
你不需要自行部署或代管任何檔案。`data-token-url` 才是你自己的端點：路徑由你決定
（它在你的網域裡，我們無從指定），`/api/mybot/identity` 是規格 §5.2 的範例路徑，照抄可省一次命名。

widget 需要身分時才向這支端點取一張**當下新簽發**的票：

```
GET <data-token-url>
credentials: include        ← 帶 cookie，由宿主自己的登入狀態決定發給誰
accept: application/json
cache: no-store
```

端點側的要求（規格 §5.2）：

| 項目 | 要求 |
| --- | --- |
| 方法 | `GET`，不改變狀態 |
| 認證 | **必須**以你自家的登入 Session（Cookie / Bearer）判定使用者。**不得**接受前端傳入的 user id 等身分參數 |
| 未登入 | 回 `401`，不簽發任何憑證 |
| 成功回應 | `200` + `application/json` |
| 快取 | **必須**帶 `Cache-Control: no-store` |
| CSRF | 同源請求瀏覽器會帶 `Sec-Fetch-Site: same-origin`，**建議**據此擋掉他站的簡單請求 |
| 速率限制 | 建議以使用者為單位，例如 60 次/分鐘 |

回應接受 `{"token":"<jwt>","expiresIn":300}`（規格格式），也相容 `{"assertion":…}`、`{"userToken":…}` 與包在 `{"data":{…}}` 裡的形狀。

端點**必須在宿主自己的後端**（Next.js route handler、Vercel Function、既有 API 皆可）：簽章金鑰放到瀏覽器等於把它公開。純靜態站台（無任何後端）沒辦法安全地做 SSO handoff，只能讓使用者在面板內自行登入。

端點架在別的網域也可以（`data-token-url` 收絕對網址），但那時要自行設好帶 credentials 的 CORS。

失敗處理（規格 §6.5）：`401` / `403` 視為「使用者未登入宿主網站」，不重試；`5xx` 與網路錯誤以指數退避重試 **1s / 2s / 4s** 共 4 次；單次請求等待上限 **10 秒**。全數失敗不會擋住面板 —— widget 在 console 留下警告並照常開啟，使用者改為自行登入。

### 為什麼沒有「靜態 token」這個選項

`data-user-token`（把簽好的字串寫死在 script 標籤上）**已移除**。票只有幾分鐘有效且是一次性的兌換券，靜態字串只代表「頁面渲染當下」那一瞬間的身分，在三種常見情況下必定失效：

| 情況 | 結果 |
| --- | --- |
| 使用者把分頁開著，過一陣子才點開面板 | 票早已過期 → 掉回自行登入 |
| 使用者按上一頁，或頁面由 bfcache 還原 | 同一張票被再次送出 → 重放而遭拒 |
| 頁面被瀏覽器或 CDN 快取 | 內嵌的票一併被快取，等同機敏資料外洩 |

仍帶 `data-user-token` 時 widget 會忽略它並於 console 警告。

## 憑證如何進到面板

widget.js（宿主頁）與面板 iframe 之間走 `postMessage`，**憑證不進 URL**：query string 會殘留在瀏覽器歷史、`Referer` header 與伺服器存取日誌這三個不受控的地方。

```
iframe → host   handshake          面板就緒
iframe → host   identity:request   要求宿主頁呼叫 Token Provider
host   → iframe identity:response  回傳憑證或錯誤
```

訊息信封為 `{ source: "hyagent", version: 1, type, requestId?, payload? }`；兩個方向都以具體 origin 為 `targetOrigin`（不使用 `"*"`），收訊端同時檢查 `event.origin` 與 `event.source`。宿主頁不需要為此寫任何程式碼 —— widget.js 已包辦，宿主只要提供 `data-token-url` 端點。

宿主頁仍可照舊接收 widget 事件（事件名與 detail 形狀未變）：

```js
window.addEventListener('oa-agent:submitted', (e) => { /* e.detail.submission */ });
```

## 租戶與權限

交換後的 Token 綁定該租戶。一般業務 API 的 API Key 必須屬於同一租戶，不能拿另一租戶的公開金鑰切換身份。內部帳密登入僅綁定 default。

平台管理員使用獨立 audience 的管理 Token。租戶 SSO 的 role=admin、manager 等值均不能取得平台管理 API 權限。業務角色請由 HyAgent 後台的帳號／群組／套餐 scope 配置。

## 續期與撤銷

**SSO 路徑沒有 refresh token。** 規格的續期模型是「到期前重走簽發流程」——
面板會自動向 `data-token-url` 再取一張新的 Assertion，整合方不需要處理。
（`POST /api/auth/refresh` 仍存在，但只服務 HyAgent 自己的帳密登入路徑。）

實際觸發的時機有三個，你的 Identity Endpoint 只要照常回一張**當下新簽發**的票即可：

| 時機 | 說明 |
| --- | --- |
| Session 到期前 60 秒 | 面板自行重走握手，使用者無感；不需要任何互動 |
| Session 被作廢而回 `401` | 撤銷 `kid` 或依 `sub` 作廢後，面板當場重取一張。使用者若已被停權，你的端點應回 `401`，面板隨即落回自行登入 |
| 使用者按登出 | 面板呼叫 `POST /api/auth/logout` 讓後端作廢該 Session，不只是清掉瀏覽器那一份 |

> 續期會**再打一次**你的 Identity Endpoint，所以它必須能被重複呼叫：每次現簽一張新的
> （新的 `jti`），不可回快取的同一張——那會被 `TOKEN_REPLAYED` 拒絕。
> 建議的速率限制（60 次/分鐘/使用者）對這個頻率綽綽有餘：一小時的 Session 正常只會續期一次。

headless SDK（`@hyagent/sdk`）的對應做法是把 `assertion` 傳成函式而非字串，
SDK 會在同樣的兩個時機自動呼叫它；另有 `refreshIdentity()` 與 `logout()` 可主動呼叫。

撤銷有兩個維度，都在 HyAgent 後台操作：

| 情境 | 動作 | 效果 |
| --- | --- | --- |
| 私鑰外洩 | 撤銷該 `kid` | 以該金鑰建立的**所有** Session 立刻失效，包含正常使用中的使用者 |
| 帳號停權 / 離職 | 依 `sub` 作廢 Session | 該使用者的所有 Session 失效 |

依 `sub` 作廢**必須**先在貴方系統停權，否則貴方的 Identity Endpoint 還會繼續簽發新憑證，
作廢完馬上又能登入。

租戶刪除後既有 Session 一併失效。公鑰撤銷不可復原——要恢復服務請上傳一把新的。

部署與資料庫 migration 見 [安全修正升級說明](SECURITY-FIXES.md)。
