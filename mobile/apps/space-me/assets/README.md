# SpaceMe 素材

| 路徑 | 內容 | 來源 |
| --- | --- | --- |
| `photos/hero.png` | 首頁主視覺背景 | 由設計稿截圖（產品特色頁右上）裁切 |
| `photos/library.png`、`office.png`、`environment.png`、`consulting.png` | 舊版解決方案卡片照（已停用） | 由設計稿截圖（解決方案頁）裁切 |
| `photos/room-discussion.png`、`room-study.png`、`room-reading.png` | 討論室、研究小間、自習室 | 由設計稿截圖（圖書館空間管理頁）裁切 |
| `icon.png`、`android-icon-foreground.png`、`splash-icon.png`、`favicon.png` | 藍底機器人頭 App 圖示 | `node scripts/make-icons.mjs` 產生，造型與 `RobotHead` 一致 |

舊版 PNG 照片是從設計稿截圖裁切出來的，解析度約 500 px 寬，只適合 Demo 使用。拿到正式照片後，用相同檔名直接覆蓋即可，程式不需要改（登記在 `src/brand/assets.ts`）。

## 首頁情境圖片

`photos/home-library.jpg`、`home-office.jpg`、`home-success.jpg`、`home-demo.jpg` 為 AI 生成的情境示意照片（2026-10-10），每張 766 × 510 px，分別用於圖書館、企業、成功案例及產品展示入口。成功案例圖片為情境示意，並非實際客戶場域照片；畫面中的介面亦非實際產品截圖。來源為同批生成的四格素材，裁切後以 JPEG 品質 90 儲存。首頁使用獨立的 `HOME_PHOTOS` 對應，解決方案也共用圖書館、辦公室與顧問情境素材。

## 解決方案情境圖片

四張方案卡片透過 `PHOTOS` 分別使用 `home-library.jpg`（圖書館）、`home-office.jpg`（智慧辦公）、`solution-environment.jpg`（智慧環控）與 `home-demo.jpg`（專業顧問）。智慧環控圖片為 1536 × 1024 px 的 AI 生成情境示意（2026-10-10），畫面中的控制面板並非實際產品介面。方案詳細頁及其他共用這些素材的區塊會同步更新；卡片尺寸、比例與裁切方式維持原樣。

### 解決方案橫幅比例

解決方案改用獨立的 `solution-*-banner.jpg`，從新情境圖中心裁切，沿用舊素材的寬高比：圖書館約 4.03:1、辦公室約 3.91:1、環控約 4.93:1、顧問約 4.78:1。首頁繼續使用未裁成橫幅的 `home-*.jpg`，不受影響。卡片版型未變更；圖片使用既有的 cover 裁切。

## 共用頁面背景

`photos/space-me-background.jpg` 為 AI 生成的明亮圖書館與協作空間情境背景（2026-10-10），1536 × 1024 px，左側留白、右側配置書架與植栽。透過 `PHOTOS.pageBackground` 用於解決方案頁，保留既有背景尺寸及漸層遮罩。首頁維持原本的 `PHOTOS.hero`（`hero.png`）。

## 產品特色專用背景

`photos/features-glass-background.jpg` 為 AI 生成的淡藍白抽象玻璃背景（2026-10-10），1536 × 1024 px，以玻璃曲面、柔光及邊緣連線暗示智慧管理，中央保留留白。透過 `PHOTOS.contactBackground` 用於聯絡我們頁，沿用輕度模糊與半透明淡藍白遮罩。解決方案維持原背景，首頁也保留原本背景。先前辦公室版本 `features-background.jpg` 已停用。

## 聯絡我們專用背景

`photos/contact-background.jpg` 為 AI 生成的接待與諮詢空間情境（2026-10-10），1536 × 1024 px，以淡藍座椅、木質圓桌及霧玻璃營造友善的聯絡氛圍。透過 `PHOTOS.featuresBackground` 用於產品特色頁，沿用共用的輕霧玻璃效果，不再使用首頁產品展示圖片。
