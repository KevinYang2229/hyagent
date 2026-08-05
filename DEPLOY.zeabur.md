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
> 首次切換時以 `npm run migrate:knowledge -w server` 把既有索引搬進資料庫。

---

## 一、自動部署（push 到 repo 就重新部署）

Zeabur 連上 GitHub repo 後，會 watch 指定分支；**每次 `git push` 到該分支就自動 build + redeploy**，
這就是「上傳到 repo 自動部署」。下面建好兩個服務後就自動生效，不需額外設定。

---

## 二、建立步驟

1. 登入 https://zeabur.com → **Create Project**（建議選離你近的 region，如 AWS Tokyo）。
2. 連接 GitHub，授權存取 `KevinYang2229/oa-agent`。

> **指定 Dockerfile 的關鍵規則**（Zeabur monorepo）：
> - **最推薦**：把服務「命名」成 `server` / `client`，Zeabur 會自動配對 `Dockerfile.server` / `Dockerfile.client`，不必設任何變數。
> - 若服務名稱不是 server/client，才用變數 `ZBPACK_DOCKERFILE_NAME`，值是**後綴**（`server` / `client`），**不是**完整檔名。
>   寫成 `Dockerfile.server` 會讓 Zeabur 去找 `Dockerfile.Dockerfile.server`（不存在）→ 靜默退回自動偵測 → 部署到錯的進入點。

### 服務 A：server
3. **Add Service → Git → 選 oa-agent repo**。
4. **把服務名稱設成 `server`** → Zeabur 自動使用 `Dockerfile.server`（不需設 `ZBPACK_DOCKERFILE_NAME`）。
   - 若服務名稱不是 `server`，才到 **Variables** 加 `ZBPACK_DOCKERFILE_NAME = server`（後綴，不含 `Dockerfile.`）。
5. 設定下方「server 環境變數」（見第三節）。
6. **Networking → 產生 Domain**（例：`oa-agent-server.zeabur.app`）。記下這個網址，client 要用。

### 服務 B：client
7. 在同一個 Project 再 **Add Service → Git → 選同一個 oa-agent repo**。
8. **把服務名稱設成 `client`** → Zeabur 自動使用 `Dockerfile.client`。並到 **Variables** 加：
   - `VITE_API_BASE = https://oa-agent-server.zeabur.app`  ← 填服務 A 的 Domain
     （Vite 會在 **build 階段** 把這個值 bake 進前端 bundle；改了要重新 build 才生效）
   - 若服務名稱不是 `client`，再加 `ZBPACK_DOCKERFILE_NAME = client`（後綴）。
9. **Networking → 產生 Domain**（例：`oa-agent.zeabur.app`）。記下來，回填到 server 的 `CORS_ORIGIN`。

### 服務 C：admin（管理後台）
10. 在同一個 Project 再 **Add Service → Git → 選同一個 oa-agent repo**。
11. **把服務名稱設成 `admin`** → Zeabur 自動使用 `Dockerfile.admin`。並到 **Variables** 加：
    - `VITE_API_BASE = https://oa-agent-server.zeabur.app`  ← 同樣填服務 A 的 Domain（build 階段 bake）
    - `VITE_WIDGET_ORIGIN = https://oa-agent.zeabur.app`  ← 填服務 B（client）的 Domain，供「外觀」分頁的預覽 iframe 使用。**不設會 fallback 到 `localhost:5173`，公開後台會因連到私有網段被瀏覽器封鎖而看不到預覽。**
    - 若服務名稱不是 `admin`，再加 `ZBPACK_DOCKERFILE_NAME = admin`（後綴）。
12. **Networking → 產生 Domain**（例：`oa-agent-admin.zeabur.app`）。記下來，連同 client 一起回填到 server 的 `CORS_ORIGIN`。
13. 回服務 A（server）確認兩個變數：
    - `CORS_ORIGIN` 同時放 client 與 admin 兩個網域，**逗號分隔**：
      `https://oa-agent.zeabur.app,https://oa-agent-admin.zeabur.app`
    - `ADMIN_PASSWORD` 一定要設（後台登入用，留空＝登入回 403）。

> 三個服務都用 repo 根目錄當 build context；用服務名稱或 `ZBPACK_DOCKERFILE_NAME`（後綴）決定各自用哪個 Dockerfile。

### 服務 D（選用）：presale demo（widge-tenant，模擬租戶網站 + SSO 免登入）

> 僅作展示用；不想對外展示可略過。它是一支小型 Node server（`presale/widge-tenant/server.mjs`），
> 透過 `tsx` 啟動（避開 `@oa-agent/sdk/server` 的 raw TS import 問題）。

14. 在同一個 Project 再 **Add Service → Git → 選同一個 oa-agent repo**。
15. 因為這支 Dockerfile 名稱不是 server/client/admin，**一定要**到 **Variables** 加 `ZBPACK_DOCKERFILE_NAME = presale-tenant`（後綴，不是完整檔名）。
16. 同一個 **Variables** 加（見下方表）：`OA_ORIGIN` 填 **client 服務**的 Domain（widget panel 從 client 載入）、`TENANT_PK` / `TENANT_SSO_SECRET` 填**目標租戶**的公開金鑰與 SSO 密鑰、`DEMO_USER_*` 自訂展示用使用者。
17. **Networking → 產生 Domain**（例：`oa-agent-demo.zeabur.app`）。
18. 回服務 A（server）把這個 demo 的 Domain **也加進 `CORS_ORIGIN`**，並確認該租戶的 `allowedOrigins` 含此 Domain（widget.js 會跨網域抓 `/widget/config`）。

---

## 三、環境變數

### server 服務
| 變數 | 必填 | 範例 / 說明 |
|------|------|------|
| `NODE_ENV` | 建議 | `production` |
| `ANTHROPIC_API_KEY` | ✅ 必填 | 沒填 server 啟動會直接 fail-fast 退出 |
| `JWT_ACCESS_SECRET` | ✅ | ≥32 字元隨機字串 |
| `JWT_REFRESH_SECRET` | ✅ | ≥32 字元隨機字串（與上者不同） |
| `CORS_ORIGIN` | 建議 | client 與 admin 的 Domain，**逗號分隔**：`https://oa-agent.zeabur.app,https://oa-agent-admin.zeabur.app`。**結尾不要加 `/`**（瀏覽器送的 Origin 不帶斜線，多打會比對不到而擋掉；程式已做容錯，但仍建議別加）|
| `ADMIN_PASSWORD` | 後台必填 | admin 後台登入密碼；**留空＝後台登入回 403**（停用）。與 `ADMIN_API_KEY` 分開 |
| `AUTH_DEV_PASSWORD` | 視需要 | MVP 登入共用密碼，預設 `oa1234`，正式環境請改 |
| `LLM_MODEL` | 選填 | 預設 `claude-sonnet-4-5` |
| `PORT` | 不用填 | Zeabur 自動注入，server 會自動聽 |

> 產生隨機 secret 可用：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### client 服務
| 變數 | 必填 | 說明 |
|------|------|------|
| `VITE_API_BASE` | ✅ | server 的對外網址，build 時 bake 進 bundle |
| `ZBPACK_DOCKERFILE_NAME` | 視情況 | 僅當服務「名稱」不是 `client` 時才需要；值是後綴 `client`（不是 `Dockerfile.client`） |

### admin 服務
| 變數 | 必填 | 說明 |
|------|------|------|
| `VITE_API_BASE` | ✅ | server 的對外網址，build 時 bake 進 bundle（admin 的 `api.ts` 走 `${VITE_API_BASE}/api`）|
| `VITE_WIDGET_ORIGIN` | 建議 | client（widget）的對外網址，build 時 bake 進 bundle，供「外觀」分頁預覽 iframe 使用。不設會 fallback `localhost:5173`，公開後台預覽會被瀏覽器封鎖（連到私有網段）|
| `VITE_DEMO_SITE_URL` | 選填 | 「外觀」分頁「開啟示範網站」按鈕的外部網址，build 時 bake；不設用程式內建預設（presale demo 網址）|
| `ZBPACK_DOCKERFILE_NAME` | 視情況 | 僅當服務「名稱」不是 `admin` 時才需要；值是後綴 `admin`（不是 `Dockerfile.admin`） |

> admin 登入還需要 server 端設好 `ADMIN_PASSWORD`，且 server 的 `CORS_ORIGIN` 要包含 admin 的 Domain。
> 預覽 iframe 載入 client 後會 `postMessage` 即時帶入外觀；client 的 widget config 讀取也需 server 的 `CORS_ORIGIN`／租戶 allowedOrigins 放行 admin 與 client 網域。

### presale demo 服務（widge-tenant，選用）

| 變數 | 必填 | 說明 |
|------|------|------|
| `OA_ORIGIN` | ✅ | **client（widget）服務**的對外網址（widget panel 從這裡載入）。runtime 讀取，不需 bake |
| `TENANT_PK` | ✅ | 目標租戶的公開金鑰 `pk_…`（可放前端，會注入頁面） |
| `TENANT_SSO_SECRET` | ✅ | 該租戶的 SSO 密鑰；**機密，只在此 server 端用來簽 token**，切勿放前端 |
| `DEMO_USER_ID` | 選填 | 模擬登入者帳號（預設 `hyweb`） |
| `DEMO_USER_NAME` | 選填 | 模擬登入者姓名（預設 `測試員`） |
| `ZBPACK_DOCKERFILE_NAME` | ✅ | 固定填 `presale-tenant`（後綴）；因服務名不會剛好等於它 |

> 這個 demo 的 `TENANT_SSO_SECRET` 必須等於該租戶建立時設定的 `ssoSecret`，否則 SSO 換 token 會失敗。
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
- 若 client 或 admin 出現 CORS 錯誤 → 確認 server 的 `CORS_ORIGIN` 同時包含 client 與 admin 的 Domain，逗號分隔（例：`https://oa-agent.zeabur.app,https://oa-agent-admin.zeabur.app`，含 `https://`、結尾不要多斜線），更新後重啟 / redeploy server。
- 若 server log 出現 `Prisma failed to detect the libssl/openssl version` → 確認使用新版 `Dockerfile.server` 重新部署；server image 需要安裝 `openssl` 供 Prisma generate/runtime 偵測。

## 六、本機驗證（可選，需裝 Docker）
```bash
# server
docker build -f Dockerfile.server -t oa-server .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-xxx \
  -e JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e JWT_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  oa-server

# client（把 VITE_API_BASE 指向上面的 server）
docker build -f Dockerfile.client --build-arg VITE_API_BASE=http://localhost:3000 -t oa-client .
docker run --rm -p 8080:8080 oa-client   # 開 http://localhost:8080

# admin（同樣把 VITE_API_BASE 指向 server；用不同的對外埠避免和 client 撞）
docker build -f Dockerfile.admin --build-arg VITE_API_BASE=http://localhost:3000 -t oa-admin .
docker run --rm -p 8081:8080 oa-admin    # 開 http://localhost:8081
```
