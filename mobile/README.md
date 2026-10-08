# 行動 App 工作區（mobile/）

所有 Expo App 放在這裡。這是一個獨立的 npm 工作區，不在根目錄的 workspaces 內，因為 App 用 React 19、網頁版用 React 18。

```
mobile/
  package.json            workspaces: apps/*、packages/*；共用一份 node_modules 與 package-lock.json
  packages/
    app-core/             共用核心 @hyagent/app-core：登入、API、對話、語音、確認彈窗、設定、主題
  apps/
    store/                門市小幫手（7-ELEVEN POC）
```

## 安裝與常用指令

    cd mobile
    npm install            # 一次裝齊所有 App 與共用核心
    npm run typecheck      # 全部 App 與共用核心
    npm test               # 全部 App 與共用核心
    npm run dev:store      # 啟動門市小幫手（等同在 apps/store 執行 npx expo start）

根目錄的 `npm run typecheck`、`npm test`、`npm run dev:app` 會轉呼叫這裡。

## 什麼放 core、什麼放 App

| 放 `packages/app-core` | 放 `apps/<app>` |
| --- | --- |
| 跟後端通用 API 有關的：登入、對話、確認動作、語音轉文字、通知 | 呼叫某個領域 MCP 工具的程式（例如 `storeTool('replenishment_list')`）與它的回應型別 |
| 不帶品牌的元件：對話泡泡、輸入框、確認彈窗、表格 | 品牌素材：吉祥物、logo、商品圖、背景 |
| 設定、版面判斷（`useIsWide`）、主題 token | 路由（`app/` 目錄）、分頁、首頁、各領域畫面 |

**規則：core 不能 import 任何 App 的程式。** 需要 App 決定的東西，用以下兩種方式注入：

- **品牌**：App 在根 layout 包 `<AppBrandingProvider value={...}>`，提供吉祥物、語音範例、圖片解析、確認彈窗的標頭與陪伴角色，型別見 `packages/app-core/src/branding/AppBranding.tsx`。沒有注入時用中性預設：不顯示角色，圖片只用後端的 http(s) 網址。
- **行為**：用 props 或回呼。例如 `ChatProvider` 的 `onActionConfirmed`，門市版在 `apps/store/src/tasks/StoreChatProvider.tsx` 用它刷新今日重點、補貨單並點亮任務紅點。

## 引用方式

- App 內部：`@/…` 對到自己的 `src/`
- 共用核心：`@hyagent/app-core/<路徑>`，例如 `@hyagent/app-core/chat/ChatProvider`
- 前後端共用型別：`@hyagent/shared`（repo 根目錄的 `shared/`）

這三個別名都要在 App 的 `tsconfig.json`（paths）、`package.json`（jest `moduleNameMapper`）、`metro.config.js` 設好，三處缺一不可。

## 新增一個 App

1. 以 `apps/store` 為參考，建立 `apps/<名稱>/`。從 store 複製 `package.json`、`tsconfig.json`、`babel.config.js`、`metro.config.js`、`jest.setup.js`，再改：
   - `package.json` 的 `name`；依賴版本要與其他 App 相同，因為整個工作區共用一套 Expo SDK
   - `app.json` 的 `name`、`slug`、`scheme`、圖示，以及之後上架用的 bundle id／package name
2. 寫自己的品牌設定（參考 `apps/store/src/brand/storeBranding.ts`），在根 `_layout.tsx` 用 `AppBrandingProvider` 包起來。
3. 根 layout 的 Provider 順序可參考 store：`QueryClientProvider` → `SettingsProvider` → `AuthProvider` → `ChatProvider`。
4. 後端：每個 App 對應一個租戶公開金鑰（`EXPO_PUBLIC_TENANT_API_KEY`）。領域工具開一個新的 MCP 服務（例如 `mcp/<領域>`），不要加在 store-demo。
5. 在 `mobile/` 執行 `npm install`，再跑 `npm run typecheck` 和 `npm test`。

## 注意事項

- **改 core 會影響所有 App。** 改完在 `mobile/` 跑全部的 typecheck 和測試，CI 也會跑。
- **原生套件由 App 宣告。** core 用到的 Expo 原生模組（如 `expo-audio`、`expo-secure-store`）列在 core 的 `peerDependencies`，每個 App 的 `dependencies` 都要有。Expo Go 內建所有模組，所以漏了也測不出來，要等到正式 build 才會發現。
- **Expo SDK 一起升級。** 共用一份 node_modules，各 App 不能停在不同 SDK 版本。
- Metro 會封鎖 repo 根目錄的 `node_modules`（網頁版的 React 18），避免打包到錯的 React。
