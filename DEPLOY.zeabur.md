# 部署到 Zeabur（方案 B：前後端分開兩個服務）

本專案是 npm workspaces monorepo。採「前後端各自一個 Zeabur 服務、共用同一個 GitHub repo」的部署方式，
透過根目錄的兩個 Dockerfile 建置：

- `Dockerfile.server` → **server 服務**（Express API）
- `Dockerfile.client` → **client 服務**（對話 widget，Vite 靜態網站，nginx 提供）
- `Dockerfile.admin` → **admin 服務**（管理後台，Vite 靜態網站，nginx 提供）
- `Dockerfile.presale-tenant` →（選用）**presale demo 服務**（模擬租戶網站 + SSO 免登入，展示用）

> server 支援 `DATA_BACKEND=db`（Postgres write-through，涵蓋全部 10 個 runtime store，
> 含知識庫索引——向量存於 pgvector 的 `knowledge_chunks`）。
>
> 知識庫的向量與來源設定在 `DATA_BACKEND=file` 時寫在 `server/data/*.json`。
> 容器檔案系統為 ephemeral 且該目錄不在映像檔內，**正式環境必須用 `db`**，
> 否則每次重新部署都要重爬並重新支出 embedding 費用。

**⚠️ 先決條件：套 DDL 必須早於帶 `DATA_BACKEND=db` 部署。**

**repo 沒有任何東西會自動套用 `server/db/migrations/*.sql`**（`build` / `start` 都不含
`prisma migrate deploy`）。而 `server/src/index.ts` 把 `initKnowledgeStore()` 放在 fail-fast 的
`Promise.all` 裡，失敗會 `process.exit(1)`。

所以若帶著 `DATA_BACKEND=db` 部署、資料庫卻還沒套 0005，`knowledge_sources` 查詢會拋錯，
**整台 server 起不來**——不是只有知識庫失效，是全部 API 都不通。順序不可顛倒：

1. 在 Supabase SQL Editor 依序套用 `server/db/migrations/0005_knowledge.sql`（建表）
   與 `server/db/migrations/0006_knowledge_chunks_index.sql`（移除 HNSW 索引）、
   `server/db/migrations/0019_mcp_servers.sql`（MCP 服務管理）。
2. 確認 pgvector ≥ 0.7（低於 0.7 沒有 `halfvec`，0005 會在建表時就失敗），
   並確認三張表都在：

   ```sql
   select extversion from pg_extension where extname = 'vector';   -- 需 >= 0.7
   select tablename from pg_tables where tablename like 'knowledge%';
   ```

3. **上面兩步都確認完**，才把 server 的 `DATA_BACKEND` 設成 `db` 並部署。
4. 首次切換時以 `npm run migrate:knowledge -w server` 把既有索引搬進資料庫
   （可先加 `-- --dry-run` 試跑）。腳本結束會回讀並印出 `knowledge_sources` 筆數與
   各租戶 chunks 數，**以這份摘要為準**判斷是否真的寫進去了。
5. 同時套用 `server/db/migrations/0007_report_docs.sql`（報告產出物落地用的 `report_docs` 表）。
   這張表**不在** boot 時的 fail-fast 檢查內，未套用不會讓 server 起不來，但寫入會在背景
   靜默失敗（只留一行 warn log）：報告只存在記憶體，**一旦重啟，`DATA_BACKEND=db` 下已產生
   的報告下載連結會全部失效**（狀態查得到、下載卻 404，或狀態也一併查不到）。建議與
   0005 / 0006 一起、在第一次以 `db` 模式部署前套用。

---

## 一、自動部署（push 到 repo 就重新部署）

Zeabur 連上 GitHub repo 後，會 watch 指定分支；**每次 `git push` 到該分支就自動 build + redeploy**，
這就是「上傳到 repo 自動部署」。下面建好兩個服務後就自動生效，不需額外設定。

---

## 二、建立步驟

1. 登入 https://zeabur.com → **Create Project**（建議選離你近的 region，如 AWS Tokyo）。
2. 連接 GitHub，授權存取 `KevinYang2229/oa-agent`。

> **指定 Dockerfile 的關鍵規則**（Zeabur monorepo）：
>
> - **最推薦**：把服務「命名」成 `server` / `client`，Zeabur 會自動配對 `Dockerfile.server` / `Dockerfile.client`，不必設任何變數。
> - 若服務名稱不是 server/client，才用變數 `ZBPACK_DOCKERFILE_NAME`，值是**後綴**（`server` / `client`），**不是**完整檔名。
>   寫成 `Dockerfile.server` 會讓 Zeabur 去找 `Dockerfile.Dockerfile.server`（不存在）→ 靜默退回自動偵測 → 部署到錯的進入點。

### 服務 A：server

3. **Add Service → Git → 選 oa-agent repo**。
4. **把服務名稱設成 `server`** → Zeabur 自動使用 `Dockerfile.server`（不需設 `ZBPACK_DOCKERFILE_NAME`）。
   - 若服務名稱不是 `server`，才到 **Variables** 加 `ZBPACK_DOCKERFILE_NAME = server`（後綴，不含 `Dockerfile.`）。
5. 設定下方「server 環境變數」（見第三節）。
6. **Networking → 產生 Domain**（例：`hyagent-server.zeabur.app`）。記下這個網址，client 要用。

### 服務 B：client

7. 在同一個 Project 再 **Add Service → Git → 選同一個 hyagent repo**。
8. **把服務名稱設成 `client`** → Zeabur 自動使用 `Dockerfile.client`。並到 **Variables** 加：
   - `API_UPSTREAM = https://hyagent-server.zeabur.app` ← 填服務 A 的 Domain。
     nginx 會把 `/api/*` 與 `/healthz` 同源代理到後端（**runtime 讀取，改了重啟即可**）。
   - `VITE_API_BASE` **留空**：走相對路徑交給上面的代理。要讓瀏覽器直打後端才填，
     但那是 **build 階段** bake 進 bundle，改了得重新 build，且得另外設 `CORS_ORIGIN`。
   - 若服務名稱不是 `client`，再加 `ZBPACK_DOCKERFILE_NAME = client`（後綴）。
9. **Networking → 產生 Domain**（例：`hyagent.zeabur.app`）。記下來，回填到 server 的 `CORS_ORIGIN`。

### 服務 C：admin（管理後台）

10. 在同一個 Project 再 **Add Service → Git → 選同一個 hyagent repo**。
11. **把服務名稱設成 `admin`** → Zeabur 自動使用 `Dockerfile.admin`。並到 **Variables** 加：
    - `API_UPSTREAM = https://hyagent-server.zeabur.app` ← 同樣填服務 A 的 Domain（runtime 代理）
    - `VITE_API_BASE` 留空即可，理由同 client
    - `VITE_WIDGET_ORIGIN = https://hyagent.zeabur.app` ← 填服務 B（client）的 Domain，供「外觀」分頁的預覽 iframe 使用。**不設會 fallback 到 `localhost:5173`，公開後台會因連到私有網段被瀏覽器封鎖而看不到預覽。**
    - 若服務名稱不是 `admin`，再加 `ZBPACK_DOCKERFILE_NAME = admin`（後綴）。
12. **Networking → 產生 Domain**（例：`hyagent-admin.zeabur.app`）。記下來，連同 client 一起回填到 server 的 `CORS_ORIGIN`。
13. 回服務 A（server）確認兩個變數：
    - `CORS_ORIGIN` 同時放 client 與 admin 兩個網域，**逗號分隔**：
      `https://hyagent.zeabur.app,https://hyagent-admin.zeabur.app`
    - `ADMIN_PASSWORD` 一定要設（後台登入用，留空＝登入回 403）。

> 三個服務都用 repo 根目錄當 build context；用服務名稱或 `ZBPACK_DOCKERFILE_NAME`（後綴）決定各自用哪個 Dockerfile。

### 服務 D（選用）：presale demo（widge-tenant，模擬租戶網站 + SSO 免登入）

> 僅作展示用；不想對外展示可略過。它是一支小型 Node server（`presale/widge-tenant/server.mjs`），
> 透過 `tsx` 啟動（避開 `@hyagent/sdk/server` 的 raw TS import 問題）。

14. 在同一個 Project 再 **Add Service → Git → 選同一個 oa-agent repo**。
15. 因為這支 Dockerfile 名稱不是 server/client/admin，**一定要**到 **Variables** 加 `ZBPACK_DOCKERFILE_NAME = presale-tenant`（後綴，不是完整檔名）。
16. 同一個 **Variables** 加（見下方表）：`OA_ORIGIN` 填 **client 服務**的 Domain（widget panel 從 client 載入）、`TENANT_PK` / `TENANT_ID` / `TENANT_PRIVATE_KEY` 填**目標租戶**的公開金鑰、租戶 id 與簽發私鑰、`DEMO_USER_*` 自訂展示用使用者。
17. **Networking → 產生 Domain**（例：`hyagent-demo.zeabur.app`）。
18. 回服務 A（server）把這個 demo 的 Domain **也加進 `CORS_ORIGIN`**，並確認該租戶的 `allowedOrigins` 含此 Domain（widget.js 會跨網域抓 `/widget/config`）。

---

## 三、環境變數

### server 服務

| 變數                 | 必填     | 範例 / 說明                                                                                                                                                                                                |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | 建議     | `production`（`Dockerfile.server` 已內建，不設也是這個值）                                                                                                                                                  |
| `DATA_BACKEND`       | ✅ 必填  | 正式環境填 `db`（另需 `DATABASE_URL`，且 DDL 要先套，見上方先決條件）。**留空＝`file`，在 `production` 下會 boot fail-fast**——見下一列                                                                      |
| `ALLOW_FILE_BACKEND_IN_PRODUCTION` | 視需要 | 只有「確定單一副本 + 持久磁碟、仍要用 `file`」時填 `true`。file 模式的記憶體 Map 就是 primary，多副本下撤銷不會傳播、Session 隨負載平衡飄移，且**不會有任何錯誤訊息**，所以要求明示                          |
| `ANTHROPIC_API_KEY`  | ✅ 必填  | 沒填 server 啟動會直接 fail-fast 退出                                                                                                                                                                      |
| `JWT_ACCESS_SECRET`  | ✅       | ≥32 字元隨機字串                                                                                                                                                                                           |
| `JWT_REFRESH_SECRET` | ✅       | ≥32 字元隨機字串（與上者不同）                                                                                                                                                                             |
| `MCP_SIGNING_KEY`    | 視需要   | 要讓 AI 呼叫自建 MCP 服務時必填：ES256 私鑰（PKCS#8 PEM，換行寫成 `\n`）。未設＝MCP 功能停用。產生方式見 `server/.env.example` |
| `MCP_PREVIOUS_PUBLIC_KEY` | 選填 | 換鑰過渡期填上一把的公鑰（SPKI PEM），過渡結束後移除 |
| `CORS_ORIGIN`        | 建議     | client 與 admin 的 Domain，**逗號分隔**：`https://hyagent.zeabur.app,https://hyagent-admin.zeabur.app`。**結尾不要加 `/`**（瀏覽器送的 Origin 不帶斜線，多打會比對不到而擋掉；程式已做容錯，但仍建議別加） |
| `ADMIN_PASSWORD`     | 後台必填 | admin 後台登入密碼；**留空＝後台登入回 403**（停用）。與 `ADMIN_API_KEY` 分開                                                                                                                              |
| `AUTH_DEV_PASSWORD`  | 視需要   | 帳密登入共用密碼，預設 `oa1234`；`AUTH_PASSWORD_LOGIN=on` 的正式環境必須改（否則 boot fail-fast）                                                                                                          |
| `AUTH_PASSWORD_LOGIN`| 視需要   | 帳密登入開關：`auto`（預設，production 關）/ `on`（production 也開，需自訂密碼＋後台人員目錄）/ `off`                                                                                                      |
| `LLM_MODEL`          | 選填     | 預設 `claude-sonnet-4-5`                                                                                                                                                                                   |
| `REPORT_PDF_BROWSER` | 不用填   | Dockerfile 已設為 `/usr/bin/chromium`（報告的 PDF 輸出）。**探測不到瀏覽器時 pdf 不會出現在下載格式裡**，md 與 html 照常產出；指到不存在的路徑會留一筆警告並停用 pdf                                       |
| `PORT`               | 不用填   | Zeabur 自動注入，server 會自動聽                                                                                                                                                                           |

> 產生隨機 secret 可用：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### client 服務

| 變數                     | 必填   | 說明                                                                                  |
| ------------------------ | ------ | ------------------------------------------------------------------------------------- |
| `API_UPSTREAM`           | ✅     | server 的對外網址。nginx 把 `/api/*`、`/healthz` 同源代理過去，**runtime 讀取** |
| `VITE_API_BASE`          | 選填   | 留空＝走相對路徑吃上面的代理（建議）。填了就是瀏覽器直打後端，build 時 bake 進 bundle，另需 server 放行 CORS |
| `ZBPACK_DOCKERFILE_NAME` | 視情況 | 僅當服務「名稱」不是 `client` 時才需要；值是後綴 `client`（不是 `Dockerfile.client`） |

### admin 服務

| 變數                     | 必填   | 說明                                                                                                                                                              |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_UPSTREAM`           | ✅     | server 的對外網址。nginx 把 `/api/*` 同源代理過去，**runtime 讀取**                                                                                              |
| `VITE_API_BASE`          | 選填   | 留空＝走相對路徑吃上面的代理（建議）。填了就是瀏覽器直打後端（`api.ts` 走 `${VITE_API_BASE}/api`），build 時 bake，另需 server 放行 CORS                        |
| `VITE_WIDGET_ORIGIN`     | 建議   | client（widget）的對外網址，build 時 bake 進 bundle，供「外觀」分頁預覽 iframe 使用。不設會 fallback `localhost:5173`，公開後台預覽會被瀏覽器封鎖（連到私有網段） |
| `VITE_DEMO_SITE_URL`     | 選填   | 「外觀」分頁「開啟示範網站」按鈕的外部網址，build 時 bake；不設用程式內建預設（presale demo 網址）                                                                |
| `ZBPACK_DOCKERFILE_NAME` | 視情況 | 僅當服務「名稱」不是 `admin` 時才需要；值是後綴 `admin`（不是 `Dockerfile.admin`）                                                                                |

> admin 登入還需要 server 端設好 `ADMIN_PASSWORD`，且 server 的 `CORS_ORIGIN` 要包含 admin 的 Domain。
> 預覽 iframe 載入 client 後會 `postMessage` 即時帶入外觀；client 的 widget config 讀取也需 server 的 `CORS_ORIGIN`／租戶 allowedOrigins 放行 admin 與 client 網域。

### presale demo 服務（widge-tenant，選用）

| 變數                     | 必填 | 說明                                                                                   |
| ------------------------ | ---- | -------------------------------------------------------------------------------------- |
| `OA_ORIGIN`              | ✅   | **client（widget）服務**的對外網址（widget panel 從這裡載入）。runtime 讀取，不需 bake |
| `TENANT_PK`              | ✅   | 目標租戶的公開金鑰 `pk_…`（可放前端，會注入頁面）                                      |
| `TENANT_ID`              | ✅   | 租戶 id，會成為 Assertion 的 `iss`                                                    |
| `TENANT_PRIVATE_KEY`     | ✅   | 簽發 Assertion 的私鑰（PKCS#8 PEM）；**機密，只在此 server 端使用**，切勿放前端；對應公鑰須已在後台登記 |
| `DEMO_USER_ID`           | 選填 | 模擬登入者帳號（預設 `hyweb`）                                                         |
| `DEMO_USER_NAME`         | 選填 | 模擬登入者姓名（預設 `測試員`）                                                        |
| `ZBPACK_DOCKERFILE_NAME` | ✅   | 固定填 `presale-tenant`（後綴）；因服務名不會剛好等於它                                |

> 這個 demo 需要 `TENANT_ID`（＝租戶 id，會成為 Assertion 的 `iss`）與 `TENANT_PRIVATE_KEY`，
> 且該私鑰對應的公鑰必須已在後台登記給同一個租戶，否則換發會回 `UNKNOWN_KID`。
> 並記得把此 demo 的 Domain 加進 server 的 `CORS_ORIGIN` 與該租戶 `allowedOrigins`。

---

## 四、資料庫備份與還原

**備份（自動）**：GitHub Actions 的 `DB Backup` workflow（`.github/workflows/db-backup.yml`）每日台北 02:10
以 `pg_dump`（custom format、postgres:17 對齊伺服器版本）備份整個 Supabase DB，
上傳為私有 repo 的 workflow artifact，保留 30 天。也可到 Actions 頁面手動觸發（workflow_dispatch）。
需要 repo secret `SUPABASE_DB_URL`（= server 的 `DATABASE_URL`，session pooler 連線字串）。

**還原步驟**：

1. GitHub repo → **Actions** → 左側選 **DB Backup** → 點進要還原的那次 run → 下載 artifact（`db-backup-<run id>`，解壓得 `backup.dump`）。
2. 本機執行（`DB_URL` 用與備份同一條連線字串；`--clean --if-exists` 會先清掉現有物件再還原，**整庫覆蓋，請先確認**）：

```bash
docker run --rm -v "$PWD:/backup" -e DB_URL postgres:17-alpine \
  pg_restore -d "$DB_URL" --clean --if-exists --no-owner /backup/backup.dump
```

3. 還原後重啟 server（記憶體 Map 是開機時從 DB 載入的，不重啟不會反映還原後的資料）。

> 注意：備份含全部租戶資料（API key 為 sha256 雜湊、BYO key 為密文——還原後要能解密，`DATA_ENCRYPTION_KEY` 必須是同一把）。artifact 只有 repo 協作者能下載，repo 需維持 private。

## 五、驗證

- 開 client Domain → 應正常載入頁面。
- 用帳號 + `AUTH_DEV_PASSWORD` 登入 → 對話功能能打到 server（瀏覽器 Network 面板看到請求送往 `VITE_API_BASE`，回 200）。
- 若 client 或 admin 出現 CORS 錯誤 → 確認 server 的 `CORS_ORIGIN` 同時包含 client 與 admin 的 Domain，逗號分隔（例：`https://hyagent.zeabur.app,https://hyagent-admin.zeabur.app`，含 `https://`、結尾不要多斜線），更新後重啟 / redeploy server。
- 若 server log 出現 `Prisma failed to detect the libssl/openssl version` → 確認使用新版 `Dockerfile.server` 重新部署；server image 需要安裝 `openssl` 供 Prisma generate/runtime 偵測。

## 六、本機驗證（可選，需裝 Docker）

```bash
# server
docker build -f Dockerfile.server -t oa-server .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-xxx \
  -e JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e JWT_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  oa-server

# client（API_UPSTREAM 指向上面的 server；host.docker.internal 讓容器連得到宿主機）
docker build -f Dockerfile.client -t oa-client .
docker run --rm -p 8080:8080 -e API_UPSTREAM=http://host.docker.internal:3000 oa-client
# 開 http://localhost:8080

# admin（同樣指向 server；用不同的對外埠避免和 client 撞）
docker build -f Dockerfile.admin -t oa-admin .
docker run --rm -p 8081:8080 -e API_UPSTREAM=http://host.docker.internal:3000 oa-admin
# 開 http://localhost:8081
```

## 七、知識庫資料夾批次匯入（選用）

除了 admin 後台一次上傳一個檔，`server/scripts/knowledge-watch.ts` 提供另一支獨立 CLI，
把整個資料夾的文件依序批次消化進知識庫索引，適合一次匯入幾十份規章文件的情境。
消化邏輯與 admin 上傳共用同一條 `ingestFile` 管線，結果完全一致。

把文件放進 `<root>/<tenantId>/<labelId>/`，執行：

- `<tenantId>`：租戶 id（不是租戶名稱）
- `<labelId>`：該租戶已建立的可見性標籤 id（例如 `hr`，不是顯示名稱「人資」）。匯入的檔案會標記為這個標籤；
  直接放在租戶資料夾下（未分層）或標籤不存在的檔案不匯入，搬進 `_failed/`。標籤資料夾底下的子資料夾不會被讀取。


```bash
npm run watch:knowledge -w server -- --root=/path/to/inbox
```

watcher 會依序消化每個檔案，成功搬進 `_done/`；永久性失敗（格式不支援、超過大小上限等）
搬進 `_failed/` 並附同名 `.error.txt` 記錄原因；暫時性失敗（embedding API 逾時等）不搬檔，
留在原地待下一輪重試。

| 參數         | 預設 | 說明                                                                                                                                                                   |
| ------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root`     | 必填 | 監控的根目錄                                                                                                                                                           |
| `--interval` | 30   | 輪詢間隔（秒）                                                                                                                                                         |
| `--once`     | —    | 單次呼叫內自足完成兩輪（掃描 → 等待 `--interval` 秒 → 再掃描，只在第二輪處理），**可掛 cron**。代價是單次執行至少要等一個 `--interval`，嫌久可用 `--once --interval=5` |
| `--dry-run`  | —    | 只列出將處理什麼與預估規模，不呼叫任何 API、不搬檔；搭配 `--once` 同樣走完整兩輪                                                                                       |
| `--max-mb`   | 50   | 單檔大小上限（MB）；`0` 為合法值，代表拒絕所有檔案                                                                                                                     |
| `--tenant`   | —    | 只處理指定租戶的子資料夾                                                                                                                                               |

> `--interval` 與 `--max-mb` 會驗證輸入：非數字、`Infinity`、`--interval <= 0`、`--max-mb < 0`
> 一律印出明確錯誤並以 exit code 1 結束，不會靜默改用預設值。

**注意事項**

- `server/.env` 需為 `DATA_BACKEND=db` 且 `DATABASE_URL` 指向正式 Supabase，
  否則索引寫進本機 JSON、正式環境看不到（watcher 啟動時會印出目前的 `DATA_BACKEND`，非 `db` 模式下另有警告）。
- 檔案需連續兩輪 `(size, mtime)` 相同才會被判定為「寫完」而處理，避免讀到傳輸中的半份檔案；
  持續輪詢模式下這是自然發生的（第二輪起才看得到符合條件的檔案），`--once` 已在單次呼叫內把這兩輪都跑完，不需要額外操作。
- **同名且同標籤**的檔視為更新：新版匯入成功後才移除舊檔（匯入失敗時舊檔保留）。不同標籤的同名檔
  （如 `hr/作業辦法.pdf` 與 `finance/作業辦法.pdf`）各自獨立並存；同名但沒有任何標籤的舊檔會被新版取代。
- 重新匯入會以資料夾標籤為準：後台另外替該檔加的標籤會被覆蓋。
- embedding 帳號額度用完（`credit_balance_exhausted`）時 watcher 會停止並以 exit code 1 結束，
  未處理的檔案留在原地；儲值或更換 `OPENAI_API_KEY` 後重新執行即可接續。
- **全站重爬期間請勿執行批次匯入**：重爬是整份取代，會抹掉期間新增的檔案 chunks。
- **admin 後台的檔案清單要等 server 重啟才會看到批次匯入的新檔**：後台顯示的檔案清單來自 server
  開機時從資料庫還原的記憶體快照，之後不會自動重讀；watcher 這支獨立 CLI process 寫進資料庫的
  新增/刪除不會反映到已經在跑的 server 記憶體裡（反之，server 上的操作也不會讓 watcher 看到）。
  這不影響 RAG 檢索本身——widget 問答是直接查 `knowledge_chunks` 資料表，不經這份記憶體快照。
