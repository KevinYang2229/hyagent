# Usage 分頁 Token 錶盤（Highcharts Gauge）設計

日期：2026-07-06

## 目標

把 admin Usage 分頁的「Token 數」純數字（[admin/src/pages/tabs/UsageTab.tsx:32](../../admin/src/pages/tabs/UsageTab.tsx)）改成 Highcharts dial gauge（指針 + 彩色弧帶），刻度動態貼合 token 使用量。對話數／訊息數／送出數維持數字磚。

## 背景與限制

- `usage.llmTokens` 是**永不歸零的累計總量**（無期間、無額度、無上限）——[server/src/modules/usage/usage.store.ts](../../server/src/modules/usage/usage.store.ts)。因為無上限，錶盤最大值必須動態決定。
- admin 是 Vite + React 18；**Highcharts 尚未安裝**，將以 npm 依賴加入（非 CDN，無 CSP 問題）。
- 前端（admin/ui/client）目前**無任何測試框架**，僅 server 用 Jest。本案為 admin 引入最小 Vitest。
- 主題：`<html data-theme="light|dark">` 由 [admin/src/theme.ts](../../admin/src/theme.ts) 寫入；設計 token（CSS 變數）由 `@oa-agent/ui` 提供。

⚠️ **授權提醒**：Highcharts 商用需付費授權（非 MIT）。正式上線前須確認授權。使用者明確指定用 Highcharts，故本設計採用之。

## 決策彙整

- 只有 Token 指標改錶盤；其餘三指標維持數字磚。
- **刻度**：動態自適應（見下）。
- **色帶語意**：動態刻度下指針恆落中後段，故色帶為**位置性裝飾**（綠→琥珀→紅由左到右），量的資訊靠指針位置 + 中央 K/M 大讀數。非絕對警示。
- **版面**：Token 錶盤置頂放大單獨一區；三數字磚置於下方。
- **整合**：`highcharts` + `highcharts-react-official`（官方 React wrapper）。
- **測試**：admin 加入 Vitest，對純函式寫單元測試。

## 動態刻度演算法（純函式 `niceGaugeMax`）

給定目前累計 `v = llmTokens`（整數 ≥ 0）：

- `v <= 0` → 回 `1000`（小預設上限，指針停在 0，錶盤仍正常渲染）。
- 否則：
  1. `target = v / 0.8`（希望指針落在約 80% 位置，保留頂端餘裕、不頂到底）。
  2. `nice(target)` = `{1, 2, 5} × 10ⁿ`（n 為整數，含 10 進位如 …、5, 10, 20…）數列中「≥ target 的最小值」。
  3. 回 `Math.max(1000, nice(target))`。

**下限 1000 統一套用於所有情況**（含 v>0）：token 量很快就破千，錶盤上限若是個位/百位數毫無意義。故 `v` 很小時上限仍為 1000。

效果：指針恆落約 40–80% 弧段（v ≥ 約 800 時；更小的 v 因 1000 下限而更靠左），不頂底也不縮在起點。

- **主刻度間隔** = `max / 5`（6 個主刻度：0, max/5, …, max）。
- **刻度標籤**與**中央讀數**用 `formatTokens`。

### 純函式 `formatTokens(n)` → string（K/M 縮寫）

- `n < 1000` → 整數字串（如 `850`）。
- `1000 ≤ n < 1_000_000` → `n/1000` 去尾零、最多一位小數 + `K`（如 `1K`、`1.5K`、`12.3K`）。
- `n ≥ 1_000_000` → `n/1_000_000` 去尾零、最多一位小數 + `M`（如 `1M`、`2.4M`）。

「去尾零」：`1.0K` → `1K`；`1.20M` → `1.2M`。

## 色帶與主題

- **弧帶三段**（位置性，佔比固定）：低 0–60% 綠、中 60–85% 琥珀、高 85–100% 紅。採 dataviz 已驗證的 status 調色盤（good `#0ca30c` / warning `#fab219` / critical `#d03b3b`），**固定不隨主題**（該調色盤在深淺兩面皆通過驗證）。
- **錶盤外框／刻度文字／指針**：取自設計 token（`--text-primary`、`--text-secondary`、`--border-color`），透過 `getComputedStyle(document.documentElement)` 讀取具體色值餵給 Highcharts。
- **中央讀數**：大字顯示 `formatTokens(tokens)`，副標「累計 Token」。
- **主題切換即時反映**：`theme.ts` 新增 `useTheme()` hook，用 `MutationObserver` 監看 `<html>` 的 `data-theme` 屬性變動，回傳目前 `Theme`；TokenGauge 依它重算 options 並 redraw。不改 AppLayout（避免 prop drilling）。

## 元件切分與資料流

```text
UsageTab (既有)
  └─ getUsage(tenantId) → usage.llmTokens
       └─ <TokenGauge tokens={usage.llmTokens ?? 0} />   ← 置頂
       └─ <div className="stats"> 對話數／訊息數／送出數 三磚 </div>  ← 下方
```

- **`admin/src/components/tokenGauge.util.ts`**（純、無 React、可測）
  - `export function niceGaugeMax(v: number): number`
  - `export function formatTokens(n: number): string`
- **`admin/src/components/TokenGauge.tsx`**
  - props：`{ tokens: number }`
  - `const theme = useTheme();`
  - `const options = useMemo(() => buildGaugeOptions(tokens, theme), [tokens, theme]);`
  - 渲染 `<HighchartsReact highcharts={Highcharts} options={options} />`
  - 檔頂 `import HighchartsMore from 'highcharts/highcharts-more'; HighchartsMore(Highcharts);`（dial gauge 依賴；模組只初始化一次）。
- **`admin/src/theme.ts`**：新增 `export function useTheme(): Theme`（MutationObserver 實作）。
- **`admin/src/pages/tabs/UsageTab.tsx`**：改版面（Token 從 items 陣列移除；頂部加 TokenGauge）。
- **`admin/package.json`**：dependencies 加 `highcharts`、`highcharts-react-official`；devDependencies 加 `vitest`；scripts 加 `"test": "vitest run"`。

## 依賴與 Highcharts 模組

- `highcharts`（核心）
- `highcharts-react-official`（React wrapper）
- dial gauge（`type: 'gauge'`）需 `highcharts/highcharts-more`，於 TokenGauge 模組載入時初始化一次。（不需 solid-gauge。）

## 測試（Vitest，僅純函式）

- `admin/src/components/tokenGauge.util.test.ts`：
  - `niceGaugeMax` 明確斷言（1000 下限統一套用）：
    - `niceGaugeMax(0) === 1000`
    - `niceGaugeMax(1) === 1000`（target=1.25 → nice=2 → 套 1000 下限）
    - `niceGaugeMax(300) === 1000`（target=375 → nice=500 → 套 1000 下限）
    - `niceGaugeMax(900) === 2000`（target=1125 → nice=2000；> 1000 下限）
    - `niceGaugeMax(800_000) === 1_000_000`（target=1_000_000 → nice=1_000_000）
    - `niceGaugeMax(1_000_000) === 2_000_000`（target=1_250_000 → nice=2_000_000）
  - `formatTokens`：`850 → '850'`、`1000 → '1K'`、`1500 → '1.5K'`、`12_340 → '12.3K'`、`1_000_000 → '1M'`、`2_400_000 → '2.4M'`。
- TokenGauge 元件本身不寫自動化測試（無 DOM 測試基礎；渲染由手動驗證）。

## 手動驗證

`npm --prefix admin run dev`，開 Usage 分頁：錶盤置頂、指針落中後段、中央 K/M 讀數正確；切換深/淺主題錶盤配色即時跟著變；三數字磚仍在下方。

## YAGNI（明確排除）

- 不引入 token 預算/配額概念（維持累計無上限）。
- 不改其他三指標為錶盤。
- 不為 TokenGauge 元件寫 DOM/渲染測試（只測純函式）。
- 不重構 AppLayout 的主題管理。
