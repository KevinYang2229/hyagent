# SDK 自訂 UI 示範（第二個測試網站）

一個 landing page，**header 右上「線上客服」按鈕**點擊後開啟**完全自建的聊天室面板**——
用 `@hyagent/sdk`（headless）取得資料、自己渲染（自己的氣泡、欄位面板、機器人 header），
**不載入 widget、不用 iframe**。證明「用 SDK 取代 widget 後，UI 與觸發方式都可完全客製化」。

- 觸發：`#open-chat`（header）/ `#hero-chat`（hero）→ 開啟面板（首次開啟才初始化 SDK）。
- 結構：[index.html](index.html)（landing + 隱藏面板）、[login.html](login.html)（本站自家的登入頁）、
  [styles.css](styles.css)（樣式）、[app.ts](app.ts)（SDK 串接、開關、登出接線）。

## 與第一個 example（widget 版）的差異

| | [widge-tenant](../widge-tenant)（widget） | 本範例（SDK 自訂 UI） |
|--|--|--|
| 整合方式 | 貼 widget script，iframe 載入 OA 前端 | `@hyagent/sdk` headless，自己畫 UI |
| UI 客製化 | 只能改主題/語言/位置/標題 | **版面、元件、CSS 全自訂** |
| API 呼叫位置 | iframe 內（同源 OA） | 本頁面**跨網域**呼叫 OA（需 CORS 放行） |
| `OA_ORIGIN` 填 | client 的 5173（提供 `widget.js`） | **server 的 3000**（API 本身） |
| 打包 | 不用（widget.js 是純 JS） | 需用 esbuild 把 SDK + app.ts 打包 |

## 執行

前提：

- **server 在 `http://localhost:3000`**（API）→ `run_server.bat` 或 `npm run dev:server`。
  這版不載 `widget.js`，**不需要** client（5173）
- repo 根目錄跑過 `npm install`（`@hyagent/sdk` 靠 workspace 連結解析，`esbuild` 用來打包 app.ts）
- Node **22.6 以上**（`@hyagent/sdk/server` 的進入點是 `.ts`，22.6 ～ 22.17 需補 `--experimental-strip-types`，bat 會自動判斷）
- 有一個租戶，且：
  - `allowedOrigins` 含 `http://localhost:4200`（或 `*`）
  - 已登記 `.env` 私鑰對應的 Assertion 公鑰（見 [登記 Assertion 公鑰](#登記-assertion-公鑰)）
  - 它的 id 填進 `TENANT_ID`、pk 填進 `TENANT_PK`（見 [怎麼拿 `TENANT_PK`](#怎麼拿-tenant_pk)）

Windows 直接跑 [run_sdk_ui.bat](run_sdk_ui.bat)：會檢查 Node 版本與相依套件、沒有 `.env` 時從
`.env.example` 複製一份、檢查 `OA_ORIGIN` / `TENANT_ID` 有填、健檢埠占用與 server 的 `/healthz`、
驗證 `TENANT_PK`，然後啟動並自動開瀏覽器。

```bat
presale\sdk-custom-ui\run_sdk_ui.bat
```

手動跑也行（任何目錄皆可，`server.mjs` 讀的是自己同目錄的 `.env`）：

```bash
node presale/sdk-custom-ui/server.mjs
# 開瀏覽器：http://localhost:4200
```

先在 `/login` 選一位使用者 → 點右上「線上客服」→ 首次開啟時自動 SSO，歡迎詞會叫出登入者的名字
→ 直接在自訂介面對話、收集欄位、按「確認送出表單」。按 F12 可在 console 看到整段自動登入（見下方）。

## 運作

```
瀏覽器開 http://localhost:4200
   │
   ├─ 未登入 → 導到 /login，兩位模擬使用者二選一 → 發一個自家的 cookie session
   │     （規格 §5.2：Identity Endpoint 的身分一律由自家登入 Session 決定）
   │
   ├─ 取 Assertion ── GET /api/mybot/identity（後端用 SDK issueAssertion 以私鑰簽；未登入回 401）
   │     ↑ 由 SDK 依需要重複呼叫：首次換發、Session 到期前 60 秒、收到 401 時
   ├─ 載入 /app.js（esbuild 把 app.ts + @hyagent/sdk 打包成 ESM）
   │
   ├─ app.ts：createOAAgent({ key, assertion: fetchAssertion, apiBase }) → refreshIdentity()
   │    → me()（GET /api/auth/me，HyAgent 最終認定的登入者）
   │    → conversations.create / sendMessage / submit
   │    → 自己渲染訊息、suggestions、已收集欄位（全部自訂 DOM/CSS）
   │
   └─ 按「登出」→ app.ts 先 await oa.logout()（HyAgent 作廢 Session）→ 再送出 POST /logout
```

## 登出（SDK 整合模式的寫法，整合手冊 §5.3「這段一定要做」）

接線在 [app.ts](app.ts) 的 `logoutForm` 那段，可以直接照抄：攔下自家登出表單的送出，
先 `await oa.logout()`，再 `form.submit()`。聊天室從沒開過（還沒建 client）就照原本的表單流程走。

```ts
logoutForm.addEventListener('submit', async (e) => {
  if (!oa) return;
  e.preventDefault();
  await oa.logout();   // 從不 reject，網路不通也不會卡住導頁
  logoutForm.submit(); // 程式呼叫 submit() 不會再觸發 submit 事件
});
```

**為什麼非做不可**：headless 的 Session 只在本頁記憶體裡，導頁之後瀏覽器這份自然消失，
所以**漏掉這段畫面上看不出來**——但 HyAgent 後端那張還活著，直到自然過期。
要看差別，到後台 → 該租戶 → **自動登入** →「登入 Session」卡片：有呼叫 `oa.logout()` 時那一筆
會消失；把上面那段拿掉再登出一次，它就留在那裡。

> 與 widget 版的差別：widget 的 Session 存在面板網域的 `sessionStorage`，導頁也不會消失，
> 漏接的話換人後小幫手裡仍是上一位（見 [widge-tenant](../widge-tenant)）；headless 則是留下後端那張。
> 兩者都必須呼叫登出。換人走「登出 → 回登入頁選另一位」，與一般網站相同；
> 本站沒有「不經登出直接換人」的功能，所以不需要 `refreshIdentity()` 那段（手冊 §5.4）。

兩位使用者預設是 `507 測試員／財務部／協理` 與 `902 王小明／研發部／工程師`，部門職稱刻意不同：
換人登入後歡迎詞與 console 的登入者整串都會變，一眼看得出有沒有生效。

## 怎麼看「它到底登入了誰、拿到什麼」

本 demo 的 [app.ts](app.ts) 開了 `DEBUG = true`，整段自動登入會印在兩個地方。

**瀏覽器 console**（F12），標 `[sdk-custom-ui]`：

| 順序 | 內容 |
|------|------|
| 首次換發 | 開聊天室時呼叫 `refreshIdentity()` |
| Identity Endpoint 回應 | `GET /api/mybot/identity` 的 HTTP 狀態（未登入是 401） |
| 取得 Identity Assertion | 遮罩過的憑證、`kid`，以及**簽出來的 claims**（`iss` / `sub` / `name` / `hyagent:profile` / `exp`） |
| 換發成功 | SDK 已持有 HyAgent Session |
| 目前登入者 | **`oa.me()`（`GET /api/auth/me`）回的登入者，那份就是最終身分** |
| 登出 | `await oa.logout()` 前後各一行。登出會導頁，console 要勾 **Preserve log** 才留得住 |

之後 SDK 自動續期（Session 到期前 60 秒、收到 401）時，會再看到「Identity Endpoint 回應」與
「取得 Identity Assertion」兩行——那是 SDK 回頭呼叫 `fetchAssertion` 現取一張新的。

`me()` 回的是 `{ id, name, company, department, title }`。租戶沒在後台建人員目錄時，後端就採用
Assertion 帶來的身分（`name` + `hyagent:profile` 的 `companyName` / `deptName` / `jobPostName`）；
若後台為該租戶建過同 id 的人員資料，則以目錄為準——所以要確認身分，看 `me()` 而不是自己解 Assertion。

**跑 server.mjs 的終端機**：每次簽發印一行 `[identity] … 簽發給 測試員(507) { iss, sub, name, … }`，
登入、登出各印一行 `[session]`。

憑證本身一律遮罩（只留前 8 碼與長度）後才輸出，但 claims 裡的使用者代號與姓名會完整印出——
那正是要看的東西。所以 `DEBUG` 是整合期工具，**正式站請改成 `false` 或拿掉**。

## 設定

設定的來源是同目錄 `.env`（server.mjs 會自動載入；`run_sdk_ui.bat` 首次執行會從
[.env.example](.env.example) 複製一份）。已存在的環境變數優先於 `.env`，所以也能臨時覆寫。

| 變數 | `.env.example` 的值 | 說明 |
|------|------|------|
| `PORT` | `4200` | 此模擬網站的埠。改了之後租戶的 `allowedOrigins` 也要跟著加新網址 |
| `OA_ORIGIN` | `http://localhost:3000` | HyAgent API 的來源＝**server**，即 SDK 的 `apiBase`。和 widget 版相反，不是 5173 |
| `TENANT_PK` | （空，**必填**） | 租戶公開金鑰（pk 可放前端）。每台機器不同，故不給預設值——見下方說明 |
| `TENANT_ID` | （空，**必填**） | 租戶 id，會成為 Assertion 的 `iss`；換發時也用它查 Origin 白名單 |
| `TENANT_PRIVATE_KEY` | （留空） | 簽發用私鑰（PKCS#8 PEM）；留空時啟動當場產一組並把公鑰印在 console |
| `DEMO_USER_ID` / `DEMO_USER_NAME` | `507` / `測試員` | 登入頁第一位，成為 Assertion 的 `sub` / `name` |
| `DEMO_COMPANY_NAME` / `DEMO_DEPT_NAME` / `DEMO_JOB_POST_NAME` | `Beta Cloud` / `財務部` / `協理` | 第一位的組織欄位，包成 `hyagent:profile`（規格 §4.2.3）；留空的欄位不進 claims |
| `DEMO_USER2_*` | `902` / `王小明` / `Beta Cloud` / `研發部` / `工程師` | 登入頁第二位，欄位與上面同名對應（`DEMO_USER2_ID` / `_NAME` / `_COMPANY_NAME` / `_DEPT_NAME` / `_JOB_POST_NAME`） |

`*_COMPANY_NAME` / `*_DEPT_NAME` / `*_JOB_POST_NAME` 是 HyAgent 採用的使用者公司／部門／職稱——與
[widge-tenant](../widge-tenant) 帶的是同一組欄位，兩站差別只在 UI 怎麼畫。header 的「已登入」標示由目前
登入的那一位產生，登入頁的卡片由這兩組值產生。

> 既有的 `.env` 沒有 `DEMO_USER2_*` 也能跑：第二位會用上表的預設值。

> `server.mjs` 在變數完全沒設時另有內建預設值（`TENANT_PK` 為一把舊的 pk），本機 dev 不能用，請一律以 `.env` 設定。

### 怎麼拿 `TENANT_PK`

server 只存金鑰的 sha256，**pk 原文只在下列時機回傳一次，事後無法反查**：

- 在後台 <http://localhost:5174> 建租戶時
- 對既有租戶補發：`POST /api/admin/tenants/{id}/keys`，body `{"type":"publishable"}`（補發不會作廢既有的 key）

建租戶時 `allowedOrigins` 請填 `http://localhost:4200`。留空或填錯 pk 時，`run_sdk_ui.bat`
會在啟動前就擋下來（拿 `GET /api/widget/config?key=` 驗），不會等到你打開聊天室才看到「金鑰錯誤」。

### 登記 Assertion 公鑰

換發時 HyAgent 以 Assertion header 的 `kid` 找租戶登記的公鑰驗章，所以 `.env` 的私鑰和後台的公鑰必須是同一對。兩種作法：

- **固定一把（建議）**：`node sdk/bin/keygen.mjs ES256 <輸出目錄>` 產出一對金鑰與 kid。
  私鑰整段用雙引號包起來填進 `TENANT_PRIVATE_KEY`，公鑰貼到後台該租戶的「Assertion 公鑰」，
  並核對後台顯示的 kid 與 keygen 印出的一致。重啟不會變。
- **留空**：`server.mjs` 啟動時當場產一組並把公鑰與 kid 印在 console，複製貼到後台即可；但每次重啟都會換一組、得重貼。

> file 模式下公鑰存在 `OA_AGENT_DATA_DIR` 下的 `oa-agent-tenants.json`（租戶的 `publicKeys` 陣列）。
> 要直接改檔，**必須先停掉 server**：server 只在啟動時讀一次，而且執行中任何租戶異動都會把記憶體內容整份寫回、蓋掉手改的部分。
> 改檔也不會替你驗格式或算 kid，能用後台就用後台。

## 常見問題

聊天室「初始化失敗：…」後面接的是 server 回的訊息，對照如下：

| 症狀 | 原因 |
|------|------|
| `run_sdk_ui.bat` 說 server 不認 `TENANT_PK` | pk 已作廢或是別台機器的 pk，替租戶補發一把 |
| `run_sdk_ui.bat` 說 `TENANT_ID` 是空的 | 沒填租戶 id；server 照樣會啟動，但每張 Assertion 的 `iss` 都是空字串，換發必失敗 |
| 初始化失敗：`Failed to fetch`（Chrome / Edge 的網路錯誤訊息） | 被 CORS 擋：租戶 `allowedOrigins` 沒含 `http://localhost:4200`，或 `OA_ORIGIN` 不是 server（3000）、server 沒啟動 |
| 初始化失敗：查無此 Tenant 對應的 kid | 後台沒登記 `.env` 私鑰對應的公鑰，或 `TENANT_PRIVATE_KEY` 留空、重啟後換了一組 |
| 初始化失敗：公鑰狀態為 … 已不可使用 | 該公鑰在後台被停用或撤銷，改回 active 或換一把 |
| 初始化失敗：此來源不在該 Tenant 的允許清單內 | CORS 過了（別的租戶放行了 4200），但 `TENANT_ID` 指的租戶沒放行，兩者要是同一個租戶 |
| `run_sdk_ui.bat` 說埠 4200 已被占用 | 上一次的 server 還開著，關掉那個視窗，或改 `.env` 的 `PORT` |

> 關鍵：SDK 自訂 UI 是**跨網域**呼叫 OA，務必確認租戶 `allowedOrigins` 含本站網址，否則被 CORS 擋。
