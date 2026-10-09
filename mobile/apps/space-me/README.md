# SpaceMe App（Expo）

SpaceMe 智慧空間（圖書館空間管理、OfficeMe 智慧辦公、智慧環控、顧問服務）的產品導覽 App，搭配 **HyAgent AI 產品顧問**。平板（iPad）橫放優先，手機也可以用。

App 結構與 `apps/store`、`apps/lib-one` 相同：分頁加上共用核心 `@hyagent/app-core`。**這個 App 只給訪客使用，沒有登入**：先顯示 App icon 啟動畫面（`src/chrome/LaunchView.tsx`），再進入開場轉導頁（`src/chrome/IntroView.tsx`）一邊播動畫，一邊在背景向後端換發訪客 Session，動畫播完就自動跳到首頁。拆分原則見 [`mobile/README.md`](../../README.md)。

## 畫面

| 畫面 | 路由 | 對應稿 |
| --- | --- | --- |
| 開場轉導頁（取代登入；連線失敗時可重試、修改伺服器位址） | `app/_layout.tsx` → `src/chrome/IntroView.tsx` | — |
| 首頁（主視覺、探索按鈕、揮手機器人、四張入口卡） | `app/(tabs)/index.tsx` → `src/home/HomeView.tsx` | 稿 4 |
| 解決方案（分類篩選、搜尋） | `app/(tabs)/solutions/index.tsx` → `src/solutions/SolutionsView.tsx` | 稿 3 |
| 方案詳細（空間類型卡，點了請 AI 顧問介紹） | `app/(tabs)/solutions/[id].tsx` → `src/solutions/SolutionDetailView.tsx` | 稿 2 左半 |
| 產品特色（六張特色卡） | `app/(tabs)/features.tsx` → `src/features/FeaturesView.tsx` | 稿 1 |
| 聯絡我們（AI 整理需求、諮詢服務、業務窗口） | `app/(tabs)/contact.tsx` → `src/contact/ContactView.tsx` | — |
| AI 產品顧問整頁對話 | `src/advisor/AdvisorPanel.tsx`（掛在 `app/(tabs)/_layout.tsx`） | 稿 2 右半 |
| 設定（朗讀、伺服器位址；入口在首頁右上角） | `app/settings.tsx` | — |

**AI 對話不是分頁。** 底部中央的機器人按鈕會打開一個面板，覆蓋在目前頁面上：平板與手機皆以整頁顯示，覆蓋底部導覽與中央按鈕；點返回後回到原本頁面，對話內容保留。開場白和建議問題會依所在頁面切換，例如在圖書館方案頁就問圖書館相關的問題（`src/advisor/prompts.ts`）。各頁的卡片和「問 AI 產品顧問」按鈕都透過 `useAdvisor().show(問題)` 打開面板並直接送出問題。

## 啟動

    cd mobile
    npm install
    cp apps/space-me/.env.example apps/space-me/.env.local   # 修改後端位址與租戶公開金鑰
    npm run dev:space-me

| 環境變數 | 用途 |
| --- | --- |
| `EXPO_PUBLIC_API_BASE` | 後端位址（連線失敗時可以在轉導頁修改，或到設定頁修改） |
| `EXPO_PUBLIC_TENANT_API_KEY` | 租戶公開金鑰（`pk_…`） |
| `EXPO_PUBLIC_CONTACT_PHONE`／`_EMAIL`／`_WEBSITE` | 「聯絡我們」頁的業務窗口；沒設定的項目不顯示 |

`.env.local` 的值會優先於啟動指令上給的同名變數。要臨時改連其他後端，請直接修改 `.env.local`，或改用設定頁。

## 後端需要的設定

- **租戶要開啟訪客使用**：在後台的「租戶設定」勾選「允許訪客免登入使用」（`guestAccess`，預設關閉）。沒開啟時，轉導頁會顯示「此服務目前未開放訪客使用」。
- **訪客的權限依「訪客部門」設定**：至少要有 `service:agent`；知識庫問答還需要 `service:knowledge`。
- **知識庫要匯入 SpaceMe 產品資料**，AI 顧問才能正確回答。畫面上的方案、特色文字整理自設計稿（`src/content/`），細節一律交給 AI 顧問依知識庫回答。
- **語音輸入**需要後端設定 `OPENAI_API_KEY`；沒設定時只能打字。

訪客 Session 過期時，App 會自動換一個新的，使用者不會察覺。網頁版沒有 SecureStore，Session 只存在記憶體，重新整理頁面就會換新的（`src/session/guestTokenStore.ts`）。

## 素材

照片、App 圖示的來源和重新產生方式，見 [`assets/README.md`](assets/README.md)。機器人是用 View 組成的元件（`src/brand/Brand.tsx`），不需要圖檔，任何尺寸都清晰。

## 測試

    cd mobile/apps/space-me
    npx jest
    npx tsc --noEmit

啟動順序：原生 Splash → App icon（0.8 秒）→ 轉導動畫 → 首頁。原生 Splash 設定修改後需要重新建置 App；網頁版會直接顯示 App icon 啟動畫面。

## 即時資訊顯示 MCP

對應示範服務在 [`mcp/space-me-demo`](../../../mcp/space-me-demo/README.md)，提供空間狀態、環境數據與有效公告。需在 HyAgent 後台登記服務並授予訪客部門權限，設定方式見服務 README。
