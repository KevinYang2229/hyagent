# LIB ONE App（Expo）

LIB ONE 產品與服務的 AI 導覽 App，以 **HyAgent 對話為核心**：首頁輸入框、熱門問題、產品頁、比較頁的「問 HyAgent」都會直接進入對話；HyAgent 回覆中提到的產品，會在回覆下方顯示產品卡，點選即可查看產品。平板（iPad）優先，手機也可以使用。

App 結構與門市小幫手（`apps/store`）相同：分頁加上共用核心 `@hyagent/app-core`，核心提供身分、對話、語音與確認彈窗。差別在於**這個 App 沒有登入**：開場轉導頁（`src/chrome/IntroView.tsx`）播放動畫的同時，在背景向後端換發訪客 Session，動畫播完就直接進首頁。拆分原則請參考 [`mobile/README.md`](../../README.md)。

## 畫面

| 分頁 | 路由 | 稿 |
| --- | --- | --- |
| 首頁 | `app/(tabs)/index.tsx` → `src/home/HomeView.tsx` | 01 |
| 產品探索（分類篩選、加入比較） | `app/(tabs)/products/index.tsx` | 03／04 |
| 產品詳細（同系列縮圖、亮點、聯絡諮詢） | `app/(tabs)/products/[id].tsx` → `src/catalog/ProductDetailView.tsx` | 06 |
| HyAgent 對話（底部導覽正中間） | `app/(tabs)/chat.tsx` | 02 |
| 產品比較 | `app/(tabs)/compare.tsx` | 05 |
| 聯絡我們 | `app/(tabs)/contact.tsx` | — |
| 開場轉導頁（取代登入；連線失敗時可重試、改伺服器位址） | `app/_layout.tsx` → `src/chrome/IntroView.tsx` | — |
| 設定（品牌列右上齒輪：朗讀、伺服器位址） | `app/settings.tsx` | — |

底部導覽五格平均分配，HyAgent 位於中間。

## 啟動

    cd mobile
    npm install
    cp apps/lib-one/.env.example apps/lib-one/.env.local   # 修改後端位址與租戶公開金鑰
    npm run dev:lib-one

| 環境變數 | 用途 |
| --- | --- |
| `EXPO_PUBLIC_API_BASE` | 後端位址（連線失敗時可以在轉導頁修改，或到設定頁修改） |
| `EXPO_PUBLIC_TENANT_API_KEY` | 租戶公開金鑰（`pk_…`） |
| `EXPO_PUBLIC_CONTACT_PHONE`／`_EMAIL`／`_WEBSITE` | 「聯絡我們」頁的業務窗口；未設定的項目不會顯示 |

## 後端需要的設定

- **租戶要開啟訪客使用**：在後台「租戶設定」勾選「允許訪客免登入使用」，也就是 `guestAccess`，預設關閉。App 會帶 `EXPO_PUBLIC_TENANT_API_KEY` 呼叫 `POST /api/auth/guest`，換發訪客 Session。未開啟時，轉導頁會顯示「此服務目前未開放訪客使用」。
- **訪客的權限依「訪客部門」設定**：至少要開 `service:agent`，知識庫問答另外要開 `service:knowledge`。這跟網站 widget 訪客是同一套設定。
- **知識庫要匯入 LIB ONE 產品資料**，HyAgent 才能正確回答。對話中的產品卡，是依回覆文字比對 `src/catalog/catalog.ts` 的產品名稱、英文名稱與別名產生；回覆提到產品名稱，才會出現卡片。
- **語音輸入**需要後端設定 `OPENAI_API_KEY`；未設定時，App 只提供打字輸入。

訪客 Session 過期時，App 會自動換一個新的，使用者不會察覺。租戶關閉訪客使用後，既有 Session 會立即失效，App 會回到轉導頁顯示原因。

## 產品目錄與素材

- 產品線、功能條列、分類標語都依 lib-one.com 官網整理，資料在 `src/catalog/catalog.ts`。每項產品的一句話介紹是依官網功能條列改寫的摘要。比較表只列官網功能看得出來的項目，例如外型、RFID／條碼辨識、多語介面，不列官網沒寫的規格。
- 素材都取自 lib-one.com 官網的原始檔：
  - `assets/brand/logo.png`：由官網 `lib-one-logo.svg` 輸出的高解析字標。
  - App 圖示由官網 `lib-one-mark.svg` 輸出：
    - `icon.png`：iOS 圖示，1024 白底。
    - `android-icon-foreground.png`、`android-icon-monochrome.png`：Android 自適應圖示的透明前景與系統主題用的單色版。
    - `splash-icon.png`：啟動畫面，由 `expo-splash-screen` 外掛設定。
    - `favicon.png`：網頁版用。
  - `assets/products/<產品 id>.png`：官網 800×800 的去背產品圖。畫面上由 `ProductArt` 疊在漸層展示底上。
  - `assets/scene/`：首頁長景的分層素材，比照官網首頁輪播的做法。
    - `library.jpg`：圖書館線稿背景。
    - `flow.png`：綠色弧線。
    - `child.png`、`space.png`、`staff.png`：三組去背人物（借還書、座位預約、館員工作站），以同一比例尺輸出。
    - 由 `src/home/HeroScene.tsx` 在 App 裡組合：背景與弧線滿版並延伸出畫面兩側，人物依可用空間等比縮放。
- 官網新增或更換產品時，在 `catalog.ts` 加一筆並放入產品照，填上 `image: require(...)`。卡片、詳細頁、比較表和 HyAgent 回覆下的產品卡都會自動帶出。

## 版面原則：盡量一屏放完

首頁、產品探索、產品詳細、產品比較都依實際可用高度計算版面，平板（橫放、直放）與一般手機不需要捲動：

- **首頁**：`homeLayout()` 依高度分配分類卡、長景與標語，字級隨之縮放。
- **產品探索**：`gridFit.ts` 決定版面。平板橫放一列三張、填滿寬度；直放一列兩張、靠左，卡片尺寸（`tabletCard`）與方向、分類無關：寬度沿用橫放三張的寬度，圖高取兩種方向都放得下項目最多的分類（5 項）的值，轉向或換分類時卡片完全一樣大。空間緊時卡片改成精簡版。
- **產品詳細**：展示圖吃剩下的高度。手機的產品特色預設收起。
- **產品比較**：表頭產品圖依剩餘高度縮放。

只有內容本來就放不下時才保留捲動，例如「全部 12 項產品」（平板也要捲動），以及 HyAgent 對話。

## 打包

App 圖示和啟動畫面只會出現在打包後的 App。用 **Expo Go** 開啟時，桌面圖示與名稱永遠是 Expo Go 自己的。要在裝置上看到 Lib One 圖示，用其中一種方式打包：

    npx expo run:ios          # 或 npx expo run:android，需要 Xcode／Android Studio
    eas build -p ios --profile preview   # 需要 Expo 帳號與 eas.json

## 測試與預覽

    cd mobile/apps/lib-one
    npx jest
    npx tsc --noEmit

視覺預覽不需要登入，會使用固定資料：

    mkdir -p public && cp scripts/preview.html public/_preview.html
    npx expo start --web

開啟 `/_preview.html#home`、`#chat`、`#products`（或 `#products-entry` 等分類）、`#detail`、`#compare`、`#intro` 或 `#intro-error`。完成後刪除 `public/`。截圖存放在 `docs/`。
