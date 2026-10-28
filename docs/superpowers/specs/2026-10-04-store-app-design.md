# 門市店員 App（Expo）設計

日期：2026-10-04
分支：`feature/store-app`（從 `feature/store-demo-backend` 分出；兩個後端分支暫不合併回 `main`）
前置：`2026-10-03-mcp-client-design.md`、`2026-10-03-store-demo-backend-design.md`

## 1. 目的與成功標準

做一個 7-ELEVEN 門市店員用的 POC Demo App，跟網頁版共用同一個 HyAgent 後端。

**成功標準**：在 iPad 與 Android 平板上，用 Expo Go 把以下五個情境順暢跑完。

1. 語音對話
2. 拍照辨識貨架 → 建立補貨單
3. 問庫存 → 建立補貨單（可修改）
4. 知識庫問答（含設備故障排除）
5. 活動／優惠券查詢（拍照，掃條碼為備案）

**不做**：上架商店、推播、多門市切換、門市報表、離線模式。

## 2. 裝置與版面

- **平板（橫向）為主**：照四張設計稿精做。設計稿存放在 `.superpowers/app-design/1–4.png`，不進版控：
  - 1：補貨單確認彈窗
  - 2：貨架辨識結果
  - 3：AI 對話（語音中）
  - 4：首頁
- **手機**：沿用同一套畫面。寬度 < 900 時，左右兩欄改成上下單欄，表格可以左右滑。只確保版面不跑掉，不另外設計。
- **iPad 與 Android 都要支援**。全部功能只用 Expo Go 內建的套件，不需要建置開發版，也不需要 Apple 開發者帳號。

## 3. 畫面

### 3.1 共同外框

- **頂部列**：7-ELEVEN 標誌、門市名稱（固定一間，只顯示）、🔔 通知（沿用現有的通知 API，顯示紅點數字）、店員頭像＋姓名＋職稱。
- **底部分頁**：首頁／AI 對話／任務／我的。任務分頁在有新補貨單時顯示紅點。

### 3.2 照設計稿的畫面

| 畫面 | 稿 | 內容 |
|---|---|---|
| 首頁 | 4 | Open醬打招呼；三個入口：語音對話／拍照問 AI／輸入文字；右欄「今日重點」；下方「常用情境」 |
| AI 對話（語音中） | 3 | 左半：Open醬、波形、「正在聽你說話…」、「你可以說」範例句，下方三鈕：鍵盤輸入／結束對話／拍照。右半：對話串，表格直接放在 AI 泡泡裡，下方輸入列 |
| 貨架辨識結果 | 2 | 屬於 AI 對話分頁。左：照片加框選（缺貨紅、即期橘並標日期、擺放錯誤紫、正常綠）。右：「我看到 N 個需要處理的項目」，依缺貨／即期品／擺放錯誤分組。按鈕：再拍一張／建立補貨單（N 項） |
| 補貨單確認彈窗 | 1 | 蓋在目前畫面上。有 Open醬、全選勾選、商品圖＋名稱、目前庫存、可修改的建議補貨數量（紅底）、到貨日期、取消／確認建立補貨單。**對話中的補貨確認與貨架辨識後的補貨確認共用這個彈窗** |

**今日重點（四項，即時資料）**：

| 項目 | 點擊後帶入 AI 對話的問題 |
|---|---|
| 庫存偏低 N 項（列出品名） | 「哪些商品庫存偏低？」 |
| 即期品 N 項 | 「今天有哪些即期品？」 |
| 設備異常 N 項（例如「咖啡機紅燈」） | 「咖啡機紅燈怎麼處理？」 |
| 今日補貨單 N 張 | 切到任務分頁 |

**常用情境（六個）**：

| 項目 | 帶入的問題 |
|---|---|
| 查詢庫存 | 「幫我查庫存」 |
| 建立補貨單 | 「幫我把庫存偏低的商品建立補貨單」 |
| 即期品管理 | 「今天有哪些即期品？」 |
| 設備故障排除 | 「設備故障怎麼排除？」 |
| 促銷活動查詢 | 「現在有什麼活動？」 |
| 會員活動 | 「現在有什麼會員活動？」 |

「門市報表」不做。

### 3.3 設計稿沒有、照同一風格補的畫面

已在 2026-10-04 用畫面草圖確認。

- **相機（全螢幕）**：上方切換「貨架／優惠券／掃條碼」三種模式；中間是取景框；下方是快門和相簿。掃條碼模式下，掃到條碼就直接跳到結果。
- **優惠券結果**：屬於 AI 對話分頁，版型同稿 2。
  - 左：券的照片。
  - 右：券名、狀態標籤（可使用綠／不可用或過期紅）、券號、適用範圍、條件、期限。
  - 按鈕：再拍一張／問 AI。
  - 辨識不出券號時，提示改用掃條碼。
- **AI 對話（不在語音中）**：左半是 Open醬待機畫面、「你可以說」範例句，以及三個按鈕：鍵盤輸入／開始說話／拍照。右半同稿 3；對話標題列放「🔊 朗讀 開／關」和「⟳ 新對話」。
- **任務**：補貨單卡片列表，每張顯示單號、狀態、品項數、到貨日、建立時間、前幾個品名。點卡片後，從右側滑出明細。
- **我的**：店員資訊、朗讀開關（與對話頁同步）、伺服器位址、登出。
- **登入**：帳號密碼，配上 Open醬歡迎畫面。

### 3.4 品牌素材

Open醬與 7-ELEVEN 標誌由使用者提供去背 PNG。需要的姿勢：打招呼、拿麥克風、待機三種，另加標誌。

素材放在 `app/assets/brand/`。拿到之前先用灰色占位圖，檔名與尺寸先固定，之後直接換檔就好。

## 4. 架構

### 4.1 專案結構

- **`app/` 是 monorepo 內的獨立 npm 專案，不加入 npm workspaces**：使用 Expo SDK 57、Expo Router、TypeScript，在 `app/` 內自己 `npm install`。
  - 原因：`client/`、`admin/`、`ui/` 用 React 18，Expo SDK 57 需要 React 19。若加入 workspaces，`react-native` 會被提升到根目錄的 `node_modules`，抓到 React 18 而壞掉。
- **共用型別**：`shared/` 沒有任何依賴，用路徑別名直接引用 `../shared/src/index.ts`，在 App 內仍寫 `import … from '@hyagent/shared'`。
  - 引用的型別包括 `PendingActionView`、`ConfirmForm`、`DisplayBlock`、`TableColumn`、`ConfirmTableColumn` 等。
  - TypeScript 用 `paths`，Metro 用 `extraNodeModules` 加 `watchFolders`，Jest 用 `moduleNameMapper`。
- **根目錄 `package.json`**：`typecheck`、`test` 以 `npm --prefix app run …` 呼叫 App；`eslint.config.js` 忽略 `app/`，由 App 自己的設定處理。

```
app/
  app/                    Expo Router 路由
    _layout.tsx           登入守門、React Query provider
    login.tsx
    camera.tsx            全螢幕相機（mode: shelf | coupon | barcode）
    (tabs)/
      _layout.tsx         頂部列＋底部分頁
      index.tsx           首頁
      chat/
        index.tsx         AI 對話
        shelf-result.tsx  貨架辨識結果
        coupon-result.tsx 優惠券結果
      tasks.tsx
      me.tsx
  src/
    api/                  fetch 包裝、token 換發、各 API 函式
    chat/                 對話狀態（reducer）、訊息元件、表格區塊元件
    confirm/              補貨確認彈窗（依 ConfirmForm 產生）
    voice/                錄音、轉文字、朗讀
    vision/               照片縮圖、上傳、框選繪製
    theme/                設計 token（顏色、圓角、陰影、字級）
    layout/               useIsWide（寬度 ≥ 900）
  assets/brand/           Open醬、標誌（先用占位圖）
```

### 4.2 狀態與資料

- **React Query**：今日重點、補貨單列表、通知。補貨單建立成功後，讓今日重點與補貨單列表的快取失效、重新取資料。
- **對話狀態**：放在 `src/chat/`，用 `useReducer` 加 context 管理，不放進 React Query。內容包括：
  - 對話 id、訊息串（文字、表格區塊、系統提示）
  - 目前待確認的動作
  - 送出中的狀態
- **儲存位置**：
  - 登入 token：`expo-secure-store`
  - 朗讀開關、伺服器位址：AsyncStorage

### 4.3 使用的 Expo 套件

Expo Go 都能執行：

| 套件 | 用途 |
|---|---|
| `expo-audio` | 錄音 |
| `expo-speech` | 朗讀 |
| `expo-camera` | 拍照與掃條碼 |
| `expo-image-picker` | 從相簿選照片 |
| `expo-image-manipulator` | 上傳前縮圖、轉 JPEG |
| `expo-secure-store` | 存登入 token |

樣式用 React Native 的 `StyleSheet` 加 `src/theme/`，不引入其他 UI 套件。

## 5. 後端新增項目

原則：HyAgent 平台層是通用的，不寫死門市邏輯；門市專屬的東西放在門市 Demo 服務。

### 5.1 語音轉文字：`POST /api/speech/transcribe`

- 套用 `resolveTenant`、`requireAuth`、租戶流量限制、月額度。
- 輸入：multipart，`audio` 欄位。
  - 格式：`audio/m4a`、`audio/mp4`、`audio/x-m4a`、`audio/webm`、`audio/wav`。
  - 大小 ≤ 10MB；App 端錄音上限 60 秒。
- 處理：用 `OPENAI_API_KEY` 呼叫 OpenAI 語音轉文字，語言指定 `zh`。
- 回應：`{ text: string }`。
- 錯誤：

| 狀況 | 回應 |
|---|---|
| 沒有檔案、格式不支援或超過大小上限 | 422（沿用影像上傳的寫法） |
| 未設定 `OPENAI_API_KEY` | 503 `SPEECH_UNAVAILABLE` |
| 上游失敗 | 502 `SPEECH_FAILED` |

- 錄音檔不落地、不寫入日誌。

### 5.2 直接呼叫唯讀工具：`POST /api/tools/:toolId/invoke`

- 套用 `resolveTenant`、`requireAuth`、租戶流量限制。
- 輸入：`{ input: object }`。
- 只允許 `agentExposed` 且 effect 為 read 的工具：

| 狀況 | 回應 |
|---|---|
| 不存在或未開放給 agent | 404 `TOOL_NOT_FOUND` |
| 寫入工具（含未標示 effect 的工具） | 422 `NOT_A_READ_TOOL` |
| 權限不足 | 403 |
| 輸入驗證失敗 | 422（沿用工具註冊中心的檢查） |
| MCP 服務無法連線 | 503 `TOOL_UNAVAILABLE` |

- 權限、輸入驗證、稽核都沿用工具註冊中心的 `invoke`。
- 回應：`{ result: unknown, block?: DisplayBlock }`。工具有表格提示時，用 `buildDisplayBlock` 產生 `block`。
- 這支 API 是通用的。首頁「今日重點」、任務分頁、掃條碼查券都透過它呼叫門市工具。

### 5.3 門市 Demo 服務（`mcp/store-demo`）

- **新工具 `store_today_summary`（唯讀）**，回傳：
  ```
  { lowStock: { count, names[] },
    expiring: { count, names[] },
    equipmentAlerts: { count, items: [{ name, issue }] },
    replenishmentsToday: { count } }
  ```
  其中 `replenishmentsToday` 只計算這位呼叫者、今天（Asia/Taipei）建立的補貨單。
- **新工具 `replenishment_list`（唯讀）**：列出這位呼叫者、同一租戶建立的補貨單，新的在前，內容包含品項明細。補貨單只存在記憶體，服務重啟後就清空，Demo 可以接受。
- **新資料 `data/equipment.json`**：設備狀態假資料，至少一筆異常，例如「咖啡機：紅燈閃爍」。
- **活動資料**：`data/promotions.json` 加入 2～3 筆會員活動，類別為「會員」，沿用 `promotion_list`。

### 5.4 不用改的（已完成）

- `POST /api/vision/analyze`（shelf / coupon）
- `POST /api/conversations/:id/actions/propose`
- `/actions/:actionId/confirm`、`/actions/:actionId/cancel`
- 對話的建立與訊息 API，回應裡已經帶 `blocks`、`pendingAction`

### 5.5 知識庫

不寫新程式，用使用者提供的文件匯入。至少需要：

- 設備手冊：回答「咖啡機紅燈怎麼處理」。
- 門市作業 SOP。

## 6. 主要流程

### 6.1 對話

- App 開啟、第一次進入 AI 對話分頁時，建立一個對話；之後的訊息都送進這個對話。按「新對話」才重開。
- 首頁入口、今日重點、常用情境：切到 AI 對話分頁，並送出對應的問題。
- 收到回覆後：
  - 有 `blocks`：在 AI 泡泡內畫表格。
  - 有 `pendingAction`：跳出補貨確認彈窗。

### 6.2 語音

1. 按麥克風，開始錄音，進入稿 3 的「聆聽中」畫面。
2. 按「結束對話」或錄滿 60 秒時停止。
3. 錄音上傳到 `/speech/transcribe`。
4. 轉出的文字先顯示成店員的對話泡泡，再送出訊息。
5. 回覆出來後，如果朗讀開關是開的，用 `expo-speech` 唸文字部分：先去掉 markdown 符號，語言設為 `zh-TW`；表格與卡片不唸。
6. 正在朗讀時按麥克風：立刻停止朗讀，開始錄音。

### 6.3 補貨確認彈窗

- 內容依 `PendingActionView.form`（`ConfirmForm`）產生：
  - 可編輯欄位：數量、日期、勾選。
  - 唯讀欄位：品名、庫存、圖片。
- 確認時，把修改後的內容送到 `/confirm`：

| 結果 | 處理 |
|---|---|
| 成功 | 關閉彈窗，對話中加一則結果訊息；任務分頁出現紅點；今日重點與補貨單列表重新取資料 |
| 422 `ACTION_INPUT_INVALID` | 彈窗保持開著並顯示錯誤，可以修改後再送 |
| 503 `TOOL_UNAVAILABLE` | 彈窗保持開著，提示稍後再試 |
| 409（過期或已處理） | 關閉彈窗，在對話中說明 |

- 取消時呼叫 `/cancel`。

### 6.4 貨架辨識

1. 拍照或從相簿選照片。
2. 用 `expo-image-manipulator` 把長邊縮到 1600px、轉成 JPEG（品質 0.8），確保小於 5MB。
3. 上傳到 `/vision/analyze`（mode=shelf）。
4. 跳到貨架辨識結果頁，依 `findings` 畫框（相對座標）與分組清單。
5. 結果裡有 `replenishment` 時，「建立補貨單（N 項）」按鈕才可以按。按下後，用它的 `toolId` 和 `input` 呼叫 `/actions/propose`，接著跳出補貨確認彈窗。

### 6.5 優惠券

- **拍照**：照片處理同 6.4，上傳到 `/vision/analyze`（mode=coupon），結果顯示在優惠券結果頁。
- **掃條碼**：條碼內容就是券號，呼叫 `/tools/mcp.store-demo.coupon_check/invoke`，輸入 `{ code }`，結果顯示在優惠券結果頁。
- **問 AI**：在對話中送出「客人的優惠券 {券號} 可以用嗎？還有什麼要注意的？」。

## 7. 錯誤處理

| 情況 | App 的反應 |
|---|---|
| 網路斷線、逾時 | 提示訊息加「重試」，已輸入的文字保留 |
| 401 | 用 refresh token 換新 token，失敗就回登入頁 |
| 沒給麥克風或相機權限 | 說明用途，提供「前往設定」按鈕；語音不能用時改打字 |
| 轉出空字串 | Open醬說「沒聽清楚，再說一次好嗎？」 |
| `SPEECH_UNAVAILABLE`（503） | 這次登入期間隱藏麥克風，只能打字 |
| `VISION_FAILED`（502） | 「看不太清楚，再拍一張試試」；優惠券另外提示改用掃條碼 |
| 今日重點取資料失敗 | 卡片顯示「暫時無法取得」，不影響其他功能 |

## 8. 測試

- **後端（Jest）**：
  - `/speech/transcribe`：格式錯誤、未設定 key、上游失敗、沒有權限、成功。
  - `/tools/:toolId/invoke`：唯讀成功並附表格、寫入工具被擋、未開放的工具、沒權限、輸入錯誤。
- **門市服務（Vitest）**：
  - `store_today_summary`：計數與名稱，今日補貨單只算呼叫者自己的。
  - `replenishment_list`：只列呼叫者與同租戶的單，新的在前。
  - 會員活動能被 `promotion_list` 查到。
- **App（Jest＋`@testing-library/react-native`）**：
  - 對話 reducer 的狀態轉換。
  - 確認彈窗：勾選、改數量、送出內容，以及 422 錯誤保持開著、409 關閉。
  - 語音流程的狀態：待機 → 錄音 → 轉文字 → 送出，以及朗讀被打斷。
  - API 層：401 換發 token 後重試。
- **實機**：準備 Demo 檢查清單。在 iPad 與 Android 平板上用 Expo Go 把五個情境各跑一次；後端用區網 IP（在「我的」頁面設定）或 Zeabur 網址。

## 9. 待使用者提供

- Open醬三種姿勢與 7-ELEVEN 標誌的去背 PNG。
- 知識庫文件：設備手冊、門市作業 SOP。
- 辨識調校用的貨架與優惠券實拍照片（另外用 `vision-eval` 驗證，不擋 App 開發）。
