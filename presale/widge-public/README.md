# 嵌入 demo（widget 純前端版 · 免後端、不做 SSO）

最精簡的接法：**只在頁面貼一行 `<script>`**，不需要後端、不需要 SDK、不需要簽 token。
widget 在右下角顯示**預設浮動按鈕**，點擊彈出聊天室；使用者首次使用時在 widget 內自行登入。

> 想要「沿用宿主系統登入身分、免再登入」的 SSO 版本（需要一個後端簽 token 的端點），見 [../widge-tenant](../widge-tenant)。
> 想完全自建 UI，見 [../sdk-custom-ui](../sdk-custom-ui)。

## 和 widge-tenant 的差別

| | widge-public（本範例） | widge-tenant |
|---|---|---|
| 要動自己後端嗎 | ❌ 不用 | ✅ 要加 Identity Endpoint（`/api/mybot/identity`） |
| 需要 SDK 嗎 | ❌ 不用 | 選用（簽 token，可改用任何 JWT 套件） |
| 金鑰對 | 用不到 | 需產生，私鑰留後端、公鑰交 HyAgent 登記 |
| 使用者登入 | 在 widget 內以帳密自行登入 | 自動沿用宿主身分（免登入） |
| HyAgent 租戶要準備 | **使用者目錄**（可登入的帳號） | Assertion 公鑰 |
| 載入碼 | `data-key` | `data-key` + `data-token-url` |

## 流程

```
瀏覽器開 http://localhost:4001（模擬對方網站）
   │
   └─ 頁面直接注入 HyAgent widget：<script src="OA_ORIGIN/sdk/widget.js" data-key=pk_>
         （沒有 data-token-url → 不做免登入）
         → 點開小幫手 → 面板顯示登入頁
         → 以「該租戶使用者目錄裡的帳號 ＋ 共用密碼」登入後對話
```

## 執行

前提：

- **server 在 `http://localhost:3000`**（API）→ `run_server.bat` 或 `npm run dev:server`
- **client 在 `http://localhost:5173`**（提供 `widget.js`）→ `run_client.bat` 或 `npm run dev:client`
- 有一個租戶，拿到它的 `pk_...` 填進 `.env`（見下方 [怎麼拿 `TENANT_PK`](#怎麼拿-tenant_pk)），
  且該租戶的**使用者目錄**裡有帳號（見 [登入帳密](#登入帳密)）
- Node **20.12 以上**（`server.mjs` 用內建的 `process.loadEnvFile` 讀 `.env`）

這版**不需要**租戶登記 Assertion 公鑰，也不需要在 repo 根目錄跑 `npm install`（沒有任何相依套件）。

Windows 直接跑 [run_public.bat](run_public.bat)：會檢查 Node 版本、沒有 `.env` 時從 `.env.example`
複製一份、健檢上面兩個服務並驗證 `TENANT_PK`，然後啟動並自動開瀏覽器。

```bat
presale\widge-public\run_public.bat
```

手動跑也行（任何目錄皆可，`server.mjs` 讀的是自己同目錄的 `.env`）：

```bash
node presale/widge-public/server.mjs
# 開瀏覽器：http://localhost:4001
```

點右下角「Hyweb 小幫手」→ 面板顯示登入頁 → 輸入帳密後進對話。

### 登入帳密

| 欄位 | 值 | 來源 |
|------|----|------|
| 帳號 | 該租戶**使用者目錄**裡的 `id`，例如 `kevin`、`hyweb` | 後台 <http://localhost:5174> → 租戶 → 「使用者目錄」分頁 |
| 密碼 | 本機 dev 為 `oa1234`，所有帳號共用 | `server/.env` 的 `AUTH_DEV_PASSWORD` |

⚠️ **新建的租戶，使用者目錄是空的，任何帳號都登不進去**（面板回「帳號或密碼錯誤」）。
repo 內建的 `kevin` / `hyweb` 開發帳號只屬於 `default` 租戶，不會自動出現在你建的租戶裡。
請到後台該租戶的「使用者目錄」新增帳號，或用管理 API 整份寫入（PowerShell）：

```powershell
$body = @{ users = @(
  @{ id = "kevin"; name = "Kevin Yang";  department = "行銷部"; title = "技術經理" },
  @{ id = "hyweb"; name = "Eason Hsieh"; department = "行銷部"; title = "處長" }
) } | ConvertTo-Json -Depth 3

Invoke-RestMethod -Method Put -Uri http://localhost:3000/api/admin/tenants/<租戶id>/users `
  -ContentType "application/json; charset=utf-8" `
  -Headers @{ "x-admin-key" = "local_dev_admin_key_0123456789abcdef" } `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

> `PUT` 會**整份覆蓋**該租戶的目錄；只想加一位改用 `POST`（body 是單一使用者物件）。
> body 要以 UTF-8 送出，否則中文的部門、職稱會存成亂碼——上面把字串轉成 UTF-8 位元組就是為了這個。

## 設定

設定的來源是同目錄 `.env`（server.mjs 會自動載入；`run_public.bat` 首次執行會從
[.env.example](.env.example) 複製一份）。已存在的環境變數優先於 `.env`，所以也能臨時覆寫。

| 變數 | `.env.example` 的值 | 說明 |
|------|------|------|
| `PORT` | `4001` | 此模擬網站的埠（避開 widge-tenant 的 4000） |
| `OA_ORIGIN` | `http://localhost:5173` | 載入 `widget.js` 與聊天面板 iframe 的網域＝**client**。填 server 的 3000 會 404。這版不設 `data-api`，widget 的 API 也打這個網域，本機由 5173 的 vite proxy 轉給 3000 |
| `TENANT_PK` | （空，**必填**） | 租戶公開金鑰（pk 可放前端）。每台機器不同，故不給預設值——見下方說明 |

> `server.mjs` 在變數完全沒設時另有內建預設值（`OA_ORIGIN` 為 3000、`TENANT_PK` 為一把舊的 pk），
> 這兩個在本機 dev 都不能用，請一律以 `.env` 設定。

### 怎麼拿 `TENANT_PK`

server 只存金鑰的 sha256，**pk 原文只在下列時機回傳一次，事後無法反查**：

- 在後台 <http://localhost:5174> 建租戶時
- 對既有租戶補發：`POST /api/admin/tenants/{id}/keys`，body `{"type":"publishable"}`

建租戶時 `allowedOrigins` 請填 `http://localhost:4001`。留空或填錯 pk 時，`run_public.bat`
會在啟動前就擋下來（拿 `GET /api/widget/config?key=` 驗），不會等到你點開 widget 才看到「金鑰錯誤」。

## 常見問題

| 症狀 | 原因 |
|------|------|
| 右下角沒有浮動按鈕 | `OA_ORIGIN` 填成 3000（`/sdk/widget.js` 回 404），或 client dev server 沒啟動 |
| 金鑰錯誤／`Invalid or revoked API key` | `TENANT_PK` 已作廢或是別台機器的 pk，重新補發一把 |
| 登入回「帳號或密碼錯誤」 | 租戶的使用者目錄是空的，或帳號不在目錄裡，或密碼不是 `AUTH_DEV_PASSWORD` |
| 登入回「此環境未開放帳密登入」 | server 的 `AUTH_PASSWORD_LOGIN=off`，或 `auto` 但跑在 production（見下節） |
| `run_public.bat` 說埠 4001 已被占用 | 上一次的 server 還開著，關掉那個視窗，或改 `.env` 的 `PORT` |

## 正式環境怎麼接

把這一行貼進你現有頁面就好，**不需要任何後端**：

```html
<script src="https://hyagent.example.com/sdk/widget.js" data-key="pk_…" data-title="Hyweb 小幫手"></script>
```

> `src` 用 **HyAgent 提供給你的網域** —— widget 與聊天面板都由 HyAgent 託管，
> 你不需要自行部署或代管任何檔案；這一行裡要換成自己的值的只有 `data-key`。

> demo 裡用 `window.__OA__` 注入 origin/key 只是方便讀本機 .env、免改檔；
> 正式環境直接把值寫死在上面那行即可。

使用者要能在 widget 內登入，HyAgent 端要先備妥兩件事（由 HyAgent 營運方設定，整合方頁面不用動）：

- **server 開放帳密登入**：`AUTH_PASSWORD_LOGIN` 預設 `auto`，在 production 是**關閉**的，
  要明確設成 `on`，且必須自訂 `AUTH_DEV_PASSWORD`（沿用開發預設值時 server 會拒絕啟動）。
- **該租戶已建使用者目錄**：只有目錄裡的帳號能登入，production 不會出現 repo 內建的開發帳號。
