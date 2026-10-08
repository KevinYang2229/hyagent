# 品牌素材

`mascot-tasks.png`：任務中心拿工作板的半身角色；2026-10-05 使用內建 imagegen，依附件 `截圖 2026-10-05 凌晨1.08.05.png` 製作，存放於本資料夾。

最終提示：
> Use case: illustration-story. Reference screenshot: reproduce ONLY the task-center mascot in the upper center. Transparent PNG illustration for store app. Same round cream face, rainbow arch green outer band then red/yellow separated by white navy outlines, viewer left eye winking and right eye open, happy open mouth and blush. White store uniform with small 7 logo and green trim, compact body. Viewer LEFT hand holds an upright clipboard with pale paper, viewer RIGHT arm resting bent at waist. Half-body waist-up, upright centered horizontally, flat clean 2D illustration faithful to screenshot proportions. Do not include bubbles, text, UI, scenery, sparkles, or background. Tight even transparent margins, no cut off head or clipboard.

依使用者提供的門市 App 截圖，以內建 imagegen 重繪（2026-10-04）。這些是參考稿重繪素材，並非官方原始圖檔。原占位圖保留，新版使用 `-v2` 檔名。

| 檔名 | 內容 | 使用位置 |
|---|---|---|
| `store-background.png` | 模糊門市內景，下方淡薄荷色漸層 | 首頁、登入背景 |
| `mascot-home.png` | 首頁專用半身 Open醬（更接近原稿比例） | 首頁 |
| `staff-avatar-home.png` | 藍底簡筆店員頭像 | 頂部列、我的 |
| `logo-v2.png` | 透明背景 7-ELEVEN 橫式標誌 | 頂部品牌列 |
| `mascot-wave-v2.png` | 透明背景 Open醬揮手 | 首頁、登入、確認彈窗 |
| `mascot-confirm.png` | 依補貨確認參考圖重繪，双眼睜開、左側揮手、頭飾水平 | 補貨確認彈窗右側 |
| `mascot-mic-v2.png` | 透明背景 Open醬拿綠色麥克風 | 語音聆聽 |
| `mascot-idle-v2.png` | 透明背景 Open醬微笑待機 | AI 對話待機 |

## 生成提示重點

共同參考：`截圖 2026-10-03 凌晨1.18.33.png`，只參考圖像內容。素材中不包含介面、卡片、對話框或裝置外框。

- 背景（photorealistic-natural）：寬幅台灣便利商店，兩側商品貨架、暖亮天花板燈光，強烈失焦，奶油米色高光，下方三分之一柔和淡薄荷白色霧化；不含人物、文字、logo 或 UI。
- Logo（logo-brand）：獨立重繪左上 7-ELEVEN 標誌，紅橘色數字 7、深綠 ELEVEN 字樣、橫式構圖，透明背景，無底板、邊框或陰影。
- 揮手（illustration-story）：忠於參考的綠紅橘黃彩虹頭飾、深藍輪廓、奶油色臉、粉紅臉頰、棕色鼻子，眨眼微笑，一手揮手，白色門市制服與綠褲；完整身體含雙腳、居中留白、透明背景。
- 麥克風（illustration-story）：同一角色配色與制服，閉眼傾聽、手持綠白麥克風靠近臉頰；完整身體、透明背景，不含聲波。
- 待機（illustration-story）：同一角色配色與制服，雙眼睜開、友善微笑、雙手自然放鬆；完整身體、透明背景。

角色圖片使用 `contain` 顯示，避免裁掉彩虹頭飾或雙腳。請勿執行占位圖腳本覆蓋這些重繪素材。

## 補貨確認角色（2026-10-05）

使用內建 imagegen；參考附件 `0557fb72-5517-4dc4-b918-e5997d534189/image-1.png`。
最終提示：

> Use case: background-extraction. Asset type: transparent PNG mascot for replenishment confirmation dialog. Input image: reference screenshot. Reproduce ONLY the full-body mascot at the BOTTOM RIGHT of the screenshot, remove all background, bubble, typography, marks, UI and tablet. Faithfully match that specific mascot: upright level symmetric rainbow arch headdress with green outer band, red then yellow with thin white separators and navy outlines; round cream face, BOTH dark round eyes OPEN, tiny brown oval nose, pink cheeks, happy open mouth. The hand on viewer LEFT raised in a wave, viewer RIGHT hand bent at waist. Small white store uniform top and solid green trousers and dark green shoes, short compact body exactly like reference. Flat clean 2D illustration, no gradients or added details, no winking, no tilt. Center full character horizontally in canvas, complete silhouette with small even transparent margins. Genuine transparent background.
