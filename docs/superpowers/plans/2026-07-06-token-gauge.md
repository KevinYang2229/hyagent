# Token 錶盤（Highcharts Gauge）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 admin Usage 分頁的「Token 數」純數字改成 Highcharts dial gauge（動態刻度 + 位置性色帶 + K/M 讀數），置頂放大，其餘三指標維持數字磚。

**Architecture:** 兩層——(1) 純函式 `tokenGauge.util.ts`（動態上限、K/M 格式）以 Vitest 單元測試；(2) `TokenGauge.tsx` 用 `highcharts-react-official` 依 tokens+主題組出 gauge options，透過新的 `useTheme()` hook 即時跟隨深/淺主題。UsageTab 改版面。

**Tech Stack:** Vite + React 18 + TypeScript、Highcharts 11 + highcharts-react-official、Vitest。

## Global Constraints

- admin 為 Vite + React 18 app；Highcharts 以 npm 依賴加入（非 CDN）。
- 色帶色（dataviz status 調色盤，**固定不隨主題**）：低 good `#0ca30c`、中 warning `#fab219`、高 critical `#d03b3b`。
- 錶盤外框/文字/指針色取自 admin 設計 token：`--text-primary`、`--text-secondary`、`--border-color`（用 `getComputedStyle` 取具體值餵 Highcharts）。
- 動態刻度：`niceGaugeMax`；K/M 縮寫：`formatTokens`（定義見 Task 1）。
- 只有 Token 改錶盤；對話數/訊息數/送出數維持 `.stats` 數字磚；錶盤置頂。
- 自動化測試僅涵蓋純函式（Vitest）；元件與版面靠 typecheck + build + 手動驗證。
- 測試指令從 repo 根：`npm --prefix admin test`。typecheck：`npm --prefix admin run typecheck`。build：`npm --prefix admin run build`。

---

### Task 1: Vitest scaffold + 純函式（動態刻度 / K-M 格式）

**Files:**
- Modify: `admin/package.json`（devDep `vitest`、script `test`/`test:watch`）
- Create: `admin/src/components/tokenGauge.util.ts`
- Test: `admin/src/components/tokenGauge.util.test.ts`

**Interfaces:**
- Produces:
  - `niceGaugeMax(v: number): number` — 依累計 token 回錶盤上限。
  - `formatTokens(n: number): string` — K/M 縮寫。
  - 兩者供 Task 2 的 `TokenGauge.tsx` 匯入。

- [ ] **Step 1: 加入 Vitest 與 test script**

編輯 `admin/package.json`：`devDependencies` 加 `"vitest": "^2.1.8"`；`scripts` 加 `"test": "vitest run"` 與 `"test:watch": "vitest"`。（Vitest 對純 TS 函式零設定即可跑，Node 環境、不需 jsdom。）

- [ ] **Step 2: 安裝依賴**

Run: `npm install`（於 repo 根，workspace 會裝進 admin）
Expected: 安裝成功，`node_modules/.bin/vitest` 存在。

- [ ] **Step 3: 寫失敗測試 `admin/src/components/tokenGauge.util.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { niceGaugeMax, formatTokens } from './tokenGauge.util';

describe('niceGaugeMax', () => {
  it('v<=0 回 1000', () => {
    expect(niceGaugeMax(0)).toBe(1000);
    expect(niceGaugeMax(-5)).toBe(1000);
  });
  it('小值統一套 1000 下限', () => {
    expect(niceGaugeMax(1)).toBe(1000); // target 1.25 → nice 2 → 下限 1000
    expect(niceGaugeMax(300)).toBe(1000); // target 375 → nice 500 → 下限 1000
  });
  it('超過下限取 nice(v/0.8)', () => {
    expect(niceGaugeMax(900)).toBe(2000); // target 1125 → nice 2000
    expect(niceGaugeMax(800_000)).toBe(1_000_000); // target 1e6 → nice 1e6
    expect(niceGaugeMax(1_000_000)).toBe(2_000_000); // target 1.25e6 → nice 2e6
  });
});

describe('formatTokens', () => {
  it('千以下原數（四捨五入整數）', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
  });
  it('K 級去尾零', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(12_340)).toBe('12.3K');
  });
  it('M 級去尾零', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
});
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `npm --prefix admin test`
Expected: FAIL（`tokenGauge.util` 模組不存在／匯入失敗）

- [ ] **Step 5: 實作 `admin/src/components/tokenGauge.util.ts`**

```ts
/** Token 錶盤純工具：動態刻度上限與 K/M 縮寫。無 React 相依，供單元測試。 */

/** {1,2,5}×10ⁿ 數列中「≥ target 的最小值」。target 必須 > 0。 */
function niceCeil(target: number): number {
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  // 含 10 的一輪吸收 log10 在整數次方的浮點誤差（如 log10(1000)=2.999…）
  for (const m of [1, 2, 5, 10]) {
    const candidate = m * base;
    if (candidate >= target) return candidate;
  }
  return 10 * base;
}

/**
 * 依目前累計 token 決定錶盤上限：
 * v<=0 → 1000；否則取 nice(v/0.8)，並統一套用 1000 下限
 * （token 很快破千，上限若為個/百位毫無意義）。
 */
export function niceGaugeMax(v: number): number {
  if (v <= 0) return 1000;
  return Math.max(1000, niceCeil(v / 0.8));
}

/** token 數→K/M 縮寫（去尾零、最多一位小數）：850→'850'、1500→'1.5K'、2_400_000→'2.4M'。 */
export function formatTokens(n: number): string {
  const trim = (x: number): string => parseFloat(x.toFixed(1)).toString();
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}K`;
  return `${trim(n / 1_000_000)}M`;
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm --prefix admin test`
Expected: PASS（2 個 describe、全部 assertion 綠）

- [ ] **Step 7: typecheck**

Run: `npm --prefix admin run typecheck`
Expected: 無錯誤

- [ ] **Step 8: Commit**

```bash
git add admin/package.json admin/src/components/tokenGauge.util.ts admin/src/components/tokenGauge.util.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): Token 錶盤純函式與 Vitest

niceGaugeMax（動態刻度上限，1000 下限）與 formatTokens（K/M 縮寫），admin 引入 Vitest 單元測試。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: TokenGauge 元件 + useTheme + 接進 UsageTab

**Files:**
- Modify: `admin/package.json`（deps `highcharts`、`highcharts-react-official`）
- Modify: `admin/src/theme.ts`（新增 `useTheme` hook）
- Create: `admin/src/components/TokenGauge.tsx`
- Modify: `admin/src/pages/tabs/UsageTab.tsx`

**Interfaces:**
- Consumes: `niceGaugeMax`、`formatTokens`（Task 1）；`Theme`、`getTheme`（既有 `theme.ts`）。
- Produces: `TokenGauge`（default export，props `{ tokens: number }`）；`useTheme(): Theme`。

- [ ] **Step 1: 安裝 Highcharts 依賴**

編輯 `admin/package.json` `dependencies` 加 `"highcharts": "^11.4.8"` 與 `"highcharts-react-official": "^3.2.1"`，然後：

Run: `npm install`
Expected: 安裝成功，`node_modules/highcharts` 與 `node_modules/highcharts-react-official` 存在。

- [ ] **Step 2: 於 `admin/src/theme.ts` 新增 `useTheme` hook**

檔頂加入 React import（若無）：

```ts
import { useEffect, useState } from 'react';
```

檔尾加入：

```ts
/** 訂閱 <html data-theme> 變動，回傳目前主題（供圖表等需即時跟隨主題的元件用）。 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(getTheme());
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(getTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
```

- [ ] **Step 3: 建立 `admin/src/components/TokenGauge.tsx`**

```tsx
import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsMore from 'highcharts/highcharts-more';
import HighchartsReact from 'highcharts-react-official';
import { useTheme, type Theme } from '../theme';
import { formatTokens, niceGaugeMax } from './tokenGauge.util';

// dial gauge（type:'gauge'）需 highcharts-more。v11 為工廠函式；guard 兼容自動註冊版本。
if (typeof HighchartsMore === 'function') {
  (HighchartsMore as (h: typeof Highcharts) => void)(Highcharts);
}

// 位置性色帶（dataviz status 調色盤，固定不隨主題）
const BAND_LOW = '#0ca30c'; // good
const BAND_MID = '#fab219'; // warning
const BAND_HIGH = '#d03b3b'; // critical

/** 讀設計 token 具體色值（Highcharts 需實色字串，CSS 變數無法直接餵）。 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// theme 參數僅作為 useMemo 依賴（觸發重算取新 token 色），函式體不直接使用
function buildGaugeOptions(tokens: number, _theme: Theme): Highcharts.Options {
  const max = niceGaugeMax(tokens);
  const ink = cssVar('--text-primary', '#0b0b0b');
  const sub = cssVar('--text-secondary', '#52514e');
  const border = cssVar('--border-color', '#e1e0d9');
  return {
    chart: { type: 'gauge', backgroundColor: 'transparent', height: 260 },
    title: { text: undefined },
    credits: { enabled: false },
    tooltip: { enabled: false },
    accessibility: { enabled: false },
    pane: {
      startAngle: -140,
      endAngle: 140,
      background: [{ backgroundColor: 'transparent', borderWidth: 0 }],
    },
    yAxis: {
      min: 0,
      max,
      tickInterval: max / 5,
      lineColor: border,
      tickColor: border,
      tickLength: 8,
      minorTickInterval: undefined,
      labels: {
        distance: 14,
        style: { color: sub, fontSize: '11px' },
        formatter(this: Highcharts.AxisLabelsFormatterContextObject) {
          return formatTokens(Number(this.value));
        },
      },
      plotBands: [
        { from: 0, to: max * 0.6, color: BAND_LOW, thickness: 14 },
        { from: max * 0.6, to: max * 0.85, color: BAND_MID, thickness: 14 },
        { from: max * 0.85, to: max, color: BAND_HIGH, thickness: 14 },
      ],
    },
    series: [
      {
        type: 'gauge',
        name: 'Token',
        data: [Math.min(tokens, max)],
        dial: { backgroundColor: ink, baseWidth: 4, radius: '80%', rearLength: '0%' },
        pivot: { backgroundColor: ink, radius: 5 },
        dataLabels: {
          useHTML: true,
          borderWidth: 0,
          y: 34,
          formatter(this: Highcharts.PointLabelObject) {
            return `<div style="text-align:center"><span style="font-size:26px;font-weight:800;color:${ink}">${formatTokens(tokens)}</span><br/><span style="font-size:11px;color:${sub}">累計 Token</span></div>`;
          },
        },
      },
    ],
  };
}

export default function TokenGauge({ tokens }: { tokens: number }) {
  const theme = useTheme();
  const options = useMemo(() => buildGaugeOptions(tokens, theme), [tokens, theme]);
  return (
    <div className="card" style={{ padding: 16 }}>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}
```

> 若 Highcharts 安裝版本對 `highcharts/highcharts-more` 匯入或 gauge 型別報 TS/執行期錯誤（v11 與 v12 匯入方式不同），以實際安裝版本文件調整匯入寫法；型別上可對 series 物件加 `as Highcharts.SeriesGaugeOptions`。功能判準為 Step 6 build 成功 + Step 7 手動渲染正常。

- [ ] **Step 4: 改 `admin/src/pages/tabs/UsageTab.tsx` 版面**

把 `items` 陣列移除 Token 那筆，並在回傳 JSX 頂部加入 `<TokenGauge>`。完整檔案：

```tsx
import { useEffect, useState } from 'react';
import { api, type Usage } from '../../api';
import TokenGauge from '../../components/TokenGauge';

export default function UsageTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getUsage(tenantId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [tenantId, onError]);

  if (!usage) {
    return (
      <div className="card">
        <div className="empty">載入中…</div>
      </div>
    );
  }

  const items: { label: string; value: number }[] = [
    { label: '對話數', value: usage.conversations ?? 0 },
    { label: '訊息數', value: usage.messages ?? 0 },
    { label: '送出數', value: usage.submissions ?? 0 },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TokenGauge tokens={usage.llmTokens ?? 0} />
      <div className="stats">
        {items.map((it) => (
          <div key={it.label} className="stat">
            <div className="stat-label">{it.label}</div>
            <div className="stat-value">{it.value.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: typecheck**

Run: `npm --prefix admin run typecheck`
Expected: 無錯誤（Task 1 的 util 測試也仍通過：`npm --prefix admin test`）

- [ ] **Step 6: build 驗證**

Run: `npm --prefix admin run build`
Expected: build 成功、無型別錯誤。

- [ ] **Step 7: 手動渲染驗證**

Run: `npm --prefix admin run dev`，登入後開某租戶 Usage 分頁。確認：
1. Token 錶盤置頂、指針落中後段、中央 K/M 讀數與 `llmTokens` 相符。
2. 綠/琥珀/紅弧帶顯示正常。
3. 切換深/淺主題（右上角），錶盤外框/文字/指針色即時跟著變（色帶不變）。
4. 下方對話數/訊息數/送出數三格數字磚仍在、排成一列。

- [ ] **Step 8: Commit**

```bash
git add admin/package.json admin/src/theme.ts admin/src/components/TokenGauge.tsx admin/src/pages/tabs/UsageTab.tsx
git commit -m "$(cat <<'EOF'
feat(admin): Usage 分頁 Token 改 Highcharts 錶盤

置頂 dial gauge（動態刻度 + 位置性色帶 + K/M 讀數），useTheme 即時跟隨深淺主題；其餘三指標維持數字磚。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 授權提醒（交付時再次告知）

Highcharts 商用需付費授權（非 MIT）。正式上線前須確認 Highcharts 授權，否則考慮換自繪 SVG gauge 或改用 MIT 圖表庫。
