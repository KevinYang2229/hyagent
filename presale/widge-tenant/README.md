# 模擬租戶後端 + 嵌入 demo（widget 浮動按鈕）

在本機重現「第三方網站嵌入 HyAgent widget → 自動 SSO → 使用者免登入直接用」的完整流程。
widget 在右下角顯示**預設浮動按鈕**，點擊彈出聊天室。
這支服務模擬「**整合方（租戶）自己的後端 + 網站**」，也可當作交給整合方的**參考實作**。

> 想改成「用自己的按鈕開啟、藏掉浮動鈕」或「完全自建 UI」，見 [presale/sdk-custom-ui](../sdk-custom-ui)。

## 流程

```
瀏覽器開 http://localhost:4000（模擬對方網站）
   │
   ├─ 未登入 → 導到 /login，兩位模擬使用者二選一 → 發一個自家的 cookie session
   │     （規格 §5.2：Identity Endpoint 的身分一律由自家登入 Session 決定）
   │
   ├─ 注入 HyAgent widget：<script src="OA/sdk/widget.js" data-key=pk_ data-token-url="/api/mybot/identity">
   │
   ├─ 面板開啟後向宿主頁要身分（postMessage：identity:request）
   │     widget.js 才去打 GET /api/mybot/identity，後端以自家私鑰現簽一張（私鑰不出後端）
   │     憑證經 identity:response 回到面板，全程不進 URL
   │
   └─ widget 內的 OA 前端自動呼叫 OA 的 /auth/sso/exchange 換發 token
         → 使用者免登入，直接進對話
```

## 執行

前提：

- **server 在 `http://localhost:3000`**（API）→ `npm run dev:server`
- **client 在 `http://localhost:5173`**（提供 `widget.js`）→ `npm run dev:client`
- 有一個**已登記 Assertion 公鑰的租戶**，其 `allowedOrigins` 含 `http://localhost:4000`，
  並拿到它的 `pk_...` 填進 `.env`（見下方 `TENANT_PK`）
- Node **22.6 以上**（`@hyagent/sdk/server` 的進入點是 `.ts`，要靠 Node 的 TypeScript 型別剝離）

Windows 直接跑 [run_tenant.bat](run_tenant.bat)：會檢查 Node 版本與 workspace 相依、
沒有 `.env` 時從 `.env.example` 複製一份、健檢上面兩個服務，然後啟動。

```bat
presale\widge-tenant\run_tenant.bat
```

手動跑也行（從 repo 根目錄；`@hyagent/sdk` 靠 workspace 連結解析，
沒跑過根目錄的 `npm install` 會 `ERR_MODULE_NOT_FOUND`）：

```bash
node presale/widge-tenant/server.mjs
# 開瀏覽器
open http://localhost:4000
```

先在 `/login` 選一位使用者，再點右下角「Hyweb 小幫手」→ 應該**不會看到登入頁**，
直接進對話（身分＝SSO 帶入的那位）。

## 登出與換人登入（整合手冊 §5.3「這段一定要做」）

header 右上角有「登出」，換人則走「登出 → 回登入頁選另一位」，與一般網站相同。
登出是整合方最常漏掉的一段，所以 demo 讓它可以當場按：

| 按下去 | 租戶站做的事 | 頁面接著呼叫 | 該看到什麼 |
|--------|--------------|--------------|------------|
| 登出 | 刪掉 cookie session | `await OAAgent.logout()`（送出表單前） | 面板作廢 Session 並清掉自己網域的憑證；之後 `GET /api/mybot/identity` 一律回 **401**，widget 收到 401 不重試（§6.5），面板改走匿名／自行登入 |
| 再登入成另一位 | 發一張新的 cookie session | （不必額外做）面板上一位的 Session 已在登出時作廢，重走握手 | 簽出的 Assertion `sub` / `name` / `hyagent:profile` 整組換人；小幫手放大後的標題列跟著換 |

接線的程式碼在 [index.html](index.html) 最底下那段，約十行，可以直接照抄。

> 貴站若有「**不登出直接切換身分**」的功能（職務代理人、客服代操作、管理者 impersonate），
> 換完身分後要改呼叫 `OAAgent.refreshIdentity()`（手冊 §5.3 第二列），否則面板會留在前一位
> 身上。一般網站沒有這種功能，本 demo 也就不示範。

兩位使用者預設是 `507 測試員／財務部／協理` 與 `902 王小明／研發部／工程師`，
部門職稱刻意不同：小幫手放大後的標題列那串會整個變掉，不必看 console 也知道有沒有生效。

### 為什麼非做不可

面板的 Session 存在 **HyAgent 網域**的 `sessionStorage`，租戶站的程式碼碰不到它，導到登入頁
也不會讓它消失（同一個分頁重整同樣不會——面板已經有 Session 就不再重走握手）。而 Session 是
伺服器端有狀態的：只清瀏覽器那一份，等於留一張還能用的票在後端直到自然過期。

所以少了 `OAAgent.logout()`，畫面上人已經登出、小幫手裡還是上一位。想看那張票的下場，
到後台 → 該租戶 → **自動登入** → 「登入 Session」卡片：有正確呼叫時它會消失；沒呼叫的話它
還在，得手動按「作廢」對方才會被登出。

面板從沒被點開過也一樣要呼叫——`widget.js` 會為此先把 iframe 建起來，再請面板自己清。

## 怎麼看「它到底登入了誰、拿到什麼」

面板跑在 iframe 裡，畫面上只有放大後的標題列會顯示使用者名稱。本 demo 的載入碼已帶
`data-debug="1"`（[index.html](index.html)），整段握手會印在兩個地方：

**瀏覽器 console**（F12）

| 標記 | 內容 |
|------|------|
| `[hyagent:host]` | 宿主頁這一側：widget 初始化參數、`GET /api/widget/config` 回的租戶設定、Identity Endpoint 的 HTTP 狀態、**簽出來的 claims（`iss` / `sub` / `name` / `exp`）與 `kid`** |
| `[hyagent:panel]` | 面板那一側：①要求身分 →②收到憑證 →③送出換發 →④換發成功（Session 有效期）→⑤**`GET /api/auth/me` 回的登入者**，那份就是最終身分 |

`[hyagent:panel]` 的行來自 iframe，Chrome devtools 要把 console 的 context 切到面板那個 frame 才看得到。

**跑 server.mjs 的終端機**：每次簽發印一行，例如

```
[identity] 22:30:38 簽發給 測試員(507) {
  iss: '8e81d071394abb35',
  sub: '507',
  name: '測試員',
  'hyagent:profile': { companyName: '凌網', deptName: '財務部', jobPostName: '協理' },
  jti: 'f3c933a7-…',
  exp: '22:31:38'
}
```

面板的 ⑤ 那行（`GET /api/auth/me`）會回
`{ id: '507', name: '測試員', company: '凌網', department: '財務部', title: '協理' }`
——租戶沒在後台建人員目錄時，後端就採用 Assertion 帶來的身分（`name` + `hyagent:profile` 的
`companyName` / `deptName` / `jobPostName`，見規格 §4.2.3），小幫手放大後的標題列也會顯示這串。
若後台為該租戶建過 id=507 的人員資料，則以目錄為準。

憑證本身一律遮罩（只留前 8 碼與長度）後才輸出，但 claims 裡的使用者代號與姓名會完整印出——
那正是要看的東西。所以 `data-debug` 是整合期工具，交付給客戶的載入碼不要留。

## 設定

設定的來源是同目錄 `.env`（server.mjs 會自動載入；`run_tenant.bat` 首次執行會從
[.env.example](.env.example) 複製一份）。已存在的環境變數優先於 `.env`，所以也能臨時覆寫。

| 變數 | `.env.example` 的值 | 說明 |
|------|------|------|
| `PORT` | `4000` | 此模擬網站的埠 |
| `OA_ORIGIN` | `http://localhost:5173` | 載入 `widget.js` 與聊天面板 iframe 的網域＝**client**。填 server 的 3000 會 404 |
| `OA_API_ORIGIN` | `http://localhost:3000` | API 的來源＝**server**。留空＝沿用 `OA_ORIGIN` |
| `TENANT_PK` | （空，**必填**） | 租戶公開金鑰。每台機器不同，故不給預設值——見下方說明 |
| `TENANT_ID` | （必填） | 租戶 id，會成為 Assertion 的 `iss` |
| `TENANT_PRIVATE_KEY` | （留空） | 簽發用私鑰；留空時啟動當場產一組並把公鑰印在 console |
| `DEMO_USER_ID` / `DEMO_USER_NAME` | `507` / `測試員` | 登入頁第一位，成為 Assertion 的 `sub` / `name` |
| `DEMO_COMPANY_NAME` / `DEMO_DEPT_NAME` / `DEMO_JOB_POST_NAME` | `凌網` / `財務部` / `協理` | 第一位的組織欄位，包成 `hyagent:profile`（規格 §4.2.3）；留空的欄位不進 claims |
| `DEMO_USER2_*` | `902` / `王小明` / `凌網` / `研發部` / `工程師` | 登入頁第二位，欄位與上面同名對應（`DEMO_USER2_ID` / `_NAME` / `_COMPANY_NAME` / `_DEPT_NAME` / `_JOB_POST_NAME`） |

```bash
TENANT_PK=pk_xxx TENANT_ID=你的租戶id DEMO_USER_NAME=小明 \
  node presale/widge-tenant/server.mjs
```

### 怎麼拿 `TENANT_PK`

server 只存金鑰的 sha256，**pk 原文只在下列時機回傳一次，事後無法反查**：

- 在後台 <http://localhost:5174> 建租戶時
- 對既有租戶補發：`POST /api/admin/tenants/{id}/keys`，body `{"type":"publishable"}`

留空或填錯時，`run_tenant.bat` 會在啟動前就擋下來（拿 `GET /api/widget/config?key=` 驗），
不會等到你點開 widget 才看到「金鑰錯誤」。

## 正式環境對照

| demo 裡的東西 | 正式環境由誰做 |
|---------------|----------------|
| `/login` 選人、cookie session（記憶體 Map） | 整合方自家既有的登入機制。重點只有一個：Identity Endpoint 的身分**必須**由這個 session 決定 |
| 登出／換人時呼叫 `OAAgent.logout()` / `refreshIdentity()` | 整合方的頁面，一行都不能少（手冊 §5.3） |
| `GET /api/mybot/identity` 簽 Assertion | 整合方後端，依自家登入 Session 簽（私鑰留後端） |
| 注入 widget 的頁面 | 整合方的網站頁面 |
| Assertion 公鑰 | 整合方自行產生金鑰對後把**公鑰**給你，你在後台登記 |

> 安全：私鑰從不離開整合方環境，HyAgent 只持有公鑰；Assertion 短效（60 秒）且一次性。
