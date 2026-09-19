# 模擬租戶後端 + 嵌入 demo（widget 浮動按鈕）

在本機重現「第三方網站嵌入 HyAgent widget → 自動 SSO → 使用者免登入直接用」的完整流程。
widget 在右下角顯示**預設浮動按鈕**，點擊彈出聊天室。
這支服務模擬「**整合方（租戶）自己的後端 + 網站**」，也可當作交給整合方的**參考實作**。

> 想改成「用自己的按鈕開啟、藏掉浮動鈕」或「完全自建 UI」，見 [presale/sdk-custom-ui](../sdk-custom-ui)。

## 流程

```
瀏覽器開 http://localhost:4000（模擬對方網站，使用者已登入對方系統）
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

點右下角「Hyweb 小幫手」→ 應該**不會看到登入頁**，直接進對話（身分＝SSO 帶入的使用者）。

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
| `DEMO_USER_ID` / `DEMO_USER_NAME` | `hyweb` / `測試員` | 模擬「對方系統已登入的使用者」 |

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
| `GET /api/mybot/identity` 簽 Assertion | 整合方後端，依自家登入 Session 簽（私鑰留後端） |
| 注入 widget 的頁面 | 整合方的網站頁面 |
| Assertion 公鑰 | 整合方自行產生金鑰對後把**公鑰**給你，你在後台登記 |

> 安全：私鑰從不離開整合方環境，HyAgent 只持有公鑰；Assertion 短效（60 秒）且一次性。
