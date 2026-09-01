# 模擬租戶後端 + 嵌入 demo（widget 浮動按鈕）

在本機重現「第三方網站嵌入 OA widget → 自動 SSO → 使用者免登入直接用」的完整流程。
widget 在右下角顯示**預設浮動按鈕**，點擊彈出聊天室。
這支服務模擬「**整合方（租戶）自己的後端 + 網站**」，也可當作交給整合方的**參考實作**。

> 想改成「用自己的按鈕開啟、藏掉浮動鈕」或「完全自建 UI」，見 [presale/sdk-custom-ui](../sdk-custom-ui)。

## 流程

```
瀏覽器開 http://localhost:4000（模擬對方網站，使用者已登入對方系統）
   │
   ├─ 頁面向「自己的後端」要 SSO token ── GET /sso-token
   │     後端用租戶 ssoSecret 簽 userToken（secret 不出後端）
   │
   ├─ 動態注入 OA widget：<script src="OA/widget.js" data-key=pk_ data-user-token=…>
   │
   └─ widget 內的 OA 前端自動呼叫 OA 的 /auth/sso/exchange 換發 token
         → 使用者免登入，直接進對話
```

## 執行

前提：OA Agent server 已在 `http://localhost:3000` 啟動，且有一個**設了 ssoSecret 的租戶**。

```bash
# 從 repo 根目錄（jsonwebtoken 由 workspace hoist，免另外安裝）
node presale/widge-tenant/server.mjs
# 開瀏覽器
open http://localhost:4000
```

點右下角「Hyweb 小幫手」→ 應該**不會看到登入頁**，直接進對話（身分＝SSO 帶入的使用者）。

## 設定（環境變數覆寫，預設對應本機 test 租戶）

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `4000` | 此模擬網站的埠 |
| `OA_ORIGIN` | `http://localhost:3000` | OA Agent 來源 |
| `TENANT_PK` | （test 租戶的 pk） | 租戶公開金鑰 |
| `TENANT_SSO_SECRET` | `test-secret1234567890` | **必須等於該租戶建立時設定的 ssoSecret** |
| `DEMO_USER_ID` / `DEMO_USER_NAME` | `hyweb` / `測試員` | 模擬「對方系統已登入的使用者」 |

```bash
TENANT_PK=pk_xxx TENANT_SSO_SECRET=你的secret DEMO_USER_NAME=小明 \
  node presale/widge-tenant/server.mjs
```

## 正式環境對照

| demo 裡的東西 | 正式環境由誰做 |
|---------------|----------------|
| `GET /sso-token` 簽 token | 整合方後端，在他們使用者登入後簽（ssoSecret 留後端） |
| 注入 widget 的頁面 | 整合方的網站頁面 |
| `ssoSecret` | 你建租戶時設定、私下交給整合方 |

> 安全：`ssoSecret` 只在後端對後端交付與使用；userToken 設短效（此範例 5 分鐘）。
