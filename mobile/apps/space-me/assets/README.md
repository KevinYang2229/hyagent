# SpaceMe 素材

| 路徑 | 內容 | 來源 |
| --- | --- | --- |
| `photos/hero.png` | 圖書館＋綠植的主視覺 | 由設計稿截圖（產品特色頁右上）裁切 |
| `photos/library.png`、`office.png`、`environment.png`、`consulting.png` | 四個解決方案的卡片照 | 由設計稿截圖（解決方案頁）裁切 |
| `photos/room-discussion.png`、`room-study.png`、`room-reading.png` | 討論室、研究小間、自習室 | 由設計稿截圖（圖書館空間管理頁）裁切 |
| `icon.png`、`android-icon-foreground.png`、`splash-icon.png`、`favicon.png` | 藍底機器人頭 App 圖示 | `node scripts/make-icons.mjs` 產生，造型與 `RobotHead` 一致 |

照片是從設計稿截圖裁切出來的，解析度約 500 px 寬，只適合 Demo 使用。拿到正式照片後，用相同檔名直接覆蓋即可，程式不需要改（登記在 `src/brand/assets.ts`）。
