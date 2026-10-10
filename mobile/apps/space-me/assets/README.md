# SpaceMe 素材

| 路徑 | 內容 | 來源 |
| --- | --- | --- |
| `photos/hero.png` | 圖書館＋綠植的主視覺 | 由設計稿截圖（產品特色頁右上）裁切 |
| `photos/library.png`、`office.png`、`environment.png`、`consulting.png` | 四個解決方案的卡片照 | 由設計稿截圖（解決方案頁）裁切 |
| `photos/room-discussion.png`、`room-study.png`、`room-reading.png` | 討論室、研究小間、自習室 | 由設計稿截圖（圖書館空間管理頁）裁切 |
| `icon.png`、`android-icon-foreground.png`、`splash-icon.png`、`favicon.png` | 藍底機器人頭 App 圖示 | `node scripts/make-icons.mjs` 產生，造型與 `RobotHead` 一致 |

照片是從設計稿截圖裁切出來的，解析度約 500 px 寬，只適合 Demo 使用。拿到正式照片後，用相同檔名直接覆蓋即可，程式不需要改（登記在 `src/brand/assets.ts`）。

## 首頁情境圖片

`photos/home-library.jpg`、`home-office.jpg`、`home-success.jpg`、`home-demo.jpg` 為 AI 生成的情境示意照片（2026-10-10），每張 766 × 510 px，分別用於圖書館、企業、成功案例及產品展示入口。成功案例圖片為情境示意，並非實際客戶場域照片；畫面中的介面亦非實際產品截圖。來源為同批生成的四格素材，裁切後以 JPEG 品質 90 儲存。首頁使用獨立的 `HOME_PHOTOS` 對應，其他頁面仍使用原本素材。
