# 本機架設指南（file 模式，零資料庫）

在一台乾淨的 Windows 開發機上，把 HyAgent 跑起來所需的全部步驟。
**不需要 Docker、不需要 PostgreSQL、不需要 Redis。**

適用情境：開發前端、改登入整合（SSO）、改表單 schema、看 API 行為。
需要 `DATA_BACKEND=db` 的情境（報告產出物落地、試算表精確圖表、稽核全史）不在本文範圍，見 [DEPLOY.zeabur.md](../DEPLOY.zeabur.md)。

---

## 一、前提檢查

只有一項硬性需求：

```powershell
node -v    # 需 >= 20（本文驗證環境為 v22.21.1）
npm -v
```

其餘皆非必要：

| 元件 | 需要嗎 | 說明 |
| ---- | ------ | ---- |
| Docker / WSL2 | ❌ | file 模式完全用不到 |
| PostgreSQL | ❌ | 只有 `DATA_BACKEND=db` 才需要 |
| Redis | ❌ | `bullmq` 只掛在 package.json，`server/src/` 裡零處使用 |
| Google Chrome | 選用 | 有裝才會登錄報告的 `pdf` 下載格式；沒裝只是少一種格式，`md` / `html` 照常 |

---

## 二、安裝相依

monorepo 用 npm workspaces，**在根目錄裝一次就好**，不要進子目錄各裝一次：

```powershell
npm install
```

這會一併跑 server 的 `prisma generate`（即使不用 db 模式也需要，程式有 import `@prisma/client`）。

---

## 三、建立 `server/.env`

repo 沒有附 `.env`（已被 .gitignore 排除），要自己建。
複製下面整段存成 `server/.env`：

```ini
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# 持久化後端：file = 記憶體 Map + JSON 檔
DATA_BACKEND=file
# JSON 檔存放目錄。不設就寫到 %TEMP%，清暫存／重開機可能整批消失（見第八節）
# OA_AGENT_DATA_DIR=C:/tmp/oa-agent-data

# JWT 密鑰（本機開發用，長度需 >= 32）
JWT_ACCESS_SECRET=dev_local_access_secret_min_32_chars_0001
JWT_REFRESH_SECRET=dev_local_refresh_secret_min_32_chars_0002

# 前台帳密登入的共用密碼
AUTH_DEV_PASSWORD=oa1234
AUTH_PASSWORD_LOGIN=auto

# 第一方前端來源（client 5173 / admin 5174）
CORS_ORIGIN=http://localhost:5173,http://localhost:5174
DEFAULT_TENANT_ORIGINS=*

# LLM：金鑰留佔位字串也能啟動，但送出對話訊息會失敗
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5
LLM_ROUTER_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_API_KEY=sk-ant-PLACEHOLDER-請換成真實金鑰

# 外部系統與寄信一律用 stub，不連任何外部服務
OA_CONNECTOR=stub
EMAIL_CONNECTOR=stub

# 管理 API / 後台登入（不設 = 後台停用、建不了租戶）
ADMIN_API_KEY=local_dev_admin_key_0123456789abcdef
ADMIN_PASSWORD=local_dev_admin_pw_123456
```

> **關於 `ANTHROPIC_API_KEY`**：env 驗證會 fail-fast，這個變數**不能留空**，否則連 `npm run smoke` 都跑不起來。
> 填佔位字串可以正常啟動並開發登入整合、widget、表單渲染；真的要對話才需要換成有效金鑰。
>
> **要改 `ADMIN_PASSWORD` 或任何 env**：dev server 是 `tsx watch src/index.ts`，它只 watch `src/`，
> **改 `.env` 不會自動重啟**，必須手動停掉再啟動。

---

## 四、先做離線驗證（不需任何金鑰）

```powershell
npm run smoke
```

預期輸出 7 個 ✓ 與「全部通過 ✅」。這支驗證 schema 引擎（必填偵測、選項驗證、跨欄商規、完成判定），
完全離線、不打 LLM。**它過了就代表 Node 環境與相依安裝沒問題。**

---

## 五、啟動三個服務

各開一個終端機，都在 repo 根目錄執行：

```powershell
npm run dev:server    # 後端 API      http://localhost:3000
npm run dev:client    # 對話前台      http://localhost:5173
npm run dev:admin     # 管理後台      http://localhost:5174
```

### 網址與登入資訊

| 網址 | 內容 | 登入 |
| ---- | ---- | ---- |
| http://localhost:5173 | 對話前台（使用者實際用的聊天介面） | `kevin` / `oa1234` |
| http://localhost:5174 | 管理後台（租戶／權限／知識庫／表單 Designer／稽核） | `local_dev_admin_pw_123456` |
| http://localhost:3000/api/docs/ | Swagger API 文件 | — |
| ~~http://localhost:3000/~~ | **404，這是正常的** | — |

> **3000 沒有 UI。** server 是純 API，[server/src/app.ts](../server/src/app.ts) 裡沒有掛任何 `express.static`，
> 前後端完全分離。3000 上唯一的網頁是 `/api/docs/`，**尾斜線不能省**（少了會 301）。

### 確認真的起來了

```powershell
curl.exe http://localhost:3000/healthz
# {"status":"ok","llm":{"provider":"anthropic","model":"claude-sonnet-4-5"}}

curl.exe http://localhost:3000/readyz
# {"status":"ready","backend":"file","checks":{"db":"ok"}}
```

> PowerShell 裡請用 **`curl.exe`**，不要用 `curl`——後者是 `Invoke-WebRequest` 的別名，參數語法完全不同。

---

## 六、（選用）架設客戶網站登入整合 demo

要改 SSO handoff 這塊時，再多做這兩步。

### 6-1. 建一個租戶並登記 Assertion 公鑰

最省事的作法是從**後台 5174 的 UI** 建立租戶，再於設定頁貼上公鑰。要走 API 的話（PowerShell）：

```powershell
$body = @{
  name           = "integration-test"
  allowedOrigins = @("http://localhost:4000", "http://localhost:4200")
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/admin/tenants `
  -ContentType "application/json" `
  -Headers @{ "x-admin-key" = "local_dev_admin_key_0123456789abcdef" } `
  -Body $body
```

回應裡記下 `publishableKey`（`pk_` 開頭那串）與租戶 `id`。**pk 只會出現這一次**——
store 只存金鑰的 sha256，之後從 API 或資料檔都反查不到原文。租戶 `id` 之後要當 Assertion 的 `iss`。

公鑰的部分：直接跑 `node presale/widge-tenant/server.mjs`，它未設 `TENANT_PRIVATE_KEY` 時會
當場產一組金鑰並把公鑰印在 console，複製貼到後台設定頁即可（重啟會換一組，正式環境請設進 `.env`）。

弄丟了不用重建租戶，補發一把就好：

```powershell
# 租戶 id 用 GET /api/admin/tenants 查
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/admin/tenants/<租戶id>/keys `
  -ContentType "application/json" `
  -Headers @{ "x-admin-key" = "local_dev_admin_key_0123456789abcdef" } `
  -Body '{"type":"publishable"}'
```

> `allowedOrigins` 一定要含 demo 站的來源，否則瀏覽器會被 CORS 擋下。

### 6-2. 啟動模擬客戶網站

設定放在 `presale/widge-tenant/.env`（`server.mjs` 會自動載入）。Windows 直接跑：

```powershell
presale\widge-tenant\run_tenant.bat
```

第一次執行會從 [.env.example](../presale/widge-tenant/.env.example) 複製一份 `.env` 後停下來，
把 6-1 拿到的 `pk_...` 填進 `TENANT_PK`，再跑一次。bat 會在啟動前檢查 Node 版本、
workspace 相依、5173 / 3000 是否活著，以及 **`TENANT_PK` 是否被 server 認得**——
金鑰不對會當場擋下，不會等到你點開 widget 才看到「金鑰錯誤」。

`.env` 的關鍵三行：

```ini
OA_ORIGIN=http://localhost:5173      # widget.js 由 client 提供，不是 server
OA_API_ORIGIN=http://localhost:3000  # API 打 server
TENANT_PK=pk_...                     # 6-1 拿到的那串，每台機器不同
```

不想用 bat 也可以自己帶環境變數（**環境變數優先於 `.env`**）：

```powershell
$env:TENANT_PK = "貼上剛才的 pk_..."
$env:DEMO_USER_ID = "emp-12345"
$env:DEMO_USER_NAME = "王小明"
node presale/widge-tenant/server.mjs
```

開 http://localhost:4000 → 點右下角浮動按鈕 → **應該不經登入頁直接進對話**，身分是 SSO 帶入的使用者。

> **`OA_ORIGIN` 必須指向 5173**。widget.js 的實體在 [client/public/sdk/widget.js](../client/public/sdk/widget.js)（對外路徑 `/sdk/widget.js`），
> 由 client dev server 提供；指到 3000 會拿到 404，widget 根本載不進來。

### 6-3. 換票鏈路

四段流程，簽章契約與端點要求見 [HANDOFF-SSO.md](HANDOFF-SSO.md)：

```
面板向宿主頁要身分（postMessage：identity:request）
  → widget.js 打 GET /api/mybot/identity，客戶後端以自家私鑰現簽一張 Assertion
     （RS256 或 ES256 / iss=Tenant ID / aud=hyagent / exp - iat <= 300 秒）
  → widget.js 以 postMessage（identity:response）把票交給面板，憑證全程不進 URL
  → 面板呼叫 POST /api/auth/sso/exchange，以租戶公鑰驗章後換回不透明 sessionToken
     （租戶由 Assertion 的 iss 決定，pk 只影響外觀與 CORS；role 一律 employee）
```

可以直接看客戶後端那一段：

```powershell
curl.exe http://localhost:4000/api/mybot/identity
# {"token":"eyJhbGciOiJIUzI1NiIs...","expiresIn":300}
```

---

## 七、其餘 presale 範例站（選用）

都是單檔 Node 腳本，`node <路徑>` 即可跑。用到 `@hyagent/sdk` 的那幾支靠 workspace 連結解析，
**沒在 repo 根目錄跑過 `npm install` 會 `ERR_MODULE_NOT_FOUND`**；另外 `.ts` 進入點需要 Node 22.6 以上。

| 指令 | 埠 | 內容 | 相依 |
| ---- | -- | ---- | ---- |
| `node presale/widge-tenant/server.mjs` | 4000 | 模擬客戶網站 + SSO 免登入 | `@hyagent/sdk` |
| `node presale/widge-public/server.mjs` | 4001 | 純前端嵌入（無 SSO，面板內自行登入） | 無 |
| `node presale/oa-mock/server.mjs` | 4100 | 模擬 OA 系統，可頂替真 OA | 無 |
| `node presale/sdk-custom-ui/server.mjs` | 4200 | 客戶完全自建 UI（用 SDK，不用內建 widget） | `@hyagent/sdk`、`esbuild` |
| `node presale/webhook-receiver/server.mjs` | 4300 | webhook 收件匣 | `@hyagent/sdk` |

要把表單真的送進 mock OA，改 `server/.env` 兩行後重啟 server：

```ini
OA_CONNECTOR=http
OA_BASE_URL=http://localhost:4100
```

---

## 八、file 模式下的限制

資料落在一批 `oa-agent-*.json`，重啟會還原（**預設寫在系統暫存目錄，不是 repo 裡**，見下一小節）。
以下是與 `db` 模式的實際差異：

| 項目 | file 模式行為 |
| ---- | ------------- |
| 租戶 / API Key / Assertion 公鑰 | ✅ 寫 `oa-agent-tenants.json`，重啟保留 |
| 對話 session / 送出紀錄 | ✅ 寫 JSON，重啟保留 |
| 稽核紀錄 | ⚠️ 每租戶只留最近 500 筆（[audit.store.ts:24](../server/src/modules/audit/audit.store.ts#L24)）；db 才留全史 |
| 知識庫檢索 | ✅ 可用，走 `retriever.staticIndex`（JS 算餘弦）；embedding 仍需 `OPENAI_API_KEY` |
| 報告產出物 | ❌ 只在記憶體，**重啟即失效**（狀態查得到、下載 404） |
| 試算表精確圖表 | ❌ `knowledge_tables` 僅 db 後端才有 |

### 資料檔放在哪：`OA_AGENT_DATA_DIR`

`file` 模式的 JSON 檔**不在 repo 裡**。路徑的唯一決定點是
[data-dir.ts:12-14](../server/src/lib/data-dir.ts#L12-L14)：

```ts
path.join(process.env.OA_AGENT_DATA_DIR ?? os.tmpdir(), name)
```

沒設這個變數就落在作業系統暫存目錄——Windows 是 `%TEMP%`
（通常是 `C:\Users\<你>\AppData\Local\Temp\`）。
server 啟動時的 `tenants restored from disk` 就是從那裡讀回來的。

它是**整批開關**，一設全部跟著搬，所有 `file` 後端的落地檔都在同一層目錄底下：

| 檔案／目錄 | 內容 |
| ---------- | ---- |
| `oa-agent-tenants.json` | 租戶、API Key（sha256）、Assertion 公鑰 |
| `oa-agent-auth-sessions.json` | HyAgent Session（token 只存 sha256、sub 加密） |
| `oa-agent-sessions.json` | 對話 session |
| `oa-agent-submissions.json` | 表單送出紀錄 |
| `oa-agent-forms.json` | 各租戶的表單定義 |
| `oa-agent-audit.json` | 稽核（每租戶最近 500 筆） |
| `oa-agent-usage.json` | LLM 用量／配額計數 |
| `oa-agent-webhooks.json` | webhook 端點 |
| `oa-agent-scope-policy.json` | 權限 scope 政策 |
| `oa-agent-security-claims/` | 防重複送出的 claim（一個 claim 一個空檔） |
| `notification-reads/` | 站內通知已讀狀態（租戶＋帳號雜湊檔名） |

#### 怎麼設

寫在 `server/.env` 就會生效，不必另外設系統環境變數：

```ini
OA_AGENT_DATA_DIR=D:/oa-agent-data
```

原因是這些 store 都先 `import` 了 `@/config/env`，而該檔第一行是 `import 'dotenv/config'`；
ESM 會先跑完整個 import 區塊才執行模組主體的 `dataFile(...)`，所以 dotenv 一定比路徑解析早。

臨時想用別的目錄跑一次，也可以只在該次啟動掛上環境變數：

```powershell
$env:OA_AGENT_DATA_DIR = 'D:\oa-agent-data'; npm run dev:server
```

#### 四個實際會踩到的點

1. **路徑要用 Windows 寫法。** `C:/...` 或 `C:\...` 都可以，但**不能寫 Git Bash 的 `/c/...`**——
   Node 不認得，會被當成相對路徑接到磁碟根目錄下（實測變成 `D:\c\Users\...`），
   然後開機讀不到舊資料、靜悄悄地從空的開始。
2. **改了要手動重啟。** `dev:server` 是 `tsx watch src/index.ts`，只 watch `src/`，改 `.env` 不會重啟。
3. **舊資料不會自己搬。** 換目錄＝換一份空資料，租戶、API Key、公鑰全要重建。
   要保留就先把舊的 `oa-agent-*.json` 從 `%TEMP%` 複製到新目錄再啟動。
4. **它不在 `env.ts` 的 zod schema 裡**（是 `process.env` 直讀），所以**打錯字不會 fail-fast**，
   只會安靜地沿用 `%TEMP%`。改完建議看一眼新目錄有沒有生出 `oa-agent-tenants.json`。

#### 建議設定的情境

- **本機開發想讓租戶／SSO 設定留得住。** 放 `%TEMP%` 遇到系統清暫存就整批消失，
  之前建的測試租戶和它的公鑰得重建一次。
- **跑過測試之後資料怪怪的。** 測試已用 [setup-env.ts:14](../server/tests/setup-env.ts#L14)
  為每個 jest worker 開獨立暫存目錄隔離；但那是 `??=`，
  **若你已在 shell 掛了 `OA_AGENT_DATA_DIR`，測試就會沿用你那個目錄並寫進去**。
  要隔離就別用系統環境變數掛，寫在 `server/.env` 即可（測試不讀 dev 的 `.env` 路徑設定）。
- **正式部署用 `file` 模式。** 必須指到持久磁碟，否則容器重佈即歸零；
  多程序／多主機共用時 `file` 本來就不成立（各自一份檔案），應改 `DATA_BACKEND=db`——
  防重複送出的 claim 尤其要注意，見 [SECURITY-FIXES.md](SECURITY-FIXES.md)。
  `NODE_ENV=production` 下這個組合另需明示 `ALLOW_FILE_BACKEND_IN_PRODUCTION=true`，
  否則 boot 直接失敗（見下節）。

#### 別跟 `KNOWLEDGE_INDEX_DIR` 搞混

兩個變數互不相干：

| | `OA_AGENT_DATA_DIR` | `KNOWLEDGE_INDEX_DIR` |
| --- | --- | --- |
| 管什麼 | 上表那 10 個 store 的落地檔 | 知識庫向量索引 `knowledge-index.<tenantId>.json` |
| 預設值 | `os.tmpdir()`（`%TEMP%`） | `data`（即 `server/data/`） |
| 基準 | 絕對路徑 | 相對 `process.cwd()`（[index-path.ts:6](../server/src/modules/knowledge/index-path.ts#L6)） |
| 是否經 zod 驗證 | ❌ `process.env` 直讀 | ✅ [env.ts:116](../server/src/config/env.ts#L116) |

設了 `OA_AGENT_DATA_DIR` **不會**把知識庫索引搬過去，反之亦然。

### 關於 `DATA_BACKEND` 的切換

它是**全域單一開關**（[env.ts:16](../server/src/config/env.ts#L16) 的 `z.enum(['file','db'])`），
所有 store 一起切，不能 per-store 混搭。

兩種模式的主體**都是記憶體 Map**，差別只在寫到哪裡，所以 db 不會比較慢——讀取一律打記憶體。
唯一真正走不同程式路徑的是知識庫檢索（`file` 用 JS 算餘弦，`db` 用 pgvector SQL）。

切換時的三個陷阱：

1. **資料不會自動搬過去。** [server/scripts/](../server/scripts/) 只有 `knowledge-migrate-to-db.ts` 一支搬遷工具，
   租戶／對話／稽核等 store 沒有 file→db 腳本——測試租戶和它的公鑰得重建。
2. **切 db 前必須先套 DDL。** `initKnowledgeStore()` 在 fail-fast 區塊裡，沒套 `0005_knowledge.sql` 就用 db 啟動，
   **整台 server 起不來**，不是知識庫失效而已。
3. **舊 JSON 檔會留在原地但不再被讀。** 哪天切回 file，讀到的是切走當下那份舊快照。

#### `production` + `file` 需明示單副本

`NODE_ENV=production` 且 `DATA_BACKEND=file` 時，server **開不起來**，訊息如下：

```
DATA_BACKEND=file assumes a single replica and is refused in production.
Set DATA_BACKEND=db (with DATABASE_URL), or set ALLOW_FILE_BACKEND_IN_PRODUCTION=true
if this deployment really runs exactly one replica backed by persistent storage.
```

擋的不是 file 模式本身（單副本 + 持久磁碟是合法部署），而是**沒人察覺的多副本**：
file 模式的記憶體 Map 就是 primary、落檔靠 `wx` 當鎖、`kid` / `sub` 索引開機才重建，
三者都只在單副本成立。跑兩個副本不會有任何錯誤訊息，只會各自為政——
在 A 副本撤銷的公鑰，B 副本到重啟前都還繼續接受（規格 §2.6 的「快取 TTL ≤ 30 秒」
在這個情況下等同無限），使用者的 HyAgent Session 也會隨負載平衡時有時無。

確定只有一個副本就設 `ALLOW_FILE_BACKEND_IN_PRODUCTION=true`；要擴副本請改 `db`。
這個變數只認 `true` / `false` / `1` / `0`，其餘值一律 fail-fast——
它是安全開關，不能有「打錯字就靜靜當成 false」的空間。

---

## 九、疑難排解

### 埠已被佔用 / 改了設定卻沒生效

關掉終端機不一定殺得掉 node 子行程，舊的會繼續佔著埠，新啟動的那個其實綁定失敗了——
症狀是「我明明改了 `.env` 並重啟，行為卻完全沒變」。先查清楚再殺：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

一次清掉所有開發埠：

```powershell
foreach ($port in 3000,5173,5174,4000,4001,4100,4200,4300) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
```

### `Invalid environment variables: ANTHROPIC_API_KEY`

`server/.env` 不存在，或該變數留空。env 驗證是 fail-fast，填佔位字串即可啟動（見第三節）。

### 租戶／API Key 不見了，或想知道 `tenants restored from disk` 是從哪讀的

`file` 模式的資料檔預設在系統暫存目錄（Windows 為 `%TEMP%`），清暫存或重開機可能被清掉。
先確認目前實際讀的是哪一份：

```powershell
# 未設 OA_AGENT_DATA_DIR 時
Get-ChildItem $env:TEMP\oa-agent-*.json
```

要讓它留得住，在 `server/.env` 設 `OA_AGENT_DATA_DIR` 指到專案外的固定路徑，
把舊檔複製過去再重啟。完整說明見第八節。

### http://localhost:3000/ 顯示 404

正常。server 沒有 UI，見第五節。

### widget 載不出來 / `/sdk/widget.js` 404

兩種可能：`OA_ORIGIN` 指錯了（widget.js 由 client 的 5173 提供，不是 server 的 3000），
或載入碼還停在舊的根路徑 `/widget.js`——對外路徑已改為 `/sdk/widget.js`（規格 §7.2），舊路徑不再提供。

### 瀏覽器 console 出現 CORS 錯誤

租戶的 `allowedOrigins` 沒有包含 demo 站的來源。可以先驗證預檢：

```powershell
curl.exe -i -X OPTIONS http://localhost:3000/api/auth/sso/exchange `
  -H "origin: http://localhost:4000" `
  -H "access-control-request-method: POST"
```

正確時回 `204` 且帶 `Access-Control-Allow-Origin: http://localhost:4000`。

### 對話送出後回錯誤

`ANTHROPIC_API_KEY` 還是佔位字串。登入／換票／widget 載入／表單渲染都不碰 LLM，但送訊息會打 API。

---

## 十、一頁速查

```powershell
# 首次
npm install
# 建 server/.env（見第三節）
npm run smoke                 # 離線驗證，應全過

# 每次開發（三個終端機）
npm run dev:server            # 3000  API
npm run dev:client            # 5173  對話前台   kevin / oa1234
npm run dev:admin             # 5174  管理後台   local_dev_admin_pw_123456

# 改 SSO 時額外起
node presale/widge-tenant/server.mjs    # 4000  模擬客戶網站

# 健康檢查
curl.exe http://localhost:3000/healthz
curl.exe http://localhost:3000/readyz
```
