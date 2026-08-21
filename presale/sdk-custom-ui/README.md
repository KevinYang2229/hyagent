# SDK 自訂 UI 示範（第二個測試網站）

一個 landing page，**header 右上「線上客服」按鈕**點擊後開啟**完全自建的聊天室面板**——
用 `@hyagent/sdk`（headless）取得資料、自己渲染（自己的氣泡、欄位面板、機器人 header），
**不載入 widget、不用 iframe**。證明「用 SDK 取代 widget 後，UI 與觸發方式都可完全客製化」。

- 觸發：`#open-chat`（header）/ `#hero-chat`（hero）→ 開啟面板（首次開啟才初始化 SDK）。
- 結構：[index.html](index.html)（landing + 隱藏面板）、[styles.css](styles.css)（樣式）、[app.ts](app.ts)（SDK 串接 + 開關）。

## 與第一個 example（widget 版）的差異

| | [tenant-backend](../tenant-backend)（widget） | 本範例（SDK 自訂 UI） |
|--|--|--|
| 整合方式 | 貼 widget script，iframe 載入 OA 前端 | `@hyagent/sdk` headless，自己畫 UI |
| UI 客製化 | 只能改主題/語言/位置/標題 | **版面、元件、CSS 全自訂** |
| API 呼叫位置 | iframe 內（同源 OA） | 本頁面**跨網域**呼叫 OA（需 CORS 放行） |
| 打包 | 不用（widget.js 是純 JS） | 需用 esbuild 把 SDK + app.ts 打包 |

## 執行

前提：OA Agent server 已啟動，且 `TENANT_PK` 對應的租戶
**`allowedOrigins` 含 `http://localhost:4200`（或 `*`）且有 `ssoSecret`**。

```bash
# 從 repo 根目錄
node examples/sdk-custom-ui/server.mjs
open http://localhost:4200
```

頁面載入即自動 SSO，直接可在自訂介面對話、收集欄位、按「確認送出表單」。

## 運作

```
瀏覽器開 http://localhost:4200
   │
   ├─ 取 SSO token ── GET /sso-token（後端用 SDK signUserToken 簽）
   ├─ 載入 /app.js（esbuild 把 app.ts + @hyagent/sdk 打包成 ESM）
   │
   └─ app.ts：createOAAgent({ key, userToken, apiBase }) → authenticate()
        → conversations.create / sendMessage / submit
        → 自己渲染訊息、suggestions、已收集欄位（全部自訂 DOM/CSS）
```

## 設定

環境變數同 [.env.example](.env.example)：`PORT / OA_ORIGIN / TENANT_PK / TENANT_SSO_SECRET / DEMO_USER_ID / DEMO_USER_NAME`。

> 關鍵：SDK 自訂 UI 是**跨網域**呼叫 OA，務必確認租戶 `allowedOrigins` 含本站網址，否則被 CORS 擋。
