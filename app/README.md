# 門市小幫手 App（Expo）

7-ELEVEN 門市店員 POC Demo。平板（iPad、Android）為主，手機可用。用 **Expo Go** 開啟，不需要建置開發版。

技術版本：Expo 57.0.26、React 19.2.3、React Native 0.86.3。

## 安裝

`app/` 是 monorepo 內的獨立 npm 專案（不在根目錄 workspaces 內，因為 App 用 React 19、網頁版用 React 18）：

    cd app
    npm install

## 啟動

    cd app
    EXPO_PUBLIC_API_BASE=http://<電腦的區網 IP>:3000 npx expo start

平板與電腦連同一個 Wi-Fi，用 Expo Go 掃終端機上的 QR code。伺服器位址也可以在登入頁的「伺服器設定」欄位修改；在「我的」分頁改伺服器會同時登出，需重新登入。

| 環境變數 | 用途 | 預設 |
|---|---|---|
| `EXPO_PUBLIC_API_BASE` | 後端位址 | 空（登入頁填） |
| `EXPO_PUBLIC_STORE_SERVER_ID` | 門市 MCP 服務 id | `store-demo` |
| `EXPO_PUBLIC_STORE_NAME` | 頂部列顯示的門市名稱 | `中山門市` |

## 後端需要的設定

- 門市 Demo 服務（`mcp/store-demo`，共 7 個工具）已在後台註冊。啟動範例：`MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://<區網 IP>:4200 PORT=4200 npm start -w mcp/store-demo`。`PUBLIC_BASE_URL` 必須是**平板連得到**的位址（商品圖片網址由它組成，不能用 `localhost`）。
- 店員帳號需要 `service:agent` 與 `mcp:store-demo` 權限。
- 語音對話需要後端設定 `OPENAI_API_KEY`（可用 `SPEECH_MODEL` 換模型，範例見 `server/.env.example`）；沒設定時 App 會自動改成只能打字。
- 設備故障排除、門市作業問答需要在知識庫匯入對應文件。

## 品牌素材

`assets/brand/` 目前是灰底占位圖，拿到正式的 Open醬與標誌後用同檔名覆蓋，見該資料夾的 README。

## 測試

    cd app
    npx jest
    npx tsc --noEmit

根目錄的 `npm run typecheck` 也會一併執行 App 的型別檢查。
