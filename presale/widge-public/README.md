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
| 使用者登入 | 在 widget 內自行登入 | 自動沿用宿主身分（免登入） |
| 載入碼 | `data-key` | `data-key` + `data-token-url` |

## 流程

```
瀏覽器開 http://localhost:4001（模擬對方網站）
   │
   └─ 頁面直接注入 HyAgent widget：<script src="OA/sdk/widget.js" data-key=pk_>
         （沒有 data-token-url → 不做免登入）
         → 點開小幫手，使用者在 widget 內自行登入後對話
```

## 執行

前提：HyAgent server 已在 `http://localhost:3000` 啟動，且有一個租戶（取得其 `pk_…`）。
這版**不需要**租戶登記 Assertion 公鑰。

```bash
node presale/widge-public/server.mjs
open http://localhost:4001
```

## 設定（環境變數覆寫，預設對應本機 test 租戶）

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `4001` | 此模擬網站的埠 |
| `OA_ORIGIN` | `http://localhost:3000` | HyAgent 來源 |
| `TENANT_PK` | （test 租戶的 pk） | 租戶公開金鑰（pk 可放前端） |

## 正式環境怎麼接

把這一行貼進你現有頁面就好，**不需要任何後端**：

```html
<script src="https://hyagent.example.com/sdk/widget.js" data-key="pk_…" data-title="Hyweb 小幫手"></script>
```

> `src` 用 **HyAgent 提供給你的網域** —— widget 與聊天面板都由 HyAgent 託管，
> 你不需要自行部署或代管任何檔案；這一行裡要換成自己的值的只有 `data-key`。

> demo 裡用 `window.__OA__` 注入 origin/key 只是方便讀本機 .env、免改檔；
> 正式環境直接把值寫死在上面那行即可。
