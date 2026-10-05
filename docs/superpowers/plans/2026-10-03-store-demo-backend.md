# 門市 Demo 後端能力擴充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓後端支撐 7-ELEVEN 門市 POC Demo：工具結果以表格區塊呈現、確認卡片可依 schema 編輯、貨架與優惠券影像辨識 API、以及提供庫存／補貨／活動／優惠券的門市 Demo MCP 服務。

**Architecture:** MCP 工具在 `_meta["hyagent/display"]` 宣告表格，連線層把它與資料分開帶回，agent 只把資料給 LLM、把表格放進回覆的 `blocks`。待確認動作新增由 JSON Schema 推導的 `form`，確認端點可帶修改後的 input 並由後端驗證唯讀不變；另有不經 AI 的 `propose` 端點。LLM 層加入 image 區塊與強制工具呼叫，影像辨識 API 以強制呼叫「回報工具」取得固定格式結果，再經 Tool Registry 呼叫門市 MCP 補齊資料。

**Tech Stack:** Node 20+／TypeScript、Express 4、`@modelcontextprotocol/sdk` 1.31（低階 `Server` API）、Ajv 8、multer、jest + ts-jest（server）、vitest（client、mcp workspaces）。

**Spec:** [docs/superpowers/specs/2026-10-03-store-demo-backend-design.md](../specs/2026-10-03-store-demo-backend-design.md)

## Global Constraints

- 顯示提示鍵名：`_meta["hyagent/display"]`；只支援 `type: "table"`；最多 50 列、12 欄；儲存格只接受字串、數字或 null；圖片欄位值須為 http(s) URL。
- 色調只有 `success`、`warning`、`danger`、`neutral`；`format` 只有 `text`、`delta`、`date`。
- 給 LLM 的表格附註原文：「結果已以表格顯示給使用者，請簡述重點，不要逐列重複數字。」
- schema 推導：`readOnly: true` 不可編輯；`number`／`integer` → number（`minimum`／`maximum`）；`format: "date"` → date；`enum` → select（`x-enumLabels` 為顯示文字）；`x-display: "html"` 不可編輯；`x-unit` 單位；`x-image` 指向同列圖片欄位；`x-hidden: true` 不顯示（仍視為唯讀）。
- 修改驗證失敗回 **422 `ACTION_INPUT_INVALID`**，且待確認動作保留；一次性保證不變（並行確認只執行一次）。
- `propose` 只接受寫入工具，未知工具 404 `TOOL_NOT_FOUND`、非寫入工具 422 `NOT_A_WRITE_TOOL`。
- 影像辨識：`POST /api/vision/analyze`，multipart 欄位 `image`（jpeg／png／webp，≤ 5MB）、`mode`（`shelf`|`coupon`）；需 `service:agent`；照片不落地；LLM 未回傳報告工具呼叫 → 502 `VISION_FAILED`。
- 即期判斷：到期日 ≤ 明天（`expiryInDays <= 1`）；框選座標為 0–1 相對值，超出範圍一律夾回 [0,1]。
- 門市 MCP `serverId` 預設 `store-demo`（環境變數 `VISION_STORE_SERVER_ID` 可改）；商品比對分數 < 0.5 不帶 `productId`。
- 後端測試一律 `DATA_BACKEND=file`（setup-env 已設）；不得使用 `server/.env` 的 db 設定、不得修改 `server/.env`。
- 註解與 commit message 用繁體中文；commit 結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；`sdk/bin/keygen.mjs` 的檔案權限變更不得提交。

## Review Focus

- **修改後的表格把同一列送兩次**（複製一列假裝新增）→ 必須 422，不得執行。測試在 Task 5。
- **LLM 沒有照指示呼叫回報工具**（回純文字或空的 toolCalls）→ 502 `VISION_FAILED`，不得 500 或回空結果。測試在 Task 9。
- **框選座標超出範圍或為負數、寬高為 0** → 夾回 [0,1]，不得讓 app 畫到圖片外。測試在 Task 9。
- **兩個帶修改的確認同時送達** → 只執行一次，另一個 409。測試在 Task 6。
- **顯示提示的資料列含巢狀物件或布林** → 該格為 null，表格照常產生。測試在 Task 1。

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `shared/src/index.ts` | `DisplayBlock`、`TableBlock`、`ConfirmForm` 等共用型別；`PendingActionView.form?` |
| `server/src/modules/display/display-block.ts` | 顯示提示 → `TableBlock` 的驗證與解析（純函式） |
| `server/src/modules/tools/tool-output.ts` | `ToolOutput` 包裝：讓工具同時回傳資料與顯示提示 |
| `server/src/modules/mcp/mcp.connection.ts` | 新增 `callToolWithMeta` |
| `server/src/modules/mcp/mcp.tool-source.ts` | handler 帶回顯示提示 |
| `server/src/modules/conversation/agent.agent-service.ts` | 收集 blocks |
| `server/src/modules/conversation/confirm-form.ts` | schema → `ConfirmForm`（純函式） |
| `server/src/modules/conversation/edited-input.ts` | 修改後 input 的結構驗證與差異描述（純函式） |
| `server/src/modules/conversation/conversation.service.ts` 等 | confirm 帶 input、`propose` 端點 |
| `server/src/lib/llm/*` | image 區塊、`toolChoice` |
| `mcp/store-demo/` | 門市 Demo MCP 服務（新 workspace） |
| `server/src/modules/vision/` | 影像辨識 API |
| `server/scripts/vision-eval.ts` | 實際照片辨識效果檢視 |
| `client/src/DisplayBlockView.tsx`、`ConfirmActionCard.tsx` | web 前台表格區塊與可編輯卡片 |

---

### Task 1：共用型別與顯示區塊解析

**Files:**
- Modify: `shared/src/index.ts`（檔尾追加；修改 `PendingActionView`）
- Create: `server/src/modules/display/display-block.ts`
- Test: `server/tests/display-block.test.ts`

**Interfaces:**
- Produces（`@hyagent/shared`）：`DisplayTone`、`TableColumn`、`TableBlock`、`DisplayBlock`、`ConfirmFieldKind`、`ConfirmScalarField`、`ConfirmTableColumn`、`ConfirmTableField`、`ConfirmField`、`ConfirmForm`；`PendingActionView` 新增 `form?: ConfirmForm`
- Produces（server）：`DISPLAY_META_KEY = 'hyagent/display'`、`MAX_TABLE_ROWS = 50`、`MAX_TABLE_COLUMNS = 12`、`TABLE_SHOWN_NOTE`、`buildDisplayBlock(display: unknown, data: unknown): DisplayBlock | undefined`

- [ ] **Step 1：共用型別**

`shared/src/index.ts`：把

```ts
export interface PendingActionView {
  id: string;
  summary: ConfirmCard;
  expiresAt: string;
}
```

改為

```ts
export interface PendingActionView {
  id: string;
  summary: ConfirmCard;
  /** 依工具 schema 推導的可編輯表單；舊前台可忽略，只用 summary */
  form?: ConfirmForm;
  expiresAt: string;
}
```

檔尾追加：

```ts
/** 顯示區塊的色調（只有這四種，工具不能注入任意樣式） */
export type DisplayTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface TableColumn {
  key: string;
  label: string;
  unit?: string;
  /** text（預設）；delta：>0 顯示強調色「+N 單位」、0 或空值顯示「–」；date */
  format?: 'text' | 'delta' | 'date';
  /** 同列中存放圖片網址的欄位名稱 */
  image?: string;
  /** 儲存格值 → 色調；未列出的值以 neutral 顯示 */
  badge?: Record<string, DisplayTone>;
}

export interface TableBlock {
  type: 'table';
  title?: string;
  columns: TableColumn[];
  rows: Record<string, string | number | null>[];
}

/** 回覆中的畫面區塊；目前只有表格 */
export type DisplayBlock = TableBlock;

export type ConfirmFieldKind = 'text' | 'number' | 'date' | 'select';

export interface ConfirmScalarField {
  kind: ConfirmFieldKind;
  key: string;
  label: string;
  value: unknown;
  editable: boolean;
  min?: number;
  max?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

export interface ConfirmTableColumn {
  key: string;
  label: string;
  kind: ConfirmFieldKind;
  editable: boolean;
  unit?: string;
  min?: number;
  max?: number;
  /** 同列中存放圖片網址的欄位名稱 */
  image?: string;
  options?: { value: string; label: string }[];
}

export interface ConfirmTableField {
  kind: 'table';
  key: string;
  label: string;
  /** 是否可取消勾選（刪列） */
  selectable: boolean;
  columns: ConfirmTableColumn[];
  rows: Record<string, unknown>[];
}

export type ConfirmField = ConfirmScalarField | ConfirmTableField;

export interface ConfirmForm {
  title: string;
  fields: ConfirmField[];
}
```

- [ ] **Step 2：寫失敗測試**

`server/tests/display-block.test.ts`：

```ts
/** 顯示提示 → 表格區塊：合法解析、限制、壞輸入一律不產生區塊或該格為 null。 */
import { buildDisplayBlock, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from '@/modules/display/display-block';

const display = {
  type: 'table',
  title: '御飯糰庫存',
  rows: 'items',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success', 怪: 'rainbow' } },
  ],
};
const data = {
  items: [
    { name: '鮭魚御飯糰', image: 'https://cdn.example.com/a.png', stock: 6, suggested: 24, status: '庫存偏低' },
    { name: '鮪魚', image: 'javascript:alert(1)', stock: 12, suggested: 0, status: '正常', extra: 'x' },
  ],
};

describe('buildDisplayBlock', () => {
  it('合法 → 表格區塊；只保留欄位與圖片鍵；不合法色調被丟掉', () => {
    const b = buildDisplayBlock(display, data)!;
    expect(b.type).toBe('table');
    expect(b.title).toBe('御飯糰庫存');
    expect(b.columns.map((c) => c.key)).toEqual(['name', 'stock', 'suggested', 'status']);
    expect(b.columns[3].badge).toEqual({ 庫存偏低: 'danger', 正常: 'success' });
    expect(b.rows[0]).toEqual({ name: '鮭魚御飯糰', image: 'https://cdn.example.com/a.png', stock: 6, suggested: 24, status: '庫存偏低' });
    expect(b.rows[1].image).toBeNull(); // 非 http(s) 的圖片網址
    expect(b.rows[1]).not.toHaveProperty('extra');
  });

  it('巢狀物件與布林值 → 該格 null，表格照常產生', () => {
    const b = buildDisplayBlock(
      { type: 'table', rows: 'items', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      { items: [{ a: { nested: 1 }, b: true }] },
    )!;
    expect(b.rows).toEqual([{ a: null, b: null }]);
  });

  it('超過列數上限只取前 50 列', () => {
    const items = Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) => ({ n: i }));
    const b = buildDisplayBlock({ type: 'table', rows: 'items', columns: [{ key: 'n', label: 'N' }] }, { items })!;
    expect(b.rows).toHaveLength(MAX_TABLE_ROWS);
  });

  it.each([
    ['非物件', 'table'],
    ['type 不是 table', { ...display, type: 'chart' }],
    ['rows 指向不存在的屬性', { ...display, rows: 'nope' }],
    ['rows 指向非陣列', { ...display, rows: 'title' }],
    ['沒有欄位', { ...display, columns: [] }],
    ['欄位過多', { ...display, columns: Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, i) => ({ key: `k${i}`, label: 'x' })) }],
    ['欄位缺 label', { ...display, columns: [{ key: 'name' }] }],
  ])('%s → undefined', (_name, d) => {
    expect(buildDisplayBlock(d, { ...data, title: 'x' })).toBeUndefined();
  });

  it('format 不合法 → 視為 text；未給 → 不出現', () => {
    const b = buildDisplayBlock({ type: 'table', rows: 'items', columns: [{ key: 'n', label: 'N', format: 'weird' }] }, { items: [{ n: 1 }] })!;
    expect(b.columns[0].format).toBe('text');
  });

  it('資料不是物件 → undefined', () => {
    expect(buildDisplayBlock(display, 'text result')).toBeUndefined();
  });
});
```

Run: `cd server && npx jest tests/display-block.test.ts`
Expected: FAIL（`Cannot find module '@/modules/display/display-block'`）。

- [ ] **Step 3：實作**

`server/src/modules/display/display-block.ts`：

```ts
/**
 * 顯示提示 → 畫面區塊。
 *
 * MCP 工具在 `_meta["hyagent/display"]` 宣告如何把 structuredContent 畫成表格；
 * 這裡做白名單式的驗證與複製：只取宣告過的欄位、只接受安全的值，任何不合法一律不產生區塊。
 * 前端拿到的是現成的表格資料，不必自己解析工具結果。
 */
import type { DisplayBlock, DisplayTone, TableBlock, TableColumn } from '@hyagent/shared';

export const DISPLAY_META_KEY = 'hyagent/display';
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLUMNS = 12;
export const TABLE_SHOWN_NOTE = '結果已以表格顯示給使用者，請簡述重點，不要逐列重複數字。';

const TONES = new Set<DisplayTone>(['success', 'warning', 'danger', 'neutral']);
const FORMATS = new Set(['text', 'delta', 'date']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseColumn(raw: unknown): TableColumn | undefined {
  if (!isRecord(raw) || !nonEmptyString(raw.key) || !nonEmptyString(raw.label)) return undefined;
  const col: TableColumn = { key: raw.key, label: raw.label };
  if (nonEmptyString(raw.unit)) col.unit = raw.unit;
  if (raw.format !== undefined) col.format = FORMATS.has(raw.format as string) ? (raw.format as TableColumn['format']) : 'text';
  if (nonEmptyString(raw.image)) col.image = raw.image;
  if (isRecord(raw.badge)) {
    const badge: Record<string, DisplayTone> = {};
    for (const [value, tone] of Object.entries(raw.badge)) {
      if (TONES.has(tone as DisplayTone)) badge[value] = tone as DisplayTone;
    }
    col.badge = badge;
  }
  return col;
}

function cell(v: unknown): string | number | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function imageCell(v: unknown): string | null {
  return typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null;
}

export function buildDisplayBlock(display: unknown, data: unknown): DisplayBlock | undefined {
  if (!isRecord(display) || display.type !== 'table' || !nonEmptyString(display.rows)) return undefined;
  if (!isRecord(data)) return undefined;
  const source = Object.hasOwn(data, display.rows) ? data[display.rows] : undefined;
  if (!Array.isArray(source)) return undefined;
  if (!Array.isArray(display.columns) || display.columns.length === 0 || display.columns.length > MAX_TABLE_COLUMNS) return undefined;

  const columns: TableColumn[] = [];
  for (const raw of display.columns) {
    const col = parseColumn(raw);
    if (!col) return undefined;
    columns.push(col);
  }

  const rows = source.slice(0, MAX_TABLE_ROWS).map((r) => {
    const src = isRecord(r) ? r : {};
    const row: Record<string, string | number | null> = {};
    for (const col of columns) {
      row[col.key] = cell(Object.hasOwn(src, col.key) ? src[col.key] : undefined);
      if (col.image) row[col.image] = imageCell(Object.hasOwn(src, col.image) ? src[col.image] : undefined);
    }
    return row;
  });

  const block: TableBlock = { type: 'table', columns, rows };
  if (nonEmptyString(display.title)) block.title = display.title;
  return block;
}
```

- [ ] **Step 4：確認通過、型別檢查、commit**

Run: `cd server && npx jest tests/display-block.test.ts && npm run typecheck`
Expected: PASS，型別無錯誤。

```bash
git add shared/src/index.ts server/src/modules/display server/tests/display-block.test.ts
git commit -m "$(cat <<'EOF'
feat(display): 新增工具結果表格區塊的解析與共用型別

MCP 工具以 _meta["hyagent/display"] 宣告表格；後端白名單式解析（欄位、色調、
格式、http(s) 圖片、50 列／12 欄上限），不合法即不產生區塊。另加入可編輯
確認表單的共用型別。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2：工具輸出包裝與 MCP 顯示提示帶回

**Files:**
- Create: `server/src/modules/tools/tool-output.ts`
- Modify: `server/src/modules/tools/index.ts`
- Modify: `server/src/modules/mcp/mcp.connection.ts`（`callTool` 拆出 `callToolWithMeta`）
- Modify: `server/src/modules/mcp/mcp.tool-source.ts`（`toToolDef` handler）
- Modify: `server/tests/helpers/mcp-fixture.ts`（新增帶顯示提示的工具）
- Modify: `server/tests/mcp-tool-source.test.ts`（stub 改用 `callToolWithMeta`）
- Test: `server/tests/tool-output.test.ts`、`server/tests/mcp-connection.test.ts`（新增案例）

**Interfaces:**
- Consumes: Task 1 `DISPLAY_META_KEY`
- Produces:
  - `interface ToolOutput { data: unknown; display?: unknown }`（帶 symbol 品牌）
  - `toolOutput(data: unknown, display?: unknown): ToolOutput`、`isToolOutput(v: unknown): v is ToolOutput`、`unwrapToolOutput(v: unknown): { data: unknown; display?: unknown }`（皆由 `@/modules/tools` 匯出）
  - `McpConnection.callToolWithMeta(name, args, caller): Promise<{ data: unknown; meta?: Record<string, unknown> }>`；`callTool` 行為不變（回 `data`）
  - MCP 工具 handler：結果帶 `_meta["hyagent/display"]` 時回 `ToolOutput`，否則回資料本身

- [ ] **Step 1：寫失敗測試**

`server/tests/tool-output.test.ts`：

```ts
import { isToolOutput, toolOutput, unwrapToolOutput } from '@/modules/tools';

describe('ToolOutput', () => {
  it('包裝與拆包', () => {
    const o = toolOutput({ a: 1 }, { type: 'table' });
    expect(isToolOutput(o)).toBe(true);
    expect(unwrapToolOutput(o)).toEqual({ data: { a: 1 }, display: { type: 'table' } });
  });

  it('一般值不是 ToolOutput，拆包後 data 就是原值', () => {
    expect(isToolOutput({ data: 1, display: 2 })).toBe(false);
    expect(unwrapToolOutput({ data: 1 })).toEqual({ data: { data: 1 } });
    expect(unwrapToolOutput(undefined)).toEqual({ data: undefined });
  });

  it('JSON 序列化時不洩漏品牌', () => {
    expect(JSON.stringify(toolOutput(1))).toBe('{"data":1}');
  });
});
```

在 `server/tests/helpers/mcp-fixture.ts` 的 `register(server)` 內（`broken_tool` 之後）新增：

```ts
      server.registerTool(
        'stock_table',
        { description: '回傳帶表格顯示提示的庫存', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          const data = { items: [{ name: '鮭魚御飯糰', stock: 6 }] };
          return {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
            _meta: {
              'hyagent/display': { type: 'table', rows: 'items', columns: [{ key: 'name', label: '商品' }, { key: 'stock', label: '庫存' }] },
            },
          };
        },
      );
```

`server/tests/mcp-connection.test.ts` 的 `describe('McpConnection', …)` 內新增：

```ts
  it('callToolWithMeta：帶回 _meta；callTool 只回資料', async () => {
    conn = new McpConnection(config(fixture.url));
    const withMeta = await conn.callToolWithMeta('stock_table', {}, caller);
    expect(withMeta.data).toEqual({ items: [{ name: '鮭魚御飯糰', stock: 6 }] });
    expect((withMeta.meta?.['hyagent/display'] as { type: string }).type).toBe('table');
    expect(await conn.callTool('stock_table', {}, caller)).toEqual({ items: [{ name: '鮭魚御飯糰', stock: 6 }] });
  });
```

並把 `listTools` 測試裡的工具名單期望值改為包含 `stock_table`（排序後）：`['broken_tool', 'rooms_availability', 'rooms_book', 'slow_tool', 'stock_table']`。

`server/tests/mcp-tool-source.test.ts`：
- `stubConnection` 改為：

```ts
function stubConnection(tools: McpRemoteTool[], meta?: Record<string, unknown>): McpConnection {
  return {
    cachedTools: () => tools,
    status: () => ({ state: 'ok', toolsFetchedAt: 'fixed' }),
    listTools: async () => tools,
    callToolWithMeta: jest.fn(async () => ({ data: { ok: true }, meta })),
  } as unknown as McpConnection;
}
```

- 測試「handler 帶呼叫者身分呼叫 connection」改為：

```ts
  it('handler 帶呼叫者身分呼叫 connection；無顯示提示時回資料本身', async () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const conn = stubConnection([]);
    const out = await toToolDef(config, read, conn)!.handler({ date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
    expect(conn.callToolWithMeta).toHaveBeenCalledWith('rooms_availability', { date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
    expect(isToolOutput(out)).toBe(false);
    expect(out).toEqual({ ok: true });
  });

  it('結果帶顯示提示 → handler 回 ToolOutput', async () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const display = { type: 'table', rows: 'items', columns: [] };
    const out = await toToolDef(config, read, stubConnection([], { 'hyagent/display': display }))!.handler({}, { tenantId: 't', userId: 'u', scopes: [] });
    expect(unwrapToolOutput(out)).toEqual({ data: { ok: true }, display });
  });
```

- import 區加 `import { isToolOutput, unwrapToolOutput } from '@/modules/tools';`（若已有 `toolRegistry` 的 import，合併成同一行）。

Run: `cd server && npx jest tests/tool-output.test.ts tests/mcp-connection.test.ts tests/mcp-tool-source.test.ts`
Expected: FAIL（`toolOutput` 不存在、`callToolWithMeta` 不存在）。

- [ ] **Step 2：實作 ToolOutput**

`server/src/modules/tools/tool-output.ts`：

```ts
/**
 * 工具輸出包裝：工具除了給 LLM 的資料，還可附上給前端的顯示提示（如 MCP 的表格宣告）。
 * 以 symbol 品牌辨識，避免把一般物件 { data, display } 誤判成包裝。
 */
const TOOL_OUTPUT = Symbol.for('hyagent.toolOutput');

export interface ToolOutput {
  readonly [TOOL_OUTPUT]: true;
  data: unknown;
  display?: unknown;
}

export function toolOutput(data: unknown, display?: unknown): ToolOutput {
  return { [TOOL_OUTPUT]: true, data, ...(display !== undefined ? { display } : {}) } as ToolOutput;
}

export function isToolOutput(v: unknown): v is ToolOutput {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[TOOL_OUTPUT] === true;
}

/** 一律拆成 { data, display? }：不是包裝的值，data 就是它本身。 */
export function unwrapToolOutput(v: unknown): { data: unknown; display?: unknown } {
  if (!isToolOutput(v)) return { data: v };
  return v.display !== undefined ? { data: v.data, display: v.display } : { data: v.data };
}
```

`server/src/modules/tools/index.ts` 在其他 export 之後加：

```ts
export { isToolOutput, toolOutput, unwrapToolOutput } from './tool-output';
export type { ToolOutput } from './tool-output';
```

- [ ] **Step 3：連線層帶回 `_meta`**

`server/src/modules/mcp/mcp.connection.ts`：把現有的 `async callTool(...)` 整段方法改為下列兩個方法（內部邏輯不變，只是把最後的回傳拆開）：

```ts
  async callTool(name: string, args: Record<string, unknown>, caller: McpCaller): Promise<unknown> {
    return (await this.callToolWithMeta(name, args, caller)).data;
  }

  /** 同 callTool，另帶回結果的 _meta（如顯示提示）。 */
  async callToolWithMeta(
    name: string,
    args: Record<string, unknown>,
    caller: McpCaller,
  ): Promise<{ data: unknown; meta?: Record<string, unknown> }> {
    this.assertNotBackingOff();
    let client: Client;
    try {
      client = await this.ensureClient();
    } catch (err) {
      // 連線階段的任何錯誤（含逾時）都代表連不上
      await this.markFailed(err);
      throw new McpToolCallError(`${this.config.name} 暫時無法使用：${(err as Error).message}`);
    }
    let res: { isError?: boolean; structuredContent?: unknown; content?: unknown; _meta?: Record<string, unknown> };
    try {
      // SDK 回傳型別含舊版相容的 { toolResult } 分支，這裡只取現行欄位
      res = (await callerStore.run(caller, () =>
        client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs }),
      )) as typeof res;
      this.markOk();
    } catch (err) {
      if (isTimeout(err)) throw new McpToolCallError(`${this.config.name} 回應逾時，請稍後再試`);
      if (!isConnectionFailure(err)) throw new McpToolCallError(`${this.config.name} 呼叫失敗：${(err as Error).message}`);
      await this.markFailed(err);
      throw new McpToolCallError(`${this.config.name} 暫時無法使用：${(err as Error).message}`);
    }
    if (res.isError) throw new McpToolCallError(textOf(res.content) || `${this.config.name} 回傳錯誤`);
    const meta = res._meta && typeof res._meta === 'object' ? res._meta : undefined;
    return meta ? { data: normalizeToolResult(res), meta } : { data: normalizeToolResult(res) };
  }
```

- [ ] **Step 4：tool-source handler**

`server/src/modules/mcp/mcp.tool-source.ts`：
- import 區加 `import { DISPLAY_META_KEY } from '@/modules/display/display-block';` 與 `import { toolOutput } from '@/modules/tools/tool-output';`
- `toToolDef` 的參數型別 `conn: Pick<McpConnection, 'callTool'>` 改為 `conn: Pick<McpConnection, 'callToolWithMeta'>`
- handler 改為：

```ts
    handler: async (input, ctx) => {
      const { data, meta } = await conn.callToolWithMeta(remote.name, input as Record<string, unknown>, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        scopes: ctx.scopes,
      });
      const display = meta && Object.hasOwn(meta, DISPLAY_META_KEY) ? meta[DISPLAY_META_KEY] : undefined;
      // 有顯示提示才包裝：資料給 LLM、提示給前端（由 agent 拆開）
      return display === undefined ? data : toolOutput(data, display);
    },
```

- [ ] **Step 5：確認通過與回歸**

Run: `cd server && npx jest tests/tool-output.test.ts tests/mcp-connection.test.ts tests/mcp-tool-source.test.ts tests/mcp-e2e.test.ts && npm run typecheck`
Expected: 全部 PASS，型別無錯誤。

注意：此時 `mcp-e2e.test.ts` 中的工具尚無顯示提示，行為不變；若有其他測試直接呼叫 `toToolDef` 並 stub `callTool`，改為 stub `callToolWithMeta`（回 `{ data }`）。

- [ ] **Step 6：commit**

```bash
git add server/src/modules/tools server/src/modules/mcp server/tests/tool-output.test.ts server/tests/helpers/mcp-fixture.ts server/tests/mcp-connection.test.ts server/tests/mcp-tool-source.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): MCP 工具結果帶回顯示提示

新增 ToolOutput 包裝（資料與顯示提示分開）；連線層新增 callToolWithMeta 取回
_meta，MCP 工具 handler 在結果帶 hyagent/display 時回傳包裝，否則照舊回資料。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3：Agent 回覆帶表格區塊

**Files:**
- Modify: `server/src/modules/conversation/agent-service.types.ts`、`conversation.types.ts`、`conversation.agent.ts`
- Modify: `server/src/modules/conversation/agent.agent-service.ts`
- Modify: `server/src/modules/conversation/pending-action.service.ts`（結果拆包）
- Test: `server/tests/agent-blocks.test.ts`

**Interfaces:**
- Consumes: Task 1 `buildDisplayBlock`、`TABLE_SHOWN_NOTE`、`DisplayBlock`；Task 2 `toolOutput`、`unwrapToolOutput`
- Produces: `AgentTurnResult.blocks?: DisplayBlock[]`、`TurnResult.blocks?: DisplayBlock[]`（`runTurn` 原樣帶出）

- [ ] **Step 1：寫失敗測試**

`server/tests/agent-blocks.test.ts`：

```ts
/** Agent 回覆帶表格：LLM 只拿到資料（含附註），表格進 blocks；壞的顯示提示不影響回覆。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { registerTool, toolOutput } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform', ...partial };
}
function scripted(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

const items = [{ name: '鮭魚御飯糰', stock: 6 }, { name: '鮪魚御飯糰', stock: 12 }];
const goodDisplay = { type: 'table', title: '庫存', rows: 'items', columns: [{ key: 'name', label: '商品' }, { key: 'stock', label: '庫存', unit: '個' }] };

registerTool({
  id: 'test.stockTable',
  description: '查庫存（測試）',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => toolOutput({ items }, goodDisplay),
});
registerTool({
  id: 'test.badDisplay',
  description: '壞的顯示提示（測試）',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => toolOutput({ items }, { type: 'chart' }),
});

function session(tenantId: string): Session {
  return {
    id: 's-blocks', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting',
    activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: '查庫存' }] }],
    createdAt: new Date().toISOString(),
  };
}

function toolResult(s: Session): Record<string, unknown> {
  const b = s.messages.flatMap((m) => m.content).find((x) => x.type === 'tool_result') as { content: string };
  return JSON.parse(b.content) as Record<string, unknown>;
}

describe('Agent 表格區塊', () => {
  it('顯示提示合法 → blocks 有表格；LLM 拿到資料與附註、看不到顯示提示', async () => {
    const t = tenantStore.createTenant('agent-blocks-ok');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
    const s = session(t.id);
    const out = await agentAgentService.handleTurn(s, '查庫存', scripted([
      res({ toolCalls: [{ id: 't1', name: 'test_stockTable', input: {} }], stopReason: 'tool_use' }),
      res({ text: '鮭魚御飯糰庫存偏低。' }),
    ]));
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks![0]).toMatchObject({ type: 'table', title: '庫存', rows: [{ name: '鮭魚御飯糰', stock: 6 }, { name: '鮪魚御飯糰', stock: 12 }] });
    const tr = toolResult(s);
    expect(tr.result).toEqual({ items });
    expect(tr.note).toBe('結果已以表格顯示給使用者，請簡述重點，不要逐列重複數字。');
    expect(JSON.stringify(tr)).not.toContain('columns');
  });

  it('顯示提示不合法 → 沒有 blocks、沒有附註，回覆照常', async () => {
    const t = tenantStore.createTenant('agent-blocks-bad');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
    const s = session(t.id);
    const out = await agentAgentService.handleTurn(s, '查庫存', scripted([
      res({ toolCalls: [{ id: 't1', name: 'test_badDisplay', input: {} }], stopReason: 'tool_use' }),
      res({ text: '好的。' }),
    ]));
    expect(out.blocks).toBeUndefined();
    expect(out.reply).toBe('好的。');
    expect(toolResult(s).note).toBeUndefined();
    expect(toolResult(s).result).toEqual({ items });
  });
});
```

Run: `cd server && npx jest tests/agent-blocks.test.ts`
Expected: FAIL（`out.blocks` 為 undefined，tool_result 的 result 是包裝物件）。

- [ ] **Step 2：型別**

`agent-service.types.ts`：import 改為 `import type { DisplayBlock, PendingActionView, ReportRef } from '@hyagent/shared';`；`AgentTurnResult` 最後加：

```ts
  /** 本回合工具結果產生的畫面區塊（依序接在回覆文字之後呈現） */
  blocks?: DisplayBlock[];
```

`conversation.types.ts`：import 加入 `DisplayBlock`（與 `PendingActionView` 同一行）；`TurnResult` 最後加：

```ts
  /** 本回合的畫面區塊（表格等）；不寫入對話歷史 */
  blocks?: DisplayBlock[];
```

`conversation.agent.ts` 的 `runTurn`：`const { reply, report, pendingAction } = …` 改為 `const { reply, report, pendingAction, blocks } = …`，回傳物件最後加 `...(blocks && blocks.length > 0 ? { blocks } : {}),`。

- [ ] **Step 3：agent 收集區塊**

`agent.agent-service.ts`：
- import 區加：

```ts
import type { DisplayBlock } from '@hyagent/shared';
import { buildDisplayBlock, TABLE_SHOWN_NOTE } from '@/modules/display/display-block';
```

並在既有的 `from '@/modules/tools'` import 中加入 `unwrapToolOutput`。
- 在 `let proposedThisTurn = false;` 之後加 `const blocks: DisplayBlock[] = [];`
- 把讀取工具執行的兩行

```ts
          const result = await toolRegistry.invoke(realId, input, ctx);
          return JSON.stringify({ ok: true, result });
```

改為

```ts
          const { data, display } = unwrapToolOutput(await toolRegistry.invoke(realId, input, ctx));
          let shown = false;
          if (display !== undefined) {
            const block = buildDisplayBlock(display, data);
            if (block) {
              blocks.push(block);
              shown = true;
            } else {
              logger.warn({ toolId: realId }, 'invalid display hint ignored');
            }
          }
          return JSON.stringify({ ok: true, result: data, ...(shown ? { note: TABLE_SHOWN_NOTE } : {}) });
```

- 最後的 `return { reply, ...(session.pendingAction ? …) }` 改為：

```ts
    return {
      reply,
      ...(session.pendingAction ? { pendingAction: toPendingActionView(session.pendingAction) } : {}),
      ...(blocks.length > 0 ? { blocks } : {}),
    };
```

- [ ] **Step 4：確認動作的結果拆包**

`pending-action.service.ts`：import 改為 `import { makeToolContext, toolRegistry, unwrapToolOutput } from '@/modules/tools';`；

```ts
    const result = await toolRegistry.invoke(action.toolId, action.input, ctx);
```

改為

```ts
    const { data: result } = unwrapToolOutput(await toolRegistry.invoke(action.toolId, action.input, ctx));
```

- [ ] **Step 5：確認通過、回歸、commit**

Run: `cd server && npx jest tests/agent-blocks.test.ts tests/agent-email.test.ts tests/mcp-e2e.test.ts tests/conversation-actions.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add server/src/modules/conversation server/tests/agent-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): 回覆帶工具結果的表格區塊

工具回傳顯示提示時，資料（附「已以表格顯示」說明）交給 LLM、解析後的表格放進
回覆的 blocks；顯示提示不合法只記警告。確認動作的結果同樣拆包。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4：由 schema 推導可編輯確認表單

**Files:**
- Create: `server/src/modules/conversation/confirm-form.ts`
- Modify: `server/src/modules/conversation/pending-action.ts`
- Modify: `server/src/modules/tools/email.tools.ts`（不需改程式，見 Step 4 驗證）
- Test: `server/tests/confirm-form.test.ts`

**Interfaces:**
- Consumes: Task 1 `ConfirmForm` 等型別
- Produces:
  - `buildConfirmForm(tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>, input: Record<string, unknown>): ConfirmForm`
  - `PendingAction.form: ConfirmForm`；`toPendingActionView` 帶出 `form`
  - 共用工具函式 `schemaProps(schema: unknown): Record<string, JsonSchemaLike>`、`isLockedProp(s: JsonSchemaLike): boolean`、`imageKeysOf(props): Set<string>`、`labelOf(key, s)`、型別 `JsonSchemaLike`（由 `confirm-form.ts` 匯出，Task 5 使用）

- [ ] **Step 1：寫失敗測試**

`server/tests/confirm-form.test.ts`：

```ts
import { buildConfirmForm } from '@/modules/conversation/confirm-form';
import { createPendingAction, toPendingActionView } from '@/modules/conversation/pending-action';
import type { ToolDef } from '@/modules/tools';

const replenish: ToolDef = {
  id: 'mcp.store-demo.replenishment_create',
  description: '建立補貨單',
  confirmTitle: '確認建立補貨單',
  scopes: [],
  effect: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array', title: '補貨品項', minItems: 1,
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true, 'x-hidden': true },
            image: { type: 'string', readOnly: true },
            name: { type: 'string', title: '商品名稱', readOnly: true, 'x-image': 'image' },
            stock: { type: 'integer', title: '目前庫存', readOnly: true, 'x-unit': '個' },
            quantity: { type: 'integer', title: '建議補貨數量', minimum: 1, maximum: 200, 'x-unit': '個' },
          },
        },
      },
      arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
      priority: { type: 'string', enum: ['normal', 'urgent'], title: '優先度', 'x-enumLabels': { normal: '一般', urgent: '急件' } },
      note: { type: 'string', title: '備註' },
      body: { type: 'string', title: '內文', 'x-display': 'html' },
    },
  },
  handler: async () => undefined,
};

const input = {
  items: [
    { productId: 'P1', image: 'https://x/1.png', name: '鮭魚御飯糰', stock: 6, quantity: 24 },
    { productId: 'P2', name: '三明治', stock: 4, quantity: 20 },
  ],
  arrivalDate: '2026-10-05',
  priority: 'urgent',
  note: '早班',
  body: '<p>hi</p>',
};

describe('buildConfirmForm', () => {
  const form = buildConfirmForm(replenish, input);

  it('標題取 confirmTitle', () => {
    expect(form.title).toBe('確認建立補貨單');
  });

  it('物件陣列 → 可勾選表格；隱藏欄位與圖片欄位不成為欄；唯讀不可編輯', () => {
    const table = form.fields[0];
    expect(table).toMatchObject({ kind: 'table', key: 'items', label: '補貨品項', selectable: true });
    if (table.kind !== 'table') throw new Error('not table');
    expect(table.columns).toEqual([
      { key: 'name', label: '商品名稱', kind: 'text', editable: false, image: 'image' },
      { key: 'stock', label: '目前庫存', kind: 'number', editable: false, unit: '個' },
      { key: 'quantity', label: '建議補貨數量', kind: 'number', editable: true, unit: '個', min: 1, max: 200 },
    ]);
    expect(table.rows).toEqual(input.items);
  });

  it('日期、下拉、文字、html 唯讀', () => {
    const byKey = Object.fromEntries(form.fields.map((f) => [f.key, f]));
    expect(byKey.arrivalDate).toEqual({ kind: 'date', key: 'arrivalDate', label: '預計到貨日期', value: '2026-10-05', editable: true });
    expect(byKey.priority).toEqual({
      kind: 'select', key: 'priority', label: '優先度', value: 'urgent', editable: true,
      options: [{ value: 'normal', label: '一般' }, { value: 'urgent', label: '急件' }],
    });
    expect(byKey.note).toMatchObject({ kind: 'text', value: '早班', editable: true });
    expect(byKey.body).toMatchObject({ kind: 'text', value: 'hi', editable: false });
  });

  it('只剩 minItems 列 → 不可勾選；項目沒有唯讀欄位 → 不可勾選', () => {
    const one = buildConfirmForm(replenish, { ...input, items: [input.items[0]] });
    expect(one.fields[0]).toMatchObject({ selectable: false });
    const noId: ToolDef = {
      ...replenish,
      inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' } } } } } },
    };
    expect(buildConfirmForm(noId, { rows: [{ q: 1 }, { q: 2 }] }).fields[0]).toMatchObject({ kind: 'table', selectable: false });
  });

  it('input 沒有的欄位不出現；schema 沒有的鍵不出現', () => {
    const f = buildConfirmForm(replenish, { arrivalDate: '2026-10-05', stray: 1 });
    expect(f.fields.map((x) => x.key)).toEqual(['arrivalDate']);
  });

  it('createPendingAction 帶 form，對外視圖也帶 form', () => {
    const a = createPendingAction(replenish, input);
    expect(a.form.title).toBe('確認建立補貨單');
    expect(toPendingActionView(a).form).toEqual(a.form);
  });
});
```

Run: `cd server && npx jest tests/confirm-form.test.ts`
Expected: FAIL（找不到模組）。

- [ ] **Step 2：實作**

`server/src/modules/conversation/confirm-form.ts`：

```ts
/**
 * 由工具輸入 schema 推導可編輯確認表單（純函式）。
 *
 * 只用標準 JSON Schema 關鍵字與少數 x- 延伸：readOnly、format: date、enum、minimum／maximum、
 * x-display: html（唯讀）、x-unit、x-image（同列圖片欄位）、x-hidden（不顯示，視為唯讀）、x-enumLabels。
 * 這讓任何寫入工具只要 schema 寫好，就自動有可編輯卡片；前端不必為每個工具寫畫面。
 */
import type {
  ConfirmField,
  ConfirmFieldKind,
  ConfirmForm,
  ConfirmTableColumn,
} from '@hyagent/shared';
import type { ToolDef } from '@/modules/tools/tool.types';

export interface JsonSchemaLike {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  readOnly?: unknown;
  format?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  items?: unknown;
  properties?: unknown;
  'x-display'?: unknown;
  'x-unit'?: unknown;
  'x-image'?: unknown;
  'x-hidden'?: unknown;
  'x-enumLabels'?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function schemaProps(schema: unknown): Record<string, JsonSchemaLike> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  const out: Record<string, JsonSchemaLike> = {};
  for (const [k, v] of Object.entries(schema.properties)) if (isRecord(v)) out[k] = v as JsonSchemaLike;
  return out;
}

/** 使用者不可修改：readOnly、x-hidden、或 html 內文。 */
export function isLockedProp(s: JsonSchemaLike): boolean {
  return s.readOnly === true || s['x-hidden'] === true || s['x-display'] === 'html';
}

/** 被其他欄位以 x-image 指為圖片來源的鍵（這些鍵不單獨成欄）。 */
export function imageKeysOf(props: Record<string, JsonSchemaLike>): Set<string> {
  const keys = new Set<string>();
  for (const s of Object.values(props)) if (typeof s['x-image'] === 'string') keys.add(s['x-image']);
  return keys;
}

export function labelOf(key: string, s: JsonSchemaLike | undefined): string {
  if (typeof s?.title === 'string' && s.title) return s.title;
  if (typeof s?.description === 'string' && s.description) return s.description;
  return key;
}

function kindOf(s: JsonSchemaLike): ConfirmFieldKind {
  if (Array.isArray(s.enum)) return 'select';
  if (s.type === 'number' || s.type === 'integer') return 'number';
  if (s.format === 'date') return 'date';
  return 'text';
}

function optionsOf(s: JsonSchemaLike): { value: string; label: string }[] | undefined {
  if (!Array.isArray(s.enum)) return undefined;
  const labels = isRecord(s['x-enumLabels']) ? s['x-enumLabels'] : {};
  return s.enum.map((v) => {
    const value = String(v);
    const label = Object.hasOwn(labels, value) && typeof labels[value] === 'string' ? (labels[value] as string) : value;
    return { value, label };
  });
}

/** 共同屬性：單位、上下限、選項（只放有值的鍵，讓輸出穩定） */
function extras(s: JsonSchemaLike): Pick<ConfirmTableColumn, 'unit' | 'min' | 'max' | 'options'> {
  const out: Pick<ConfirmTableColumn, 'unit' | 'min' | 'max' | 'options'> = {};
  if (typeof s['x-unit'] === 'string') out.unit = s['x-unit'];
  if (typeof s.minimum === 'number') out.min = s.minimum;
  if (typeof s.maximum === 'number') out.max = s.maximum;
  const options = optionsOf(s);
  if (options) out.options = options;
  return out;
}

function stripHtml(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : v;
}

function tableField(key: string, s: JsonSchemaLike, rows: unknown[]): ConfirmField | undefined {
  if (!isRecord(s.items)) return undefined;
  const itemProps = schemaProps(s.items);
  const hidden = imageKeysOf(itemProps);
  const columns: ConfirmTableColumn[] = [];
  for (const [k, p] of Object.entries(itemProps)) {
    if (p['x-hidden'] === true || hidden.has(k)) continue;
    const col: ConfirmTableColumn = { key: k, label: labelOf(k, p), kind: kindOf(p), editable: !isLockedProp(p), ...extras(p) };
    if (typeof p['x-image'] === 'string') col.image = p['x-image'];
    columns.push(col);
  }
  const objectRows = rows.filter(isRecord).map((r) => ({ ...r }));
  const hasIdentity = Object.values(itemProps).some((p) => p.readOnly === true || p['x-hidden'] === true);
  const minItems = typeof s.minItems === 'number' ? s.minItems : 0;
  return {
    kind: 'table',
    key,
    label: labelOf(key, s),
    selectable: hasIdentity && objectRows.length > minItems,
    columns,
    rows: objectRows,
  };
}

export function buildConfirmForm(
  tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>,
  input: Record<string, unknown>,
): ConfirmForm {
  const props = schemaProps(tool.inputSchema);
  const hiddenImages = imageKeysOf(props);
  const fields: ConfirmField[] = [];
  for (const [key, s] of Object.entries(props)) {
    if (!Object.hasOwn(input, key) || s['x-hidden'] === true || hiddenImages.has(key)) continue;
    const value = input[key];
    if (Array.isArray(value) && s.type === 'array') {
      const table = tableField(key, s, value);
      if (table) fields.push(table);
      continue;
    }
    if (isRecord(value) || Array.isArray(value)) continue; // 巢狀物件不提供編輯，摘要（summary）仍會顯示
    fields.push({
      kind: kindOf(s),
      key,
      label: labelOf(key, s),
      value: s['x-display'] === 'html' ? stripHtml(value) : value,
      editable: !isLockedProp(s),
      ...extras(s),
    });
  }
  return { title: tool.confirmTitle ?? tool.description, fields };
}
```

- [ ] **Step 3：接進待確認動作**

`server/src/modules/conversation/pending-action.ts`：
- import 改為 `import type { ConfirmCard, ConfirmCardField, ConfirmForm, PendingActionView } from '@hyagent/shared';`，並加 `import { buildConfirmForm } from './confirm-form';`
- `PendingAction` 介面在 `summary: ConfirmCard;` 之後加 `form: ConfirmForm;`
- `createPendingAction` 回傳物件在 `summary: …` 之後加 `form: buildConfirmForm(tool, input),`
- `toPendingActionView` 改為 `return { id: action.id, summary: action.summary, form: action.form, expiresAt: action.expiresAt };`

`server/tests/pending-action.test.ts` 的「對外視圖不含工具 id 與原始參數」斷言改為 `expect(Object.keys(view).sort()).toEqual(['expiresAt', 'form', 'id', 'summary']);`

- [ ] **Step 4：確認 email 卡片**

在 `server/tests/confirm-form.test.ts` 末尾追加：

```ts
import { makeToolContext, toolRegistry } from '@/modules/tools';

it('email.send：收件人與主旨可編輯、內文唯讀', () => {
  const tool = toolRegistry.resolve('email.send', makeToolContext({ tenantId: 'default', userId: 'kevin' }));
  const f = buildConfirmForm(tool, { to: 'a@x.com', subject: 's', html: '<p>x</p>' });
  expect(f.fields.map((x) => [x.key, x.kind === 'table' ? null : x.editable])).toEqual([
    ['to', true], ['subject', true], ['html', false],
  ]);
});
```

- [ ] **Step 5：確認通過、回歸、commit**

Run: `cd server && npx jest tests/confirm-form.test.ts tests/pending-action.test.ts tests/agent-email.test.ts tests/conversation-actions.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add server/src/modules/conversation server/tests/confirm-form.test.ts server/tests/pending-action.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 依工具 schema 推導可編輯確認表單

待確認動作新增 form：物件陣列成為可勾選表格（以唯讀欄位辨識列），readOnly／
x-hidden／html 唯讀，數字帶上下限，date 與 enum 對應日期與下拉；支援 x-unit、
x-image、x-enumLabels。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5：修改後參數的結構驗證與差異描述

**Files:**
- Create: `server/src/modules/conversation/edited-input.ts`
- Test: `server/tests/edited-input.test.ts`

**Interfaces:**
- Consumes: Task 4 `schemaProps`、`isLockedProp`、`labelOf`、`JsonSchemaLike`
- Produces:
  - `validateEditedInput(schema: unknown, original: Record<string, unknown>, edited: unknown): { ok: true } | { ok: false; errors: string[] }`（不含 Ajv；Ajv 由 Task 6 用 `toolRegistry.assertInvocable` 做）
  - `describeEdits(schema: unknown, original: Record<string, unknown>, edited: Record<string, unknown>): string[]`

- [ ] **Step 1：寫失敗測試**

`server/tests/edited-input.test.ts`：

```ts
import { describeEdits, validateEditedInput } from '@/modules/conversation/edited-input';

const schema = {
  type: 'object',
  properties: {
    items: {
      type: 'array', title: '補貨品項',
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string', readOnly: true, 'x-hidden': true },
          name: { type: 'string', title: '商品名稱', readOnly: true },
          stock: { type: 'integer', title: '目前庫存', readOnly: true },
          quantity: { type: 'integer', title: '補貨數量' },
        },
      },
    },
    arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
    storeId: { type: 'string', readOnly: true },
  },
};
const original = {
  items: [
    { productId: 'P1', name: '鮭魚御飯糰', stock: 6, quantity: 24 },
    { productId: 'P2', name: '三明治', stock: 4, quantity: 20 },
    { productId: 'P3', name: '沙拉', stock: 5, quantity: 18 },
  ],
  arrivalDate: '2026-10-05',
  storeId: 'S01',
};
const clone = () => JSON.parse(JSON.stringify(original)) as typeof original;

describe('validateEditedInput', () => {
  it('原封不動 → ok', () => {
    expect(validateEditedInput(schema, original, clone())).toEqual({ ok: true });
  });

  it('改可編輯欄位、刪列、調換順序 → ok', () => {
    const e = clone();
    e.items = [{ ...e.items[2], quantity: 30 }, e.items[0]];
    e.arrivalDate = '2026-10-06';
    expect(validateEditedInput(schema, original, e)).toEqual({ ok: true });
  });

  it.each([
    ['改純量唯讀欄位', (e: ReturnType<typeof clone>) => { e.storeId = 'S99'; }],
    ['改列的唯讀欄位', (e: ReturnType<typeof clone>) => { e.items[0].stock = 99; }],
    ['新增一列', (e: ReturnType<typeof clone>) => { e.items.push({ productId: 'P9', name: '新', stock: 0, quantity: 1 }); }],
    ['同一列送兩次', (e: ReturnType<typeof clone>) => { e.items = [e.items[0], { ...e.items[0], quantity: 1 }]; }],
    ['多出 schema 沒有的鍵', (e: ReturnType<typeof clone>) => { (e as Record<string, unknown>).extra = 1; }],
    ['列多出鍵', (e: ReturnType<typeof clone>) => { (e.items[0] as Record<string, unknown>).hack = 1; }],
    ['刪掉原本有的唯讀欄位', (e: ReturnType<typeof clone>) => { delete (e as Partial<typeof original>).storeId; }],
  ])('%s → 不通過', (_name, mutate) => {
    const e = clone();
    mutate(e);
    const r = validateEditedInput(schema, original, e);
    expect(r.ok).toBe(false);
  });

  it('不是物件 → 不通過', () => {
    expect(validateEditedInput(schema, original, [1]).ok).toBe(false);
  });

  it('項目沒有唯讀欄位的陣列：列數與順序須相同，只能改值', () => {
    const s = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' } } } } } };
    const o = { rows: [{ q: 1 }, { q: 2 }] };
    expect(validateEditedInput(s, o, { rows: [{ q: 5 }, { q: 6 }] })).toEqual({ ok: true });
    expect(validateEditedInput(s, o, { rows: [{ q: 1 }] }).ok).toBe(false);
  });
});

describe('describeEdits', () => {
  it('描述欄位修改與刪列', () => {
    const e = clone();
    e.items = [{ ...e.items[0], quantity: 30 }, e.items[1]];
    e.arrivalDate = '2026-10-06';
    expect(describeEdits(schema, original, e)).toEqual([
      '鮭魚御飯糰 補貨數量 24→30',
      '移除 沙拉',
      '預計到貨日期 2026-10-05→2026-10-06',
    ]);
  });

  it('沒有修改 → 空陣列', () => {
    expect(describeEdits(schema, original, clone())).toEqual([]);
  });
});
```

Run: `cd server && npx jest tests/edited-input.test.ts`
Expected: FAIL（找不到模組）。

- [ ] **Step 2：實作**

`server/src/modules/conversation/edited-input.ts`：

```ts
/**
 * 使用者在確認卡片上修改後的參數：結構驗證與差異描述（純函式）。
 *
 * 前端不可信：唯讀欄位必須與原值相同；表格的每一列必須能以「全部唯讀欄位相同」對應到原本
 * 唯一的一列——允許刪列、改可編輯欄位，不允許新增列或改唯讀值。型別與數值範圍交給 Ajv。
 */
import { isLockedProp, labelOf, schemaProps, type JsonSchemaLike } from './confirm-form';

type Result = { ok: true } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isObjectArraySchema(s: JsonSchemaLike): boolean {
  return s.type === 'array' && isRecord(s.items) && isRecord((s.items as JsonSchemaLike).properties);
}

function identityKeys(itemProps: Record<string, JsonSchemaLike>): string[] {
  return Object.entries(itemProps).filter(([, p]) => isLockedProp(p)).map(([k]) => k);
}

function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => Object.hasOwn(a, k) === Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** 回傳每一列修改後對應的原始列索引；無法對應時回錯誤訊息。 */
function matchRows(
  label: string,
  itemProps: Record<string, JsonSchemaLike>,
  original: unknown[],
  edited: unknown[],
): { pairs: [number, Record<string, unknown>][] } | { error: string } {
  const keys = identityKeys(itemProps);
  const origRows = original.filter(isRecord);
  const pairs: [number, Record<string, unknown>][] = [];
  if (keys.length === 0) {
    if (edited.length !== origRows.length) return { error: `${label}：不可增減列` };
    for (let i = 0; i < edited.length; i++) {
      const row = edited[i];
      if (!isRecord(row)) return { error: `${label}：第 ${i + 1} 列格式錯誤` };
      pairs.push([i, row]);
    }
    return { pairs };
  }
  const used = new Set<number>();
  for (let i = 0; i < edited.length; i++) {
    const row = edited[i];
    if (!isRecord(row)) return { error: `${label}：第 ${i + 1} 列格式錯誤` };
    const idx = origRows.findIndex((o, j) => !used.has(j) && sameIdentity(o, row, keys));
    if (idx < 0) {
      const dup = origRows.some((o) => sameIdentity(o, row, keys));
      return { error: dup ? `${label}：同一列不可重複` : `${label}：不可新增列或修改唯讀欄位` };
    }
    used.add(idx);
    pairs.push([idx, row]);
  }
  return { pairs };
}

export function validateEditedInput(schema: unknown, original: Record<string, unknown>, edited: unknown): Result {
  if (!isRecord(edited)) return { ok: false, errors: ['參數格式錯誤'] };
  const props = schemaProps(schema);
  const errors: string[] = [];

  for (const k of Object.keys(edited)) {
    if (!Object.hasOwn(props, k)) errors.push(`不允許的欄位：${k}`);
  }

  for (const [key, s] of Object.entries(props)) {
    const has = Object.hasOwn(edited, key);
    const before = original[key];
    const after = edited[key];
    if (isObjectArraySchema(s) && Array.isArray(before)) {
      if (!Array.isArray(after)) {
        errors.push(`${labelOf(key, s)}：格式錯誤`);
        continue;
      }
      const itemProps = schemaProps(s.items);
      const m = matchRows(labelOf(key, s), itemProps, before, after);
      if ('error' in m) {
        errors.push(m.error);
        continue;
      }
      for (const [, row] of m.pairs) {
        for (const rk of Object.keys(row)) if (!Object.hasOwn(itemProps, rk)) errors.push(`${labelOf(key, s)}：不允許的欄位 ${rk}`);
      }
      continue;
    }
    if (isLockedProp(s) || isRecord(before) || Array.isArray(before)) {
      // 唯讀、或不提供編輯的巢狀值：必須與原值相同（含「原本沒有就不能出現」）
      if (has !== Object.hasOwn(original, key) || !deepEqual(before, after)) errors.push(`${labelOf(key, s)} 不可修改`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '（空）';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function rowName(row: Record<string, unknown>, itemProps: Record<string, JsonSchemaLike>, index: number): string {
  for (const [k, p] of Object.entries(itemProps)) {
    if (p.readOnly === true && p['x-hidden'] !== true && typeof row[k] === 'string') return row[k] as string;
  }
  return `第 ${index + 1} 列`;
}

export function describeEdits(schema: unknown, original: Record<string, unknown>, edited: Record<string, unknown>): string[] {
  const props = schemaProps(schema);
  const lines: string[] = [];
  for (const [key, s] of Object.entries(props)) {
    const before = original[key];
    const after = edited[key];
    if (isObjectArraySchema(s) && Array.isArray(before) && Array.isArray(after)) {
      const itemProps = schemaProps(s.items);
      const m = matchRows(labelOf(key, s), itemProps, before, after);
      if ('error' in m) continue;
      const origRows = before.filter(isRecord);
      const kept = new Set<number>();
      for (const [idx, row] of m.pairs) {
        kept.add(idx);
        for (const [ck, cp] of Object.entries(itemProps)) {
          if (isLockedProp(cp) || deepEqual(origRows[idx][ck], row[ck])) continue;
          lines.push(`${rowName(origRows[idx], itemProps, idx)} ${labelOf(ck, cp)} ${show(origRows[idx][ck])}→${show(row[ck])}`);
        }
      }
      origRows.forEach((row, idx) => {
        if (!kept.has(idx)) lines.push(`移除 ${rowName(row, itemProps, idx)}`);
      });
      continue;
    }
    if (isLockedProp(s) || deepEqual(before, after)) continue;
    lines.push(`${labelOf(key, s)} ${show(before)}→${show(after)}`);
  }
  return lines;
}
```

- [ ] **Step 3：確認通過、型別、commit**

Run: `cd server && npx jest tests/edited-input.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add server/src/modules/conversation/edited-input.ts server/tests/edited-input.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 驗證確認卡片上修改後的參數並描述差異

唯讀欄位不得改動；表格列以唯讀欄位對應原列（允許刪列與改可編輯欄位，不允許
新增或重複列）；不得出現 schema 外的鍵。另產生「品項 欄位 舊→新、移除 品項」
的差異文字供逐字稿使用。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6：確認帶修改、不經 AI 的提議端點

**Files:**
- Modify: `server/src/modules/conversation/conversation.schema.ts`
- Modify: `server/src/modules/conversation/conversation.service.ts`
- Modify: `server/src/modules/conversation/conversation.controller.ts`
- Modify: `server/src/modules/conversation/conversation.routes.ts`
- Modify: `server/src/modules/docs/openapi.ts`
- Test: `server/tests/conversation-actions-edit.test.ts`

**Interfaces:**
- Consumes: Task 4 `createPendingAction`（含 form）、`toPendingActionView`；Task 5 `validateEditedInput`、`describeEdits`
- Produces:
  - `confirmBodySchema`（`{ input?: Record<string, unknown> }`）、`proposeBodySchema`（`{ toolId: string; input: Record<string, unknown> }`）
  - `conversationService.confirmAction(tenantId, userId, id, actionId, editedInput?)`
  - `conversationService.proposeAction(tenantId, userId, id, toolId, input): Promise<{ pendingAction: PendingActionView }>`
  - HTTP：`POST /api/conversations/:id/actions/:actionId/confirm` body `{ input? }`；`POST /api/conversations/:id/actions/propose` body `{ toolId, input }` → `{ data: { pendingAction } }`

- [ ] **Step 1：寫失敗測試**

`server/tests/conversation-actions-edit.test.ts`：

```ts
/** 確認帶修改（唯讀不變、422 保留動作、一次性）與不經 AI 的提議端點。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { registerTool } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const calls: unknown[] = [];

registerTool({
  id: 'test.replenish',
  description: '建立補貨單（測試）',
  confirmTitle: '確認建立補貨單',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true, 'x-hidden': true },
            name: { type: 'string', title: '商品名稱', readOnly: true },
            quantity: { type: 'integer', title: '補貨數量', minimum: 1, maximum: 200 },
          },
          required: ['productId', 'name', 'quantity'],
          additionalProperties: false,
        },
      },
      arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
    },
    required: ['items', 'arrivalDate'],
    additionalProperties: false,
  },
  scopes: [],
  agentExposed: true,
  effect: 'write',
  handler: async (input) => {
    calls.push(input);
    return { orderId: 'R-1' };
  },
});
registerTool({
  id: 'test.readonlyTool',
  description: '唯讀（測試）',
  inputSchema: { type: 'object', properties: {} },
  scopes: [],
  agentExposed: true,
  effect: 'read',
  handler: async () => ({}),
});

const input = {
  items: [
    { productId: 'P1', name: '鮭魚御飯糰', quantity: 24 },
    { productId: 'P2', name: '三明治', quantity: 20 },
  ],
  arrivalDate: '2026-10-05',
};

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

async function startConv(t: string): Promise<string> {
  const res = await request(app).post('/api/conversations').set('Authorization', `Bearer ${t}`).send({});
  return res.body.data.id as string;
}

function propose(t: string, convId: string, body: unknown) {
  return request(app).post(`/api/conversations/${convId}/actions/propose`).set('Authorization', `Bearer ${t}`).send(body);
}

function confirm(t: string, convId: string, actionId: string, body: unknown = {}) {
  return request(app).post(`/api/conversations/${convId}/actions/${actionId}/confirm`).set('Authorization', `Bearer ${t}`).send(body);
}

beforeEach(() => {
  calls.length = 0;
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

describe('propose', () => {
  it('寫入工具 → 回傳含 form 的待確認動作，不執行', async () => {
    const t = await token();
    const conv = await startConv(t);
    const res = await propose(t, conv, { toolId: 'test.replenish', input });
    expect(res.status).toBe(200);
    expect(res.body.data.pendingAction.form.title).toBe('確認建立補貨單');
    expect(calls).toHaveLength(0);
  });

  it('非寫入工具 → 422 NOT_A_WRITE_TOOL；未知工具 → 404 TOOL_NOT_FOUND；輸入不合法 → 422', async () => {
    const t = await token();
    const conv = await startConv(t);
    expect((await propose(t, conv, { toolId: 'test.readonlyTool', input: {} })).body.error.code).toBe('NOT_A_WRITE_TOOL');
    const unknown = await propose(t, conv, { toolId: 'test.nope', input: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('TOOL_NOT_FOUND');
    expect((await propose(t, conv, { toolId: 'test.replenish', input: { items: [] } })).status).toBe(422);
  });
});

describe('confirm 帶修改', () => {
  it('改數量並刪一列 → 以修改後參數執行，逐字稿記下差異', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const edited = { items: [{ productId: 'P1', name: '鮭魚御飯糰', quantity: 30 }], arrivalDate: '2026-10-06' };
    const res = await confirm(t, conv, actionId, { input: edited });
    expect(res.status).toBe(200);
    expect(res.body.data.actionOk).toBe(true);
    expect(calls).toEqual([edited]);
    const transcript = JSON.stringify(conversationStore.get(conv, 'default', 'kevin').messages);
    expect(transcript).toContain('鮭魚御飯糰 補貨數量 24→30');
    expect(transcript).toContain('移除 三明治');
  });

  it('改唯讀欄位 → 422 ACTION_INPUT_INVALID，動作保留，可改正後再送', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const bad = { ...input, items: [{ productId: 'P1', name: '被改名', quantity: 24 }] };
    const res = await confirm(t, conv, actionId, { input: bad });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ACTION_INPUT_INVALID');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(conv, 'default', 'kevin').pendingAction?.id).toBe(actionId);
    expect((await confirm(t, conv, actionId, { input })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('數量超出上限（Ajv）→ 422，動作保留', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const res = await confirm(t, conv, actionId, { input: { ...input, items: [{ ...input.items[0], quantity: 999 }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ACTION_INPUT_INVALID');
    expect(conversationStore.get(conv, 'default', 'kevin').pendingAction?.id).toBe(actionId);
  });

  it('兩個帶修改的確認同時送達 → 只執行一次，另一個 409', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    const [a, b] = await Promise.all([confirm(t, conv, actionId, { input }), confirm(t, conv, actionId, { input })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
  });

  it('body 有未知鍵 → 422（schema 嚴格）', async () => {
    const t = await token();
    const conv = await startConv(t);
    const actionId = (await propose(t, conv, { toolId: 'test.replenish', input })).body.data.pendingAction.id as string;
    expect((await confirm(t, conv, actionId, { inputs: input })).status).toBe(422);
  });
});
```

Run: `cd server && npx jest tests/conversation-actions-edit.test.ts`
Expected: FAIL（propose 回 404）。

- [ ] **Step 2：schema**

`conversation.schema.ts` 在 `actionParamSchema` 之後加：

```ts
export const confirmBodySchema = z
  .object({
    /** 使用者在確認卡片上修改後的完整參數；省略＝照原參數執行 */
    input: z.record(z.unknown()).optional(),
  })
  .strict();

export const proposeBodySchema = z
  .object({
    toolId: z.string().trim().min(1),
    input: z.record(z.unknown()),
  })
  .strict();

export type ConfirmBody = z.infer<typeof confirmBodySchema>;
export type ProposeBody = z.infer<typeof proposeBodySchema>;
```

- [ ] **Step 3：service**

`conversation.service.ts`：
- import 區加：

```ts
import type { PendingActionView } from '@hyagent/shared';
import { isWriteTool, makeToolContext, toolRegistry } from '@/modules/tools';
import { describeEdits, validateEditedInput } from './edited-input';
import { createPendingAction, toPendingActionView } from './pending-action';
```

（`isPendingActionExpired` 已從 `./pending-action` import，合併成同一行）
- `confirmAction` 整個方法改為：

```ts
  /**
   * 確認卡片按「確認」（不經 LLM）：比對動作 id 與效期後立即清除（一次性，擋雙擊與並行重送），
   * 再驗證使用者修改後的參數；驗證失敗還原動作並回 422。執行時重新解析權限；權限已撤銷回 403。
   */
  async confirmAction(
    tenantId: string,
    userId: string,
    id: string,
    actionId: string,
    editedInput?: Record<string, unknown>,
  ): Promise<ActionTurnResult> {
    const session = conversationStore.get(id, tenantId, userId);
    const action = session.pendingAction;
    if (!action || action.id !== actionId) {
      throw new AppError(409, 'ACTION_NOT_FOUND', '這個動作已不存在或已處理過');
    }
    // 同步領取：之後任何 await 期間，並行的第二個請求都會看到沒有待確認動作而回 409
    session.pendingAction = undefined;
    if (isPendingActionExpired(action)) {
      conversationStore.save(session);
      throw new AppError(409, 'ACTION_EXPIRED', '這個動作已逾時失效，請重新提出');
    }

    let finalAction = action;
    let edits: string[] = [];
    if (editedInput) {
      const ctx = makeToolContext({ tenantId, userId, locale: session.locale });
      const restore = (): void => {
        if (!session.pendingAction) session.pendingAction = action;
      };
      await toolRegistry.prepare(ctx);
      let schema: unknown;
      try {
        schema = toolRegistry.resolve(action.toolId, ctx).inputSchema;
      } catch {
        schema = undefined; // 工具已不可用：交給 runConfirmedAction 回報「服務無法使用」
      }
      if (schema !== undefined) {
        const structural = validateEditedInput(schema, action.input, editedInput);
        if (!structural.ok) {
          restore();
          throw new AppError(422, 'ACTION_INPUT_INVALID', structural.errors.join('；'));
        }
        try {
          toolRegistry.assertInvocable(action.toolId, editedInput, ctx);
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 422) {
            restore();
            throw new AppError(422, 'ACTION_INPUT_INVALID', err.message, err.details);
          }
          throw err;
        }
        edits = describeEdits(schema, action.input, editedInput);
        finalAction = { ...action, input: editedInput };
      }
    }

    // 先落盤再執行：write-behind 的 save 若遇到當機/滾動重啟，會讓已執行的動作重新變回待確認而被重複確認
    await conversationStore.saveCritical(session);
    const confirmText = edits.length > 0 ? `確認（已修改：${edits.join('；')}）` : '確認';
    session.messages.push({ role: 'user', content: [{ type: 'text', text: confirmText }] });
    const outcome = await runConfirmedAction(session, finalAction);
    conversationStore.save(session);
    if (!outcome.ok && outcome.code === 'FORBIDDEN') throw AppError.forbidden(outcome.reply);
    return {
      reply: outcome.reply,
      status: session.status,
      values: session.values,
      submission: session.submission,
      suggestions: [],
      actionOk: outcome.ok,
    };
  },

  /**
   * 不經 AI 直接提議寫入動作（如 app 的「建立補貨單」按鈕）：與 AI 提議相同的權限與輸入驗證，
   * 只建立待確認動作（取代既有的那筆），仍需使用者確認才會執行。
   */
  async proposeAction(
    tenantId: string,
    userId: string,
    id: string,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<{ pendingAction: PendingActionView }> {
    const session = conversationStore.get(id, tenantId, userId);
    const ctx = makeToolContext({ tenantId, userId, locale: session.locale });
    await toolRegistry.prepare(ctx);
    let tool;
    try {
      tool = toolRegistry.resolve(toolId, ctx);
    } catch {
      throw new AppError(404, 'TOOL_NOT_FOUND', `找不到工具：${toolId}`);
    }
    if (!isWriteTool(tool)) throw new AppError(422, 'NOT_A_WRITE_TOOL', '只能提議寫入類動作');
    toolRegistry.assertInvocable(toolId, input, ctx);
    const action = createPendingAction(tool, input);
    session.pendingAction = action;
    conversationStore.save(session);
    return { pendingAction: toPendingActionView(action) };
  },
```

- [ ] **Step 4：controller、routes、OpenAPI**

`conversation.controller.ts`：
- import 加 `import type { ConfirmBody, ProposeBody } from './conversation.schema';`（若已有從 `./conversation.schema` 的 type import，合併）
- `confirmAction` 改為：

```ts
  /** 確認卡片「確認」（不經 LLM）；body.input 為使用者修改後的參數（選填） */
  async confirmAction(req: Request, res: Response): Promise<void> {
    const { input } = req.body as ConfirmBody;
    const turn = await conversationService.confirmAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      String(req.params.actionId),
      input,
    );
    res.status(200).json({ data: turn });
  },

  /** 不經 AI 直接提議寫入動作 */
  async proposeAction(req: Request, res: Response): Promise<void> {
    const { toolId, input } = req.body as ProposeBody;
    const data = await conversationService.proposeAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      toolId,
      input,
    );
    res.status(200).json({ data });
  },
```

`conversation.routes.ts`：import 加入 `confirmBodySchema`、`proposeBodySchema`；confirm 路由改為 `validate({ params: actionParamSchema, body: confirmBodySchema })`；在 confirm 路由之前加：

```ts
// 不經 AI 直接提議寫入動作（app「建立補貨單」等按鈕用）；仍需確認才執行
router.post(
  '/:id/actions/propose',
  validate({ params: idParamSchema, body: proposeBodySchema }),
  asyncHandler(conversationController.proposeAction),
);
```

（`idParamSchema` 若尚未 import，一併加入）

`openapi.ts`：在 confirm 端點的 `post` 內加 `requestBody`：

```ts
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: { input: { type: "object", additionalProperties: true } } } } },
        },
```

並在其 `responses` 加 `"422": { description: "ACTION_INPUT_INVALID：修改後的參數不合法（動作保留）" },`；再新增：

```ts
    "/api/conversations/{id}/actions/propose": {
      post: {
        tags: ["conversations"],
        summary: "不經 AI 直接提議寫入動作（仍需確認）",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["toolId", "input"], properties: { toolId: { type: "string" }, input: { type: "object", additionalProperties: true } } } } },
        },
        responses: {
          "200": { description: "data.pendingAction" },
          "403": { description: "沒有權限" },
          "404": { description: "TOOL_NOT_FOUND" },
          "422": { description: "NOT_A_WRITE_TOOL 或輸入不合法" },
        },
      },
    },
```

- [ ] **Step 5：確認通過、回歸、commit**

Run: `cd server && npx jest tests/conversation-actions-edit.test.ts tests/conversation-actions.test.ts && npm run typecheck`
Expected: PASS。

若 `test.replenish` 的 `format: "date"` 讓 registry 的 Ajv 報「unknown format」（編譯錯誤或驗證不生效），在 `server/src/modules/tools/tool.registry.ts` 載入 `ajv-formats`（server 已有此依賴）：`import addFormats from 'ajv-formats';` 並在建立 `ajv` 後呼叫 `addFormats(ajv);`，同樣處理 `mcp.tool-source.ts` 中做 schema 檢查的 Ajv 實例；在報告中註明。

Run: `cd server && npm test`
Expected: 全部 PASS（已知偶發：auth-protection、knowledge-prompts-member、report-pdf、knowledge-source-audience、tasks 在並行時偶爾失敗，單獨重跑即過）。

```bash
git add server/src/modules/conversation server/src/modules/docs/openapi.ts server/tests/conversation-actions-edit.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 確認可帶修改後參數，新增不經 AI 的提議端點

confirm 可附 input：同步領取動作後驗證唯讀不變與 Ajv，失敗回 422
ACTION_INPUT_INVALID 並還原動作；逐字稿記下修改差異。新增
POST /actions/propose，只接受寫入工具、只建立待確認動作。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7：LLM 層支援圖片與強制工具呼叫

**Files:**
- Modify: `server/src/lib/llm/types.ts`
- Modify: `server/src/lib/llm/anthropic.provider.ts`
- Modify: `server/src/lib/llm/openai.provider.ts`
- Test: `server/tests/llm-image-toolchoice.test.ts`

**Interfaces:**
- Produces:
  - `LLMContentBlock` 新增 `{ type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }`
  - `LLMCreateParams.toolChoice?: { name: string }`

- [ ] **Step 1：寫失敗測試**

`server/tests/llm-image-toolchoice.test.ts`：

```ts
/** image 區塊與強制工具呼叫，在兩家 provider 的請求格式。 */
const openaiCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openaiCreate } } })),
}));

const anthropicCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'tool_use', id: 't1', name: 'report', input: { a: 1 } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
});
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: anthropicCreate } })),
}));

import { getLLMProvider } from '@/lib/llm';
import type { LLMCreateParams } from '@/lib/llm';

const params: LLMCreateParams = {
  system: 's',
  messages: [{
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/jpeg', data: 'QUJD' },
      { type: 'text', text: '分析這張照片' },
    ],
  }],
  tools: [{ name: 'report', description: '回報', inputSchema: { type: 'object', properties: { a: { type: 'integer' } } } }],
  toolChoice: { name: 'report' },
};

beforeEach(() => jest.clearAllMocks());

it('Anthropic：image 轉 base64 source，tool_choice 指定工具', async () => {
  const r = await getLLMProvider({ provider: 'anthropic' }).createMessage(params);
  const sent = anthropicCreate.mock.calls[0][0];
  expect(sent.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  expect(sent.messages[0].content[1]).toEqual({ type: 'text', text: '分析這張照片' });
  expect(sent.tool_choice).toEqual({ type: 'tool', name: 'report' });
  expect(r.toolCalls[0]).toEqual({ id: 't1', name: 'report', input: { a: 1 } });
});

it('OpenAI：含圖片的 user 訊息改用 content parts，tool_choice 指定 function', async () => {
  const r = await getLLMProvider({ provider: 'openai' }).createMessage(params);
  const sent = openaiCreate.mock.calls[0][0];
  expect(sent.messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      { type: 'text', text: '分析這張照片' },
    ],
  });
  expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'report' } });
  expect(r.toolCalls[0]).toEqual({ id: 'c1', name: 'report', input: { a: 1 } });
});

it('沒有 toolChoice、沒有圖片 → 請求不帶 tool_choice，user 內容仍是字串（行為不變）', async () => {
  await getLLMProvider({ provider: 'openai' }).createMessage({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  const sent = openaiCreate.mock.calls[0][0];
  expect(sent).not.toHaveProperty('tool_choice');
  expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
  await getLLMProvider({ provider: 'anthropic' }).createMessage({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
});
```

Run: `cd server && npx jest tests/llm-image-toolchoice.test.ts`
Expected: FAIL（型別或斷言失敗）。

- [ ] **Step 2：型別**

`server/src/lib/llm/types.ts`：
- `LLMContentBlock` 在最後一個成員後加 `| { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }`，並在其上方加註解 `// image：base64 圖片（影像辨識用）；只出現在 user 訊息`
- `LLMCreateParams` 最後加：

```ts
  /** 強制 LLM 呼叫指定工具（取得固定格式的結構化輸出用）；省略＝由模型自行決定 */
  toolChoice?: { name: string };
```

- [ ] **Step 3：Anthropic**

`anthropic.provider.ts`：
- `toContentParam` 的 switch 加：

```ts
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
```

- `messages.create({...})` 參數中，`tools:` 那一行之後加：

```ts
          ...(params.toolChoice ? { tool_choice: { type: 'tool', name: params.toolChoice.name } } : {}),
```

- [ ] **Step 4：OpenAI**

`openai.provider.ts`：
- import 的型別加入 `ChatCompletionContentPart`：

```ts
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
```

- `toOpenAIMessages` 的 user 分支（`else { … }`）整段改為：

```ts
    } else {
      // user 訊息可能含 text（真使用者輸入）、image 與／或 tool_result（工具輸出）
      const parts: ChatCompletionContentPart[] = [];
      let hasImage = false;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          hasImage = true;
          parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
        }
      }
      if (parts.length === 0) continue;
      // 沒有圖片時維持字串內容（與既有行為相同，相容只吃字串的本地模型）
      out.push(
        hasImage
          ? { role: 'user', content: parts }
          : { role: 'user', content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') },
      );
    }
```

- `chat.completions.create({...})` 參數中，`tools:` 那一行之後加：

```ts
          ...(params.toolChoice ? { tool_choice: { type: 'function' as const, function: { name: params.toolChoice.name } } } : {}),
```

- [ ] **Step 5：確認通過、回歸、commit**

Run: `cd server && npx jest tests/llm-image-toolchoice.test.ts tests/llm-temperature.test.ts tests/openai-provider-usage.test.ts tests/openai-provider-baseurl.test.ts && npm run typecheck`
Expected: PASS。若 `npm run typecheck` 指出其他檔案對 `LLMContentBlock` 的 switch 不完整，為該處補上 `image` 分支（只出現在 user 訊息、不需處理者回傳空字串或略過），並在報告中列出。

```bash
git add server/src/lib/llm server/tests/llm-image-toolchoice.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): 支援圖片輸入與強制工具呼叫

LLMContentBlock 新增 image（base64），Anthropic 轉為 base64 source、OpenAI 轉為
image_url content part；新增 toolChoice 以強制呼叫指定工具取得結構化輸出。
無圖片、無 toolChoice 時請求格式不變。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8：門市 Demo MCP 服務（`mcp/store-demo`）

**Files:**
- Create: `mcp/store-demo/package.json`、`tsconfig.json`、`README.md`
- Create: `mcp/store-demo/data/products.json`、`promotions.json`、`coupons.json`
- Create: `mcp/store-demo/assets/README.md`
- Create: `mcp/store-demo/src/data.ts`、`src/match.ts`、`src/tools.ts`、`src/app.ts`、`src/index.ts`、`src/server.ts`
- Test: `mcp/store-demo/tests/tools.test.ts`
- Modify: 根 `package.json`（workspaces、scripts）

**Interfaces:**
- Consumes: `@hyagent/mcp-kit`（`createHyAgentVerifier`、`createMcpHttpApp`、`callerFrom`、`HyAgentVerifier`）
- Produces（`@hyagent/store-demo`）：
  - `createStoreDemoApp(opts: { verifier: HyAgentVerifier; publicBaseUrl: string; now?: () => Date }): { app: Express; store: StoreState }`
  - `interface StoreState { replenishments: { id: string; items: unknown[]; arrivalDate: string; by: string; tenantId: string }[] }`
  - `STORE_TOOLS: StoreTool[]`、`callStoreTool(name, args, ctx): StoreToolResult`（測試用）
  - 工具：`product_lookup`、`inventory_query`、`replenishment_create`、`promotion_list`、`coupon_check`

- [ ] **Step 1：workspace 設定**

`mcp/store-demo/package.json`：

```json
{
  "name": "@hyagent/store-demo",
  "version": "0.1.0",
  "private": true,
  "description": "門市 Demo MCP 服務：商品庫存、補貨單、促銷活動、優惠券（假資料，日期以相對天數儲存）。",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hyagent/mcp-kit": "*",
    "@modelcontextprotocol/sdk": "1.31.0",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "express": "^4.21.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`mcp/store-demo/tsconfig.json`：與 `mcp/kit/tsconfig.json` 相同內容（`module`／`moduleResolution` 為 `NodeNext`、`strict`、`noEmit`，`include` 為 `["src/**/*", "tests/**/*"]`）。不設 `"type": "module"`，相對 import 不帶副檔名。

根 `package.json`：`workspaces` 在 `"mcp/kit",` 之後加 `"mcp/store-demo",`；`scripts.typecheck` 結尾加 ` && npm run typecheck -w mcp/store-demo`；`scripts.test` 結尾加 ` && npm run test -w mcp/store-demo`。

Run: `npm install`
Expected: 成功。若 `sdk/bin/keygen.mjs` 權限被改，執行 `git checkout -- sdk/bin/keygen.mjs`。

- [ ] **Step 2：假資料**

`mcp/store-demo/data/products.json`：

```json
[
  { "id": "P001", "name": "鮭魚御飯糰", "category": "御飯糰", "aliases": ["鮭魚飯糰", "鮭魚三角飯糰"], "stock": 6, "safetyStock": 30, "expiryInDays": 2 },
  { "id": "P002", "name": "鮪魚御飯糰", "category": "御飯糰", "aliases": ["鮪魚飯糰", "三角飯糰-鮪魚"], "stock": 12, "safetyStock": 12, "expiryInDays": 2 },
  { "id": "P003", "name": "明太子御飯糰", "category": "御飯糰", "aliases": ["明太子飯糰"], "stock": 3, "safetyStock": 27, "expiryInDays": 2 },
  { "id": "P004", "name": "雞肉御飯糰", "category": "御飯糰", "aliases": ["雞肉飯糰"], "stock": 18, "safetyStock": 18, "expiryInDays": 3 },
  { "id": "P005", "name": "三明治－火腿蛋", "category": "三明治", "aliases": ["火腿蛋三明治", "火腿三明治"], "stock": 4, "safetyStock": 24, "expiryInDays": 2 },
  { "id": "P006", "name": "三明治－鮪魚", "category": "三明治", "aliases": ["鮪魚三明治"], "stock": 10, "safetyStock": 12, "expiryInDays": 2 },
  { "id": "P007", "name": "沙拉－和風雞肉", "category": "沙拉", "aliases": ["和風雞肉沙拉", "雞肉沙拉"], "stock": 5, "safetyStock": 23, "expiryInDays": 1 },
  { "id": "P008", "name": "沙拉－凱薩", "category": "沙拉", "aliases": ["凱薩沙拉"], "stock": 8, "safetyStock": 8, "expiryInDays": 3 },
  { "id": "P009", "name": "便當－雞腿飯", "category": "便當", "aliases": ["雞腿便當", "雞腿飯"], "stock": 7, "safetyStock": 10, "expiryInDays": 1 },
  { "id": "P010", "name": "便當－排骨飯", "category": "便當", "aliases": ["排骨便當", "排骨飯"], "stock": 9, "safetyStock": 10, "expiryInDays": 2 },
  { "id": "P011", "name": "關東煮－蘿蔔", "category": "關東煮", "aliases": ["蘿蔔", "關東煮蘿蔔"], "stock": 20, "safetyStock": 15, "expiryInDays": 1 },
  { "id": "P012", "name": "關東煮－黑輪", "category": "關東煮", "aliases": ["黑輪"], "stock": 25, "safetyStock": 15, "expiryInDays": 2 },
  { "id": "P013", "name": "茶葉蛋", "category": "熟食", "aliases": ["茶葉蛋"], "stock": 30, "safetyStock": 20, "expiryInDays": 2 },
  { "id": "P014", "name": "鮮奶 290ml", "category": "飲料", "aliases": ["鮮奶", "牛奶"], "stock": 14, "safetyStock": 20, "expiryInDays": 4 },
  { "id": "P015", "name": "無糖綠茶 600ml", "category": "飲料", "aliases": ["綠茶", "無糖綠茶"], "stock": 40, "safetyStock": 30, "expiryInDays": 180 },
  { "id": "P016", "name": "美式咖啡（中）", "category": "咖啡", "aliases": ["美式咖啡", "黑咖啡"], "stock": 99, "safetyStock": 0, "expiryInDays": 365 },
  { "id": "P017", "name": "拿鐵咖啡（中）", "category": "咖啡", "aliases": ["拿鐵", "拿鐵咖啡"], "stock": 99, "safetyStock": 0, "expiryInDays": 365 },
  { "id": "P018", "name": "布丁", "category": "甜點", "aliases": ["雞蛋布丁"], "stock": 2, "safetyStock": 12, "expiryInDays": 5 },
  { "id": "P019", "name": "麵包－菠蘿", "category": "麵包", "aliases": ["菠蘿麵包"], "stock": 6, "safetyStock": 6, "expiryInDays": 1 },
  { "id": "P020", "name": "優格", "category": "乳品", "aliases": ["原味優格"], "stock": 11, "safetyStock": 10, "expiryInDays": 6 }
]
```

`mcp/store-demo/data/promotions.json`：

```json
[
  { "id": "PR01", "title": "御飯糰第二件 6 折", "description": "任選御飯糰兩件，第二件 6 折（價低者折扣）", "category": "御飯糰", "validFromDays": -3, "validToDays": 4 },
  { "id": "PR02", "title": "中杯咖啡第二杯半價", "description": "美式、拿鐵中杯任選，第二杯半價", "category": "咖啡", "validFromDays": -10, "validToDays": 20 },
  { "id": "PR03", "title": "沙拉＋飲料 79 元", "description": "指定沙拉搭配 600ml 茶飲，優惠價 79 元", "category": "沙拉", "validFromDays": -1, "validToDays": 6 },
  { "id": "PR04", "title": "便當加 10 元多一顆茶葉蛋", "description": "購買任一便當，加 10 元可換購茶葉蛋一顆", "category": "便當", "validFromDays": 0, "validToDays": 2 },
  { "id": "PR05", "title": "布丁買二送一", "description": "布丁任選三件，價低者免費（已結束）", "category": "甜點", "validFromDays": -20, "validToDays": -5 }
]
```

`mcp/store-demo/data/coupons.json`：

```json
[
  { "code": "COFFEE50", "title": "咖啡折 5 元", "description": "中杯以上咖啡折抵 5 元", "categories": ["咖啡"], "validFromDays": -5, "validToDays": 10, "used": false, "conditions": "限中杯以上，每次限用一張" },
  { "code": "ONIGIRI10", "title": "御飯糰折 10 元", "description": "任一御飯糰折抵 10 元", "categories": ["御飯糰"], "validFromDays": -2, "validToDays": 1, "used": false, "conditions": "不得與第二件 6 折併用" },
  { "code": "SALAD20", "title": "沙拉折 20 元", "description": "任一沙拉折抵 20 元", "categories": ["沙拉"], "validFromDays": -30, "validToDays": -1, "used": false, "conditions": "已過期" },
  { "code": "BENTO15", "title": "便當折 15 元", "description": "任一便當折抵 15 元", "categories": ["便當"], "validFromDays": -3, "validToDays": 7, "used": true, "conditions": "限用一次" },
  { "code": "MILK5", "title": "鮮奶折 5 元", "description": "鮮奶 290ml 折抵 5 元", "categories": ["飲料"], "productIds": ["P014"], "validFromDays": 2, "validToDays": 9, "used": false, "conditions": "活動尚未開始" }
]
```

`mcp/store-demo/assets/README.md`：

```markdown
商品圖片：把 `<商品 id>.png` 或 `<商品 id>.jpg`（例如 `P001.png`）放在這個資料夾，
服務啟動時會自動對應，表格與確認卡片就會顯示縮圖；沒有圖片的商品只顯示名稱。
```

- [ ] **Step 3：寫失敗測試**

`mcp/store-demo/tests/tools.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { callStoreTool, createStoreState } from '../src';

const NOW = new Date('2026-10-03T10:00:00+08:00');
const ctx = (extra: Partial<Parameters<typeof callStoreTool>[2]> = {}) => ({
  now: () => NOW,
  publicBaseUrl: 'https://store.example.com',
  imageIds: new Set(['P001']),
  caller: { tenantId: 't1', userId: 'kevin', scopes: [], jti: 'j', system: false },
  state: createStoreState(),
  ...extra,
});

describe('product_lookup', () => {
  it('名稱、別名與相近名稱都能比對；比不到不給 productId', () => {
    const r = callStoreTool('product_lookup', { names: ['鮭魚御飯糰', '火腿蛋三明治', '鮪魚飯團', '外星人'] }, ctx());
    const m = (r.structuredContent as { matches: { query: string; productId?: string; score: number }[] }).matches;
    expect(m[0]).toMatchObject({ productId: 'P001', score: 1 });
    expect(m[1]).toMatchObject({ productId: 'P005' });
    expect(m[2].productId).toBe('P002');
    expect(m[3].productId).toBeUndefined();
  });
});

describe('inventory_query', () => {
  it('依關鍵字查；建議補貨＝安全庫存－庫存；即期以到期日 ≤ 明天判斷；有圖片才帶網址；附表格提示', () => {
    const r = callStoreTool('inventory_query', { keyword: '御飯糰' }, ctx());
    const items = (r.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items.map((i) => i.productId)).toEqual(['P001', 'P002', 'P003', 'P004']);
    expect(items[0]).toMatchObject({ name: '鮭魚御飯糰', stock: 6, suggested: 24, status: '庫存偏低', expiryDate: '2026-10-05', expiring: false, image: 'https://store.example.com/assets/P001.png' });
    expect(items[1]).toMatchObject({ suggested: 0, status: '正常' });
    expect(items[1]).not.toHaveProperty('image');
    expect(r.display).toMatchObject({ type: 'table', rows: 'items' });
  });

  it('依 productIds 查；沙拉（到期日明天）為即期', () => {
    const r = callStoreTool('inventory_query', { productIds: ['P007'] }, ctx());
    const item = (r.structuredContent as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ productId: 'P007', expiryDate: '2026-10-04', expiring: true });
  });
});

describe('replenishment_create', () => {
  it('建立補貨單並記錄呼叫者', () => {
    const state = createStoreState();
    const r = callStoreTool('replenishment_create', {
      items: [{ productId: 'P001', name: '鮭魚御飯糰', stock: 6, quantity: 24 }],
      arrivalDate: '2026-10-04',
    }, ctx({ state }));
    expect(r.isError).toBeFalsy();
    expect(state.replenishments).toHaveLength(1);
    expect(state.replenishments[0]).toMatchObject({ by: 'kevin', tenantId: 't1', arrivalDate: '2026-10-04' });
    expect((r.structuredContent as { orderId: string }).orderId).toMatch(/^R-/);
  });

  it('拒絕系統呼叫與不存在的商品', () => {
    const sys = callStoreTool('replenishment_create', { items: [{ productId: 'P001', name: 'x', stock: 1, quantity: 1 }], arrivalDate: '2026-10-04' },
      ctx({ caller: { tenantId: '', userId: '', scopes: [], jti: 'j', system: true } }));
    expect(sys.isError).toBe(true);
    const bad = callStoreTool('replenishment_create', { items: [{ productId: 'P999', name: 'x', stock: 1, quantity: 1 }], arrivalDate: '2026-10-04' }, ctx());
    expect(bad.isError).toBe(true);
  });

  it('輸入不符 schema（數量超過上限）→ isError', () => {
    const r = callStoreTool('replenishment_create', { items: [{ productId: 'P001', name: 'x', stock: 1, quantity: 999 }], arrivalDate: '2026-10-04' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('promotion_list 與 coupon_check', () => {
  it('只列出進行中的活動', () => {
    const r = callStoreTool('promotion_list', {}, ctx());
    const ids = (r.structuredContent as { promotions: { id: string }[] }).promotions.map((p) => p.id);
    expect(ids).toEqual(['PR01', 'PR02', 'PR03', 'PR04']);
    expect(r.display).toMatchObject({ type: 'table', rows: 'promotions' });
  });

  it.each([
    ['COFFEE50', true, '可使用'],
    ['coffee50', true, '可使用'],
    ['SALAD20', false, '已過期'],
    ['BENTO15', false, '已使用'],
    ['MILK5', false, '尚未開始'],
    ['NOPE', false, '查無此券'],
  ])('%s → valid=%s（%s）', (code, valid, reason) => {
    const r = callStoreTool('coupon_check', { code }, ctx());
    expect(r.structuredContent).toMatchObject({ valid, reason });
  });
});
```

Run: `npm run test -w mcp/store-demo`
Expected: FAIL（找不到 `../src`）。

- [ ] **Step 4：實作資料與比對**

`mcp/store-demo/src/data.ts`：

```ts
/** 假資料載入與相對日期換算：任何一天 Demo 都有即期品與有效券。 */
import fs from 'node:fs';
import path from 'node:path';

export interface Product { id: string; name: string; category: string; aliases: string[]; stock: number; safetyStock: number; expiryInDays: number }
export interface Promotion { id: string; title: string; description: string; category: string; validFromDays: number; validToDays: number }
export interface Coupon {
  code: string; title: string; description: string; categories: string[]; productIds?: string[];
  validFromDays: number; validToDays: number; used: boolean; conditions: string;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
export const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')) as T;
}

export const products: Product[] = load<Product[]>('products.json');
export const promotions: Promotion[] = load<Promotion[]>('promotions.json');
export const coupons: Coupon[] = load<Coupon[]>('coupons.json');

const TZ = 'Asia/Taipei';

/** 以台北時區取「今天 + days」的 YYYY-MM-DD */
export function dateAfter(now: Date, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 掃描 assets 資料夾，回傳有圖片的商品 id 與副檔名 */
export function scanImages(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(ASSETS_DIR)) return out;
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    const m = /^(P\d+)\.(png|jpg|jpeg)$/i.exec(f);
    if (m) out.set(m[1], f);
  }
  return out;
}
```

`mcp/store-demo/src/match.ts`：

```ts
/** 商品名稱模糊比對：名稱或別名完全相同 1；包含關係 0.8；否則二字元組 Dice 係數。 */
import { products, type Product } from './data';

export const MATCH_THRESHOLD = 0.5;

function norm(s: string): string {
  return s.replace(/[\s\-－—_()（）]/g, '').replace(/團/g, '糰').toLowerCase();
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return a === b ? 1 : 0;
  const pool = [...y];
  let hit = 0;
  for (const g of x) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

function score(query: string, p: Product): number {
  const q = norm(query);
  let best = 0;
  for (const n of [p.name, ...p.aliases].map(norm)) {
    if (n === q) return 1;
    const s = n.includes(q) || q.includes(n) ? 0.8 : dice(q, n);
    if (s > best) best = s;
  }
  return best;
}

export function matchProduct(query: string): { product?: Product; score: number } {
  let best: Product | undefined;
  let bestScore = 0;
  for (const p of products) {
    const s = score(query, p);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? { product: best, score: Number(bestScore.toFixed(2)) } : { score: Number(bestScore.toFixed(2)) };
}
```

- [ ] **Step 5：實作工具**

`mcp/store-demo/src/tools.ts`：

```ts
/**
 * 門市 Demo 工具：以原始 JSON Schema 宣告（含 readOnly、x-unit 等 HyAgent 確認卡片用的關鍵字），
 * 由低階 MCP Server 提供，並自行以 Ajv 驗證參數。
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { HyAgentCaller } from '@hyagent/mcp-kit';
import { coupons, dateAfter, products, promotions, type Product } from './data';
import { matchProduct } from './match';

export interface StoreState {
  replenishments: { id: string; items: unknown[]; arrivalDate: string; by: string; tenantId: string }[];
}

export function createStoreState(): StoreState {
  return { replenishments: [] };
}

export interface StoreToolContext {
  now: () => Date;
  publicBaseUrl: string;
  /** 有圖片的商品 id → 檔名；測試可傳 Set（檔名預設 <id>.png） */
  imageIds: Map<string, string> | Set<string>;
  caller: HyAgentCaller;
  state: StoreState;
}

export interface StoreToolResult {
  structuredContent?: Record<string, unknown>;
  display?: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

export interface StoreTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run(args: Record<string, unknown>, ctx: StoreToolContext): StoreToolResult;
}

function imageUrl(p: Product, ctx: StoreToolContext): string | undefined {
  const file = ctx.imageIds instanceof Map ? ctx.imageIds.get(p.id) : ctx.imageIds.has(p.id) ? `${p.id}.png` : undefined;
  return file ? `${ctx.publicBaseUrl.replace(/\/+$/, '')}/assets/${file}` : undefined;
}

function inventoryRow(p: Product, ctx: StoreToolContext): Record<string, unknown> {
  const suggested = Math.max(0, p.safetyStock - p.stock);
  const image = imageUrl(p, ctx);
  return {
    productId: p.id,
    name: p.name,
    category: p.category,
    ...(image ? { image } : {}),
    stock: p.stock,
    safetyStock: p.safetyStock,
    suggested,
    status: p.stock < p.safetyStock * 0.5 ? '庫存偏低' : '正常',
    expiryDate: dateAfter(ctx.now(), p.expiryInDays),
    expiring: p.expiryInDays <= 1,
  };
}

function fail(text: string): StoreToolResult {
  return { isError: true, text };
}

const INVENTORY_DISPLAY = {
  type: 'table',
  title: '商品庫存',
  rows: 'items',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success' } },
  ],
};

export const STORE_TOOLS: StoreTool[] = [
  {
    name: 'product_lookup',
    title: '比對商品',
    description: '把商品名稱（可能不完整或有錯字）比對成門市商品，回傳商品編號與比對分數。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', title: '商品名稱', items: { type: 'string' }, minItems: 1, maxItems: 30 } },
      required: ['names'],
      additionalProperties: false,
    },
    run(args) {
      const names = args.names as string[];
      return {
        structuredContent: {
          matches: names.map((q) => {
            const m = matchProduct(q);
            return m.product ? { query: q, productId: m.product.id, name: m.product.name, score: m.score } : { query: q, score: m.score };
          }),
        },
      };
    },
  },
  {
    name: 'inventory_query',
    title: '查詢庫存',
    description: '查詢門市商品庫存：可依關鍵字（商品名或類別，如「御飯糰」）、類別或商品編號查詢；回傳庫存、建議補貨量、到期日與是否即期。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', title: '關鍵字' },
        category: { type: 'string', title: '類別' },
        productIds: { type: 'array', title: '商品編號', items: { type: 'string' }, maxItems: 50 },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const kw = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      const ids = Array.isArray(args.productIds) ? new Set(args.productIds as string[]) : undefined;
      const list = products.filter((p) => {
        if (ids && !ids.has(p.id)) return false;
        if (typeof args.category === 'string' && p.category !== args.category) return false;
        if (kw && !p.category.includes(kw) && !p.name.includes(kw) && !p.aliases.some((a) => a.includes(kw))) return false;
        return true;
      });
      return { structuredContent: { items: list.map((p) => inventoryRow(p, ctx)) }, display: INVENTORY_DISPLAY };
    },
  },
  {
    name: 'replenishment_create',
    title: '建立補貨單',
    description: '建立補貨單（寫入）。items 為要補貨的商品與數量，arrivalDate 為預計到貨日期。',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          title: '補貨品項',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', title: '商品編號', readOnly: true, 'x-hidden': true },
              image: { type: 'string', readOnly: true },
              name: { type: 'string', title: '商品名稱', readOnly: true, 'x-image': 'image' },
              stock: { type: 'integer', title: '目前庫存', readOnly: true, 'x-unit': '個' },
              quantity: { type: 'integer', title: '建議補貨數量', minimum: 1, maximum: 200, 'x-unit': '個' },
            },
            required: ['productId', 'name', 'stock', 'quantity'],
            additionalProperties: false,
          },
        },
        arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
      },
      required: ['items', 'arrivalDate'],
      additionalProperties: false,
    },
    run(args, ctx) {
      if (ctx.caller.system) return fail('系統身分不可建立補貨單');
      const items = args.items as { productId: string; quantity: number }[];
      const unknown = items.filter((i) => !products.some((p) => p.id === i.productId)).map((i) => i.productId);
      if (unknown.length > 0) return fail(`找不到商品：${unknown.join('、')}`);
      const id = `R-${String(ctx.state.replenishments.length + 1).padStart(4, '0')}`;
      ctx.state.replenishments.push({ id, items, arrivalDate: args.arrivalDate as string, by: ctx.caller.userId, tenantId: ctx.caller.tenantId });
      return { structuredContent: { orderId: id, itemCount: items.length, arrivalDate: args.arrivalDate } };
    },
  },
  {
    name: 'promotion_list',
    title: '查詢促銷活動',
    description: '列出目前進行中的促銷活動；可依關鍵字或類別篩選，date 可指定查詢日期（YYYY-MM-DD，預設今天）。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', title: '關鍵字' },
        category: { type: 'string', title: '類別' },
        date: { type: 'string', format: 'date', title: '日期' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const today = typeof args.date === 'string' ? args.date : dateAfter(ctx.now(), 0);
      const kw = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      const list = promotions
        .map((p) => ({ ...p, validFrom: dateAfter(ctx.now(), p.validFromDays), validTo: dateAfter(ctx.now(), p.validToDays) }))
        .filter((p) => p.validFrom <= today && today <= p.validTo)
        .filter((p) => (typeof args.category === 'string' ? p.category === args.category : true))
        .filter((p) => (kw ? p.title.includes(kw) || p.description.includes(kw) || p.category.includes(kw) : true))
        .map((p) => ({ id: p.id, title: p.title, description: p.description, category: p.category, period: `${p.validFrom} ~ ${p.validTo}` }));
      return {
        structuredContent: { promotions: list },
        display: {
          type: 'table',
          title: '進行中的活動',
          rows: 'promotions',
          columns: [
            { key: 'title', label: '活動' },
            { key: 'description', label: '內容' },
            { key: 'period', label: '期間' },
          ],
        },
      };
    },
  },
  {
    name: 'coupon_check',
    title: '查詢優惠券',
    description: '依券號查詢優惠券能否使用、適用商品、期限與使用條件。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', title: '券號', minLength: 1, maxLength: 40 } },
      required: ['code'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const code = (args.code as string).replace(/\s+/g, '').toUpperCase();
      const c = coupons.find((x) => x.code === code);
      if (!c) return { structuredContent: { code, valid: false, reason: '查無此券' } };
      const today = dateAfter(ctx.now(), 0);
      const from = dateAfter(ctx.now(), c.validFromDays);
      const to = dateAfter(ctx.now(), c.validToDays);
      const reason = c.used ? '已使用' : today < from ? '尚未開始' : today > to ? '已過期' : '可使用';
      const applicable = c.productIds
        ? products.filter((p) => c.productIds!.includes(p.id)).map((p) => p.name).join('、')
        : c.categories.join('、');
      const row = { code: c.code, title: c.title, valid: reason === '可使用', reason, applicableTo: applicable, validPeriod: `${from} ~ ${to}`, conditions: c.conditions };
      return {
        structuredContent: { ...row, rows: [row] },
        display: {
          type: 'table',
          title: '優惠券查詢結果',
          rows: 'rows',
          columns: [
            { key: 'title', label: '優惠券' },
            { key: 'reason', label: '狀態', badge: { 可使用: 'success', 已過期: 'danger', 已使用: 'danger', 尚未開始: 'warning' } },
            { key: 'applicableTo', label: '適用' },
            { key: 'validPeriod', label: '期限' },
            { key: 'conditions', label: '條件' },
          ],
        },
      };
    },
  },
];

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map(STORE_TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)]));

export function callStoreTool(name: string, args: Record<string, unknown>, ctx: StoreToolContext): StoreToolResult {
  const tool = STORE_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`未知工具：${name}`);
  const validate = validators.get(name)!;
  if (!validate(args)) return fail(`參數不合法：${ajv.errorsText(validate.errors)}`);
  return tool.run(args, ctx);
}
```

- [ ] **Step 6：MCP app 與進入點**

`mcp/store-demo/src/app.ts`：

```ts
/**
 * 門市 Demo MCP app：以 kit 的無狀態 HTTP app 為基礎，改用低階 Server API 提供原始 JSON Schema
 * （McpServer.registerTool 的 zod 寫法無法表達 readOnly、x-unit 等關鍵字），並公開商品圖片。
 */
import express, { type Express } from 'express';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callerFrom, createMcpHttpApp, type HyAgentVerifier } from '@hyagent/mcp-kit';
import { ASSETS_DIR, scanImages } from './data';
import { callStoreTool, createStoreState, STORE_TOOLS, type StoreState } from './tools';

export interface StoreDemoOptions {
  verifier: HyAgentVerifier;
  /** 對外網址（組商品圖片 URL 用），如 https://store-demo.example.com */
  publicBaseUrl: string;
  now?: () => Date;
}

export function createStoreDemoApp(opts: StoreDemoOptions): { app: Express; store: StoreState } {
  const store = createStoreState();
  const images = scanImages();
  const now = opts.now ?? (() => new Date());
  const app = createMcpHttpApp({
    name: 'store-demo',
    version: '0.1.0',
    verifier: opts.verifier,
    register(server) {
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: STORE_TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, object> },
          annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
        })),
      }));
      server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
        const caller = callerFrom(extra);
        const r = callStoreTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
          now,
          publicBaseUrl: opts.publicBaseUrl,
          imageIds: images,
          caller,
          state: store,
        });
        if (r.isError) return { isError: true, content: [{ type: 'text', text: r.text ?? '執行失敗' }] };
        return {
          content: [{ type: 'text', text: JSON.stringify(r.structuredContent ?? {}) }],
          structuredContent: r.structuredContent,
          ...(r.display ? { _meta: { 'hyagent/display': r.display } } : {}),
        };
      });
    },
  });
  app.use('/assets', express.static(ASSETS_DIR, { maxAge: '1h' }));
  return { app, store };
}
```

`mcp/store-demo/src/index.ts`：

```ts
export { createStoreDemoApp } from './app';
export type { StoreDemoOptions } from './app';
export { callStoreTool, createStoreState, STORE_TOOLS } from './tools';
export type { StoreState, StoreTool, StoreToolContext, StoreToolResult } from './tools';
```

`mcp/store-demo/src/server.ts`：

```ts
/**
 * 執行：HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://localhost:4200 PORT=4200 npm start -w mcp/store-demo
 */
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp } from './app';

const port = Number(process.env.PORT ?? 4200);
const { app } = createStoreDemoApp({
  verifier: createHyAgentVerifier({
    jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
    audience: process.env.MCP_SERVER_ID ?? 'store-demo',
    rejectReplay: true,
  }),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.log(`store-demo MCP server on http://localhost:${port}/mcp`));
```

- [ ] **Step 7：MCP 協定層測試**

在 `mcp/store-demo/tests/tools.test.ts` 檔尾追加（驗證低階 handler 與 `_meta`）：

```ts
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp } from '../src';

describe('MCP 協定', () => {
  it('tools/list 回原始 schema（含 readOnly）；tools/call 回 structuredContent 與顯示提示', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'ES256', use: 'sig' };
    const verifier = createHyAgentVerifier({ jwksUrl: 'http://x', audience: 'store-demo', fetchJwks: async () => ({ keys: [jwk] }) });
    const { app } = createStoreDemoApp({ verifier, publicBaseUrl: 'http://localhost', now: () => NOW });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const token = () => {
      const iat = Math.floor(Date.now() / 1000);
      const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'hyagent', aud: 'store-demo', sub: 'kevin', tenant: 't1', scopes: [], iat, exp: iat + 60, jti: randomUUID() })}`;
      return `${input}.${sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line ? line.slice(5) : text) as { result: Record<string, unknown> };
    };
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      const list = await rpc('tools/list', {});
      const tools = list.result.tools as { name: string; inputSchema: Record<string, unknown> }[];
      const rep = tools.find((t) => t.name === 'replenishment_create')!;
      expect(JSON.stringify(rep.inputSchema)).toContain('"readOnly":true');
      const call = await rpc('tools/call', { name: 'inventory_query', arguments: { keyword: '御飯糰' } });
      expect((call.result.structuredContent as { items: unknown[] }).items).toHaveLength(4);
      expect((call.result._meta as Record<string, { type: string }>)['hyagent/display'].type).toBe('table');
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 8：確認通過、README、commit**

Run: `npm run test -w mcp/store-demo && npm run typecheck -w mcp/store-demo`
Expected: PASS。

若「MCP 協定」測試因協定版本字串不被接受而失敗，把 `protocolVersion` 改為 SDK 匯出的 `LATEST_PROTOCOL_VERSION`（`import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'`）。

`mcp/store-demo/README.md`：

````markdown
# @hyagent/store-demo

門市 Demo 用的自建 MCP 服務（假資料）：

| 工具 | 讀寫 | 說明 |
|---|---|---|
| `product_lookup` | 讀 | 商品名稱模糊比對（影像辨識補齊商品編號用） |
| `inventory_query` | 讀 | 庫存、建議補貨、到期日、是否即期（表格顯示） |
| `replenishment_create` | 寫 | 建立補貨單（確認卡片可勾選品項、改數量、選日期） |
| `promotion_list` | 讀 | 進行中的促銷活動（表格顯示） |
| `coupon_check` | 讀 | 依券號查優惠券狀態（表格顯示） |

資料在 `data/`，日期以「距今天幾天」儲存，執行時換算（台北時區），任何一天 Demo 都有即期品與有效券。
補貨單存在記憶體，重啟清空。商品圖片放在 `assets/`（見該資料夾說明）。

## 執行

```bash
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://localhost:4200 PORT=4200 npm start -w mcp/store-demo
```

在 HyAgent 後台「MCP 服務」登記 `serverId=store-demo`、URL `http://localhost:4200/mcp`，
並在租戶權限分頁把 `mcp:store-demo` 指派給門市人員所在部門或帳號（另需 `service:agent`）。
````

```bash
git add mcp/store-demo package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(store-demo): 新增門市 Demo MCP 服務

提供商品比對、庫存查詢、建立補貨單、促銷活動與優惠券查詢；以原始 JSON Schema
宣告工具（含 readOnly、x-unit 等確認卡片關鍵字）、回傳表格顯示提示。日期以
相對天數儲存，商品圖片由 assets 資料夾自動對應。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9：影像辨識 API

**Files:**
- Modify: `server/src/config/env.ts`、`server/tests/setup-env.ts`
- Modify: `server/src/middlewares/upload.ts`（新增 `singleImageUpload`）
- Create: `server/src/modules/vision/vision.types.ts`、`prompts.ts`、`vision.service.ts`、`vision.controller.ts`、`vision.routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/vision.test.ts`

**Interfaces:**
- Consumes: Task 7 image 區塊與 `toolChoice`；Task 1 `buildDisplayBlock`；Task 2 `unwrapToolOutput`；Task 8 工具名稱與輸出格式
- Produces:
  - `env.VISION_STORE_SERVER_ID`（預設 `'store-demo'`）
  - `singleImageUpload(field = 'image'): RequestHandler`（jpeg／png／webp，5MB）
  - `analyzeShelf(principal: { tenantId: string; userId: string }, image: { mediaType: VisionMediaType; data: Buffer }): Promise<ShelfResult>`
  - `analyzeCoupon(principal, image): Promise<CouponResult>`
  - `ShelfResult`、`ShelfFinding`、`CouponResult`、`VisionMediaType`（見 `vision.types.ts`）
  - HTTP：`POST /api/vision/analyze`（multipart `image`、`mode`）→ `{ data: ShelfResult | CouponResult }`

- [ ] **Step 1：環境變數與上傳中介層**

`env.ts` 的 schema 在 `MCP_PREVIOUS_PUBLIC_KEY` 之後加：

```ts
  // 影像辨識查詢門市資料用的 MCP serverId（product_lookup／inventory_query／coupon_check 所在服務）
  VISION_STORE_SERVER_ID: z.string().regex(/^[a-z0-9-]{1,32}$/).default('store-demo'),
```

`setup-env.ts` 檔尾加 `process.env.VISION_STORE_SERVER_ID ??= 'store-demo';`

`upload.ts` 檔尾加：

```ts
/** 影像辨識專用：只收 jpeg／png／webp，單檔 5MB（app 上傳前已縮圖） */
export const MAX_IMAGE_SIZE_MB = 5;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (IMAGE_MIME.has(file.mimetype)) cb(null, true);
    else cb(AppError.unprocessable(`只接受 JPEG、PNG、WebP 圖片：${file.mimetype}`));
  },
});

export function singleImageUpload(field = 'image'): RequestHandler {
  const handler = imageUpload.single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        next(AppError.unprocessable(err.code === 'LIMIT_FILE_SIZE' ? `圖片超過上限 ${MAX_IMAGE_SIZE_MB}MB` : `上傳失敗：${err.message}`));
        return;
      }
      next(err);
    });
  };
}
```

- [ ] **Step 2：寫失敗測試**

`server/tests/vision.test.ts`：

```ts
/**
 * 影像辨識 API：假 LLM 回固定的回報工具呼叫；門市工具以同 id 的靜態測試工具代替 MCP。
 */
const llmCreate = jest.fn();
jest.mock('@/lib/llm', () => {
  const actual = jest.requireActual('@/lib/llm');
  return { ...actual, getLLMProvider: () => ({ name: 'fake', createMessage: llmCreate }) };
});

import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { registerTool, toolOutput } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const usage = { inputTokens: 1, outputTokens: 1 };

const products: Record<string, { productId: string; name: string; stock: number; suggested: number; expiryDate: string; expiring: boolean }> = {
  鮭魚御飯糰: { productId: 'P001', name: '鮭魚御飯糰', stock: 0, suggested: 30, expiryDate: '2026-10-05', expiring: false },
  沙拉: { productId: 'P007', name: '沙拉－和風雞肉', stock: 5, suggested: 18, expiryDate: '2026-10-04', expiring: true },
};

registerTool({
  id: 'mcp.store-demo.product_lookup', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } },
  handler: async (input) => ({
    matches: (input as { names: string[] }).names.map((q) => (products[q] ? { query: q, productId: products[q].productId, name: products[q].name, score: 1 } : { query: q, score: 0.1 })),
  }),
});
registerTool({
  id: 'mcp.store-demo.inventory_query', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { productIds: { type: 'array', items: { type: 'string' } } } },
  handler: async (input) => toolOutput({
    items: Object.values(products).filter((p) => (input as { productIds: string[] }).productIds.includes(p.productId)),
  }, { type: 'table', rows: 'items', columns: [{ key: 'name', label: '商品' }] }),
});
registerTool({
  id: 'mcp.store-demo.coupon_check', description: 'x', scopes: [], effect: 'read',
  inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  handler: async (input) => toolOutput(
    { code: (input as { code: string }).code, valid: true, reason: '可使用', rows: [{ title: '咖啡折 5 元', reason: '可使用' }] },
    { type: 'table', rows: 'rows', columns: [{ key: 'title', label: '優惠券' }, { key: 'reason', label: '狀態' }] },
  ),
});

function reportCall(name: string, input: Record<string, unknown>) {
  return { text: '', toolCalls: [{ id: 'r1', name, input }], stopReason: 'tool_use', usage, model: 'm', keySource: 'platform' };
}

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

function analyze(t: string, mode: string, file: Buffer = PNG, mime = 'image/png') {
  return request(app)
    .post('/api/vision/analyze')
    .set('Authorization', `Bearer ${t}`)
    .field('mode', mode)
    .attach('image', file, { filename: 'shelf.png', contentType: mime });
}

beforeEach(() => {
  llmCreate.mockReset();
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

describe('POST /api/vision/analyze — shelf', () => {
  it('辨識 → 補齊商品與庫存 → 即期判斷 → 補貨提議；座標夾回 0–1', async () => {
    llmCreate.mockResolvedValue(reportCall('report_shelf', {
      items: [
        { name: '鮭魚御飯糰', status: 'out_of_stock', box: { x: 0.1, y: 0.2, w: 0.15, h: 0.1 } },
        { name: '沙拉', status: 'ok', box: { x: -0.2, y: 0.9, w: 0.5, h: 0.4 } },
        { name: '神秘商品', status: 'misplaced', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
      ],
    }));
    const t = await token();
    const res = await analyze(t, 'shelf');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.mode).toBe('shelf');
    expect(d.findings[0]).toMatchObject({ name: '鮭魚御飯糰', productId: 'P001', status: 'out_of_stock', stock: 0, suggestedQty: 30 });
    expect(d.findings[1]).toMatchObject({ productId: 'P007', status: 'expiring', expiryDate: '2026-10-04' });
    // x=-0.2 超出左緣：夾到 0，可見寬度扣掉超出的 0.2 → 0.3；y=0.9 時高度最多到底 → 0.1
    expect(d.findings[1].box).toEqual({ x: 0, y: 0.9, w: 0.3, h: 0.1 });
    expect(d.findings[2]).toMatchObject({ name: '神秘商品', status: 'misplaced' });
    expect(d.findings[2]).not.toHaveProperty('productId');
    expect(d.counts).toEqual({ outOfStock: 1, expiring: 1, misplaced: 1 });
    expect(d.replenishment.toolId).toBe('mcp.store-demo.replenishment_create');
    expect(d.replenishment.input.items).toEqual([{ productId: 'P001', name: '鮭魚御飯糰', stock: 0, quantity: 30 }]);
    expect(d.replenishment.input.arrivalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sent = llmCreate.mock.calls[0][0];
    expect(sent.toolChoice).toEqual({ name: 'report_shelf' });
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
  });

  it('LLM 沒有呼叫回報工具 → 502 VISION_FAILED', async () => {
    llmCreate.mockResolvedValue({ text: '我看不清楚', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform' });
    const res = await analyze(await token(), 'shelf');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('VISION_FAILED');
  });

  it('回報格式不對 → 502 VISION_FAILED', async () => {
    llmCreate.mockResolvedValue(reportCall('report_shelf', { items: 'oops' }));
    const res = await analyze(await token(), 'shelf');
    expect(res.status).toBe(502);
  });
});

describe('POST /api/vision/analyze — coupon', () => {
  it('讀到券號 → 查券並回表格區塊', async () => {
    llmCreate.mockResolvedValue(reportCall('report_coupon', { code: ' coffee 50 ', title: '咖啡折 5 元' }));
    const res = await analyze(await token(), 'coupon');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'coupon', extracted: { code: 'COFFEE50', title: '咖啡折 5 元' }, result: { valid: true } });
    expect(res.body.data.block.type).toBe('table');
  });

  it('讀不到券號 → 提示改用掃條碼或手動輸入', async () => {
    llmCreate.mockResolvedValue(reportCall('report_coupon', {}));
    const res = await analyze(await token(), 'coupon');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('讀不到券號，請掃條碼或手動輸入');
    expect(res.body.data.result).toBeUndefined();
  });
});

describe('POST /api/vision/analyze — 輸入與權限', () => {
  it('非圖片 → 422；mode 不合法 → 422；沒附圖 → 422', async () => {
    const t = await token();
    expect((await analyze(t, 'shelf', Buffer.from('%PDF'), 'application/pdf')).status).toBe(422);
    expect((await analyze(t, 'menu')).status).toBe(422);
    expect((await request(app).post('/api/vision/analyze').set('Authorization', `Bearer ${t}`).field('mode', 'shelf')).status).toBe(422);
  });

  it('沒有 service:agent → 403；未登入 → 401', async () => {
    tenantStore.updateTenant('default', { grantedScopes: [] });
    expect((await analyze(await token(), 'shelf')).status).toBe(403);
    expect((await request(app).post('/api/vision/analyze').field('mode', 'shelf')).status).toBe(401);
  });
});
```

Run: `cd server && npx jest tests/vision.test.ts`
Expected: FAIL（路由不存在 404）。

- [ ] **Step 3：型別與提示詞**

`server/src/modules/vision/vision.types.ts`：

```ts
import type { DisplayBlock } from '@hyagent/shared';

export type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp';
export type ShelfStatus = 'out_of_stock' | 'expiring' | 'misplaced' | 'ok';

export interface ShelfFinding {
  name: string;
  productId?: string;
  status: ShelfStatus;
  /** 0–1 相對座標（左上角 x,y 與寬高） */
  box: { x: number; y: number; w: number; h: number };
  stock?: number;
  suggestedQty?: number;
  expiryDate?: string;
  note?: string;
}

export interface ShelfResult {
  mode: 'shelf';
  findings: ShelfFinding[];
  counts: { outOfStock: number; expiring: number; misplaced: number };
  replenishment?: { toolId: string; input: Record<string, unknown> };
  warnings?: string[];
}

export interface CouponResult {
  mode: 'coupon';
  extracted: { code?: string; title?: string; expiry?: string };
  result?: Record<string, unknown>;
  block?: DisplayBlock;
  message?: string;
  warnings?: string[];
}
```

`server/src/modules/vision/prompts.ts`：

```ts
/** 影像辨識的系統提示詞與回報工具定義（Demo 前依實際照片調校，見 scripts/vision-eval.ts）。 */
import type { LLMTool } from '@/lib/llm/types';

export const SHELF_SYSTEM = [
  '你是便利商店的貨架稽核助手。仔細看照片中的每一格貨架與每一件可辨識的商品。',
  '對每個可辨識的商品位置，回報：',
  '- name：商品名稱（盡量寫完整，如「鮭魚御飯糰」「三明治－火腿蛋」）。',
  '- status：out_of_stock＝該商品的位置空了或只剩極少；misplaced＝明顯放錯區（例如飯糰區出現便當）；ok＝正常。',
  '- box：該商品（或空位）在照片中的位置，0 到 1 的相對座標：x、y 為左上角，w、h 為寬高。',
  '- note：選填，簡短說明（例如「標價牌下方空位」）。',
  '看不清楚的不要猜；不要判斷有效期限。只能透過呼叫 report_shelf 回報結果。',
].join('\n');

export const REPORT_SHELF_TOOL: LLMTool = {
  name: 'report_shelf',
  description: '回報貨架辨識結果',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string', enum: ['out_of_stock', 'misplaced', 'ok'] },
            box: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
              required: ['x', 'y', 'w', 'h'],
            },
            note: { type: 'string' },
          },
          required: ['name', 'status', 'box'],
        },
      },
    },
    required: ['items'],
  },
};

export const COUPON_SYSTEM = [
  '你是便利商店的優惠券辨識助手。照片是客人出示的優惠券（紙本或手機畫面）。',
  '讀出券上「印出來的文字」：code＝券號（通常是英數字），title＝券名，expiry＝有效期限（照券上寫法）。',
  '只讀印刷文字，不要解讀條碼或 QR code 圖形；讀不到的欄位就不要填，不要猜。',
  '只能透過呼叫 report_coupon 回報結果。',
].join('\n');

export const REPORT_COUPON_TOOL: LLMTool = {
  name: 'report_coupon',
  description: '回報優惠券辨識結果',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' }, title: { type: 'string' }, expiry: { type: 'string' } },
  },
};
```

- [ ] **Step 4：服務**

`server/src/modules/vision/vision.service.ts`：

```ts
/**
 * 影像辨識：照片 → LLM（強制呼叫回報工具，取得固定格式）→ 經 Tool Registry 呼叫門市 MCP 補齊資料。
 * 照片只在記憶體處理；MCP 不可用時仍回傳辨識結果並附 warnings。
 */
import { z } from 'zod';
import { env } from '@/config/env';
import { getLLMProvider, type LLMProvider, type LLMResult } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { buildDisplayBlock } from '@/modules/display/display-block';
import { makeToolContext, toolRegistry, unwrapToolOutput, type ToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import { COUPON_SYSTEM, REPORT_COUPON_TOOL, REPORT_SHELF_TOOL, SHELF_SYSTEM } from './prompts';
import type { CouponResult, ShelfFinding, ShelfResult, VisionMediaType } from './vision.types';

interface Principal {
  tenantId: string;
  userId: string;
}
interface ImageInput {
  mediaType: VisionMediaType;
  data: Buffer;
}

const DEFAULT_REPLENISH_QTY = 10;

const shelfReportSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().trim().min(1),
      status: z.enum(['out_of_stock', 'misplaced', 'ok']),
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      note: z.string().optional(),
    }),
  ),
});
const couponReportSchema = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  expiry: z.string().optional(),
});

function toolId(name: string): string {
  return `mcp.${env.VISION_STORE_SERVER_ID}.${name}`;
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** 夾回 [0,1]：左上角先夾，寬高再夾到不超出右下邊界 */
export function clampBox(b: { x: number; y: number; w: number; h: number }): ShelfFinding['box'] {
  const x = clamp(b.x);
  const y = clamp(b.y);
  return { x, y, w: clamp(Math.min(b.w + Math.min(b.x, 0), 1 - x)), h: clamp(Math.min(b.h + Math.min(b.y, 0), 1 - y)) };
}

async function report<T>(
  principal: Principal,
  system: string,
  tool: typeof REPORT_SHELF_TOOL,
  image: ImageInput,
  instruction: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const llm: LLMProvider = getLLMProvider(tenantStore.getTenant(principal.tenantId)?.llmConfig);
  let result: LLMResult;
  try {
    result = await llm.createMessage({
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mediaType: image.mediaType, data: image.data.toString('base64') },
          { type: 'text', text: instruction },
        ],
      }],
      tools: [tool],
      toolChoice: { name: tool.name },
      maxTokens: 2048,
    });
  } catch (err) {
    logger.warn({ err }, 'vision llm call failed');
    throw new AppError(502, 'VISION_FAILED', '影像辨識服務暫時無法使用，請稍後再試');
  }
  usageStore.recordLLMUsage(principal.tenantId, result);
  const call = result.toolCalls.find((c) => c.name === tool.name);
  const parsed = call ? schema.safeParse(call.input) : undefined;
  if (!parsed?.success) {
    logger.warn({ tool: tool.name, text: result.text.slice(0, 200) }, 'vision report missing or malformed');
    throw new AppError(502, 'VISION_FAILED', '無法辨識這張照片，請重新拍攝');
  }
  return parsed.data;
}

/** 呼叫門市工具；工具不可用或失敗時回 undefined 並寫入 warnings */
async function callStore(ctx: ToolContext, name: string, input: Record<string, unknown>, warnings: string[]): Promise<{ data: unknown; display?: unknown } | undefined> {
  try {
    return unwrapToolOutput(await toolRegistry.invoke(toolId(name), input, ctx));
  } catch (err) {
    warnings.push(`門市資料（${name}）暫時無法取得：${(err as Error).message}`);
    return undefined;
  }
}

function tomorrow(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: env.REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function analyzeShelf(principal: Principal, image: ImageInput): Promise<ShelfResult> {
  const reported = await report(principal, SHELF_SYSTEM, REPORT_SHELF_TOOL, image, '請分析這張貨架照片。', shelfReportSchema);
  const ctx = makeToolContext(principal);
  await toolRegistry.prepare(ctx);
  const warnings: string[] = [];

  const findings: ShelfFinding[] = reported.items.map((i) => ({
    name: i.name,
    status: i.status,
    box: clampBox(i.box),
    ...(i.note ? { note: i.note } : {}),
  }));

  const lookup = await callStore(ctx, 'product_lookup', { names: findings.map((f) => f.name) }, warnings);
  const matches = (lookup?.data as { matches?: { query: string; productId?: string; name?: string }[] } | undefined)?.matches ?? [];
  findings.forEach((f, i) => {
    const m = matches[i];
    if (m?.productId) f.productId = m.productId;
  });

  const ids = [...new Set(findings.map((f) => f.productId).filter((x): x is string => !!x))];
  if (ids.length > 0) {
    const inv = await callStore(ctx, 'inventory_query', { productIds: ids }, warnings);
    const items = (inv?.data as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
    const byId = new Map(items.map((it) => [it.productId as string, it]));
    for (const f of findings) {
      const it = f.productId ? byId.get(f.productId) : undefined;
      if (!it) continue;
      if (typeof it.name === 'string') f.name = it.name;
      if (typeof it.stock === 'number') f.stock = it.stock;
      if (typeof it.suggested === 'number') f.suggestedQty = it.suggested;
      if (typeof it.expiryDate === 'string') f.expiryDate = it.expiryDate;
      // 即期判斷來自門市資料，不靠照片
      if (it.expiring === true && f.status === 'ok') f.status = 'expiring';
    }
  }

  const counts = {
    outOfStock: findings.filter((f) => f.status === 'out_of_stock').length,
    expiring: findings.filter((f) => f.status === 'expiring').length,
    misplaced: findings.filter((f) => f.status === 'misplaced').length,
  };

  const seen = new Set<string>();
  const replItems = findings
    .filter((f) => f.status === 'out_of_stock' && f.productId && typeof f.stock === 'number' && !seen.has(f.productId) && seen.add(f.productId))
    .map((f) => ({
      productId: f.productId!,
      name: f.name,
      stock: f.stock!,
      quantity: f.suggestedQty && f.suggestedQty > 0 ? Math.min(f.suggestedQty, 200) : DEFAULT_REPLENISH_QTY,
    }));

  return {
    mode: 'shelf',
    findings,
    counts,
    ...(replItems.length > 0
      ? { replenishment: { toolId: toolId('replenishment_create'), input: { items: replItems, arrivalDate: tomorrow() } } }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function analyzeCoupon(principal: Principal, image: ImageInput): Promise<CouponResult> {
  const reported = await report(principal, COUPON_SYSTEM, REPORT_COUPON_TOOL, image, '請讀出這張優惠券上的資訊。', couponReportSchema);
  const code = reported.code?.replace(/\s+/g, '').toUpperCase() || undefined;
  const extracted = {
    ...(code ? { code } : {}),
    ...(reported.title?.trim() ? { title: reported.title.trim() } : {}),
    ...(reported.expiry?.trim() ? { expiry: reported.expiry.trim() } : {}),
  };
  if (!code) return { mode: 'coupon', extracted, message: '讀不到券號，請掃條碼或手動輸入' };

  const ctx = makeToolContext(principal);
  await toolRegistry.prepare(ctx);
  const warnings: string[] = [];
  const out = await callStore(ctx, 'coupon_check', { code }, warnings);
  if (!out) return { mode: 'coupon', extracted, warnings, message: '暫時無法查詢優惠券，請稍後再試' };
  const block = out.display !== undefined ? buildDisplayBlock(out.display, out.data) : undefined;
  return {
    mode: 'coupon',
    extracted,
    result: out.data as Record<string, unknown>,
    ...(block ? { block } : {}),
  };
}
```

- [ ] **Step 5：controller、routes、掛載**

`server/src/modules/vision/vision.controller.ts`：

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { AppError } from '@/utils/app-error';
import { analyzeCoupon, analyzeShelf } from './vision.service';
import type { VisionMediaType } from './vision.types';

export const analyzeBodySchema = z.object({ mode: z.enum(['shelf', 'coupon']) });

export const visionController = {
  async analyze(req: Request, res: Response): Promise<void> {
    const tenantId = req.tenant?.id ?? 'default';
    const userId = req.user?.sub ?? '';
    if (!resolveScopes({ tenantId, userId }).includes('service:agent')) {
      throw AppError.forbidden('沒有使用影像辨識的權限');
    }
    const file = req.file;
    if (!file) throw AppError.unprocessable('請附上圖片（欄位 image）');
    const { mode } = req.body as z.infer<typeof analyzeBodySchema>;
    const image = { mediaType: file.mimetype as VisionMediaType, data: file.buffer };
    const data = mode === 'shelf' ? await analyzeShelf({ tenantId, userId }, image) : await analyzeCoupon({ tenantId, userId }, image);
    res.status(200).json({ data });
  },
};
```

`server/src/modules/vision/vision.routes.ts`：

```ts
import { Router } from 'express';
import { singleImageUpload } from '@/middlewares/upload';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { analyzeBodySchema, visionController } from './vision.controller';

export const visionRouter = Router();

// 先解析 multipart（multer 才會填 req.body.mode），再驗證 mode
visionRouter.post('/analyze', singleImageUpload('image'), validate({ body: analyzeBodySchema }), asyncHandler(visionController.analyze));
```

`server/src/app.ts`：import 加 `import { visionRouter } from '@/modules/vision/vision.routes';`；在 `/api/conversations` 那一行之後加：

```ts
  // 影像辨識（貨架／優惠券）：呼叫 LLM 計費，與對話同樣套月配額
  app.use('/api/vision', resolveTenant, requireAuth, tenantRateLimit, tenantMonthlyQuota, visionRouter);
```

注意：`validate` 的 body 驗證失敗回 422（`VALIDATION_ERROR`），測試只檢查狀態碼。若 `req.user` 的型別不含 `sub`，參照 `conversation.controller.ts` 的 `resolveUserId` 寫法取得 userId。

- [ ] **Step 6：確認通過、型別、commit**

Run: `cd server && npx jest tests/vision.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add server/src/config/env.ts server/tests/setup-env.ts server/src/middlewares/upload.ts server/src/modules/vision server/src/app.ts server/tests/vision.test.ts
git commit -m "$(cat <<'EOF'
feat(vision): 新增貨架與優惠券影像辨識 API

POST /api/vision/analyze：照片以強制回報工具取得固定格式結果，經 Tool Registry
呼叫門市 MCP 補齊商品編號、庫存、到期日（即期依資料判斷），產生補貨提議；
優惠券模式讀券號後查券並回表格。座標夾回 0–1，LLM 未回報時回 502。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10：Web 前台表格區塊與可編輯確認卡片

**Files:**
- Create: `client/src/DisplayBlockView.tsx`、`client/src/DisplayBlockView.test.tsx`
- Modify: `client/src/ConfirmActionCard.tsx`、`client/src/ConfirmActionCard.test.tsx`
- Modify: `client/src/api.ts`、`client/src/App.tsx`、`client/src/index.css`、`client/src/i18n.ts`

**Interfaces:**
- Consumes: `@hyagent/shared` 的 `DisplayBlock`、`ConfirmForm`、`PendingActionView`；Task 6 HTTP
- Produces:
  - `TurnData.blocks?: DisplayBlock[]`；`api.confirmAction(userId, convId, actionId, input?)`
  - `DisplayBlockView({ block })`
  - `ConfirmActionCard` 的 `onConfirm(input?: Record<string, unknown>)`

- [ ] **Step 1：寫失敗測試**

`client/src/DisplayBlockView.test.tsx`：

```tsx
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisplayBlockView } from './DisplayBlockView';
import type { DisplayBlock } from '@hyagent/shared';

const block: DisplayBlock = {
  type: 'table',
  title: '御飯糰庫存',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success' } },
  ],
  rows: [
    { name: '鮭魚御飯糰', image: 'https://x/a.png', stock: 6, suggested: 24, status: '庫存偏低' },
    { name: '鮪魚御飯糰', image: null, stock: 12, suggested: 0, status: '正常' },
  ],
};

describe('DisplayBlockView', () => {
  it('表格：標題、單位、delta、徽章色調、圖片', () => {
    const { container } = render(<DisplayBlockView block={block} />);
    expect(screen.getByText('御飯糰庫存')).toBeInTheDocument();
    expect(screen.getByText('6 個')).toBeInTheDocument();
    expect(screen.getByText('+24 個')).toHaveClass('block-delta');
    expect(screen.getAllByText('–')).toHaveLength(1);
    expect(screen.getByText('庫存偏低')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('正常')).toHaveAttribute('data-tone', 'success');
    // alt="" 的圖片在無障礙樹是 presentation，不是 img 角色，改用 class 查
    expect(container.querySelectorAll('img.display-thumb')).toHaveLength(1);
  });
});
```

`client/src/ConfirmActionCard.test.tsx` 檔尾追加：

```tsx
describe('ConfirmActionCard — 可編輯表單', () => {
  const editable: PendingActionView = {
    id: 'a2',
    summary: { title: '確認建立補貨單', fields: [] },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    form: {
      title: '確認建立補貨單',
      fields: [
        {
          kind: 'table', key: 'items', label: '補貨品項', selectable: true,
          columns: [
            { key: 'name', label: '商品名稱', kind: 'text', editable: false },
            { key: 'quantity', label: '數量', kind: 'number', editable: true, min: 1, max: 200, unit: '個' },
          ],
          rows: [
            { productId: 'P1', name: '鮭魚御飯糰', quantity: 24 },
            { productId: 'P2', name: '三明治', quantity: 20 },
          ],
        },
        { kind: 'date', key: 'arrivalDate', label: '預計到貨日期', value: '2026-10-05', editable: true },
      ],
    },
  };

  it('改數量、取消勾選一列、改日期 → onConfirm 收到修改後的完整參數', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('鮭魚御飯糰 數量'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('選取 三明治'));
    fireEvent.change(screen.getByLabelText('預計到貨日期'), { target: { value: '2026-10-06' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      items: [{ productId: 'P1', name: '鮭魚御飯糰', quantity: 30 }],
      arrivalDate: '2026-10-06',
    });
  });

  it('沒有修改 → onConfirm 不帶參數', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(undefined));
  });

  it('422 ACTION_INPUT_INVALID → 顯示原因、回到可再送出', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('補貨品項：不可新增列', 422, 'ACTION_INPUT_INVALID'));
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('鮭魚御飯糰 數量'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(screen.getByText('補貨品項：不可新增列')).toBeInTheDocument());
    expect(card()).toHaveAttribute('data-phase', 'ready');
    expect(screen.getByTestId('action-confirm')).toBeEnabled();
  });

  it('全部取消勾選 → 確認鈕停用', () => {
    render(<ConfirmActionCard action={editable} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('選取 鮭魚御飯糰'));
    fireEvent.click(screen.getByLabelText('選取 三明治'));
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
  });
});
```

（檔頭的 import 已有 `fireEvent`、`waitFor`、`vi`、`ApiError`、`PendingActionView`；若缺則補上。）

Run: `cd client && npx vitest run src/DisplayBlockView.test.tsx src/ConfirmActionCard.test.tsx`
Expected: FAIL。

- [ ] **Step 2：表格區塊元件**

`client/src/DisplayBlockView.tsx`：

```tsx
/** 回覆中的畫面區塊（目前只有表格）：資料來自工具，不經 AI 轉述。 */
import type { DisplayBlock, TableColumn } from '@hyagent/shared';

function renderCell(col: TableColumn, row: Record<string, string | number | null>) {
  const v = row[col.key];
  if (col.badge && v !== null && v !== undefined) {
    const tone = col.badge[String(v)] ?? 'neutral';
    return <span className="block-badge" data-tone={tone}>{String(v)}</span>;
  }
  if (col.format === 'delta') {
    if (typeof v === 'number' && v > 0) return <span className="block-delta">{`+${v}${col.unit ? ` ${col.unit}` : ''}`}</span>;
    return <span className="block-muted">–</span>;
  }
  if (v === null || v === undefined || v === '') return <span className="block-muted">–</span>;
  return `${v}${col.unit ? ` ${col.unit}` : ''}`;
}

export function DisplayBlockView({ block }: { block: DisplayBlock }) {
  return (
    <div className="display-block" data-testid="display-block">
      {block.title && <div className="display-block-title">{block.title}</div>}
      <div className="display-block-scroll">
        <table className="display-table">
          <thead>
            <tr>{block.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {block.columns.map((c) => (
                  <td key={c.key}>
                    <span className="display-cell">
                      {c.image && typeof row[c.image] === 'string' && <img src={row[c.image] as string} alt="" className="display-thumb" />}
                      {renderCell(c, row)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3：可編輯確認卡片**

`client/src/ConfirmActionCard.tsx` 整檔改為：

```tsx
/**
 * 寫入動作確認卡片：AI 或按鈕提議的寫入在這裡由使用者確認後才執行。
 * 有 form 時依 schema 推導的欄位可編輯（表格可勾選列、改數字、選日期）；沒有 form 時顯示唯讀摘要。
 * 一次性：按下後立刻鎖住；修改不合法（422）時顯示原因並允許修正後再送。
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfirmField, ConfirmTableField, PendingActionView } from '@hyagent/shared';
import { ApiError } from './api';

type Phase = 'ready' | 'busy' | 'done' | 'failed' | 'cancelled' | 'expired';
type Values = Record<string, unknown>;

export interface ConfirmActionCardProps {
  action: PendingActionView;
  onConfirm(input?: Record<string, unknown>): Promise<{ ok: boolean; reply: string }>;
  onCancel(): Promise<{ reply: string }>;
}

function initialValues(fields: ConfirmField[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.key] = f.kind === 'table' ? f.rows.map((r) => ({ ...r })) : f.value;
  return v;
}

function rowLabel(field: ConfirmTableField, row: Record<string, unknown>, i: number): string {
  const col = field.columns.find((c) => !c.editable && typeof row[c.key] === 'string');
  return col ? String(row[col.key]) : `#${i + 1}`;
}

function coerce(kind: string, raw: string): unknown {
  if (kind !== 'number') return raw;
  const n = Number(raw);
  return raw.trim() === '' || Number.isNaN(n) ? raw : n;
}

export function ConfirmActionCard({ action, onConfirm, onCancel }: ConfirmActionCardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(() => (Date.parse(action.expiresAt) <= Date.now() ? 'expired' : 'ready'));
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const fields = useMemo(() => action.form?.fields ?? [], [action.form]);
  const original = useMemo(() => initialValues(fields), [fields]);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [removed, setRemoved] = useState<Record<string, Set<number>>>({});
  const editable = phase === 'ready';

  function buildInput(): Values {
    const out: Values = {};
    for (const f of fields) {
      if (f.kind === 'table') {
        const gone = removed[f.key] ?? new Set<number>();
        out[f.key] = (values[f.key] as Record<string, unknown>[]).filter((_, i) => !gone.has(i));
      } else {
        out[f.key] = values[f.key];
      }
    }
    return out;
  }

  const input = buildInput();
  const changed = JSON.stringify(input) !== JSON.stringify(original);
  const emptyTable = fields.some((f) => f.kind === 'table' && (input[f.key] as unknown[]).length === 0);

  async function run(kind: 'confirm' | 'cancel') {
    if (phase !== 'ready' || inFlight.current) return;
    inFlight.current = true;
    setPhase('busy');
    setError(null);
    try {
      if (kind === 'confirm') {
        const r = await onConfirm(changed ? input : undefined);
        setPhase(r.ok ? 'done' : 'failed');
      } else {
        await onCancel();
        setPhase('cancelled');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'ACTION_EXPIRED') {
        setPhase('expired');
        return;
      }
      if (e instanceof ApiError && e.status === 422 && e.code === 'ACTION_INPUT_INVALID') {
        // 修改不合法：動作仍保留，讓使用者修正後再送
        setError(e.message);
        inFlight.current = false;
        setPhase('ready');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }

  function setCell(key: string, index: number, col: string, value: unknown) {
    setValues((v) => {
      const rows = (v[key] as Record<string, unknown>[]).map((r, i) => (i === index ? { ...r, [col]: value } : r));
      return { ...v, [key]: rows };
    });
  }

  function toggleRow(key: string, index: number) {
    setRemoved((r) => {
      const next = new Set(r[key] ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...r, [key]: next };
    });
  }

  const statusText: Partial<Record<Phase, string>> = {
    busy: t('action.running'),
    done: t('action.done'),
    failed: t('action.failed'),
    cancelled: t('action.cancelled'),
    expired: t('action.expired'),
  };

  return (
    <div className="confirm-card" data-testid="confirm-action-card" data-phase={phase}>
      <div className="confirm-card-title">{action.form?.title ?? action.summary.title}</div>
      {fields.length === 0 ? (
        <dl className="confirm-card-fields">
          {action.summary.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="confirm-card-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="confirm-card-form">
          {fields.map((f) =>
            f.kind === 'table' ? (
              <table key={f.key} className="confirm-table">
                <thead>
                  <tr>
                    {f.selectable && <th />}
                    {f.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(values[f.key] as Record<string, unknown>[]).map((row, i) => {
                    const label = rowLabel(f, row, i);
                    const off = removed[f.key]?.has(i) ?? false;
                    return (
                      <tr key={i} data-removed={off || undefined}>
                        {f.selectable && (
                          <td>
                            <input type="checkbox" aria-label={`選取 ${label}`} checked={!off} disabled={!editable} onChange={() => toggleRow(f.key, i)} />
                          </td>
                        )}
                        {f.columns.map((c) => (
                          <td key={c.key}>
                            {c.image && typeof row[c.image] === 'string' && <img src={row[c.image] as string} alt="" className="display-thumb" />}
                            {c.editable ? (
                              <input
                                aria-label={`${label} ${c.label}`}
                                type={c.kind === 'number' ? 'number' : c.kind === 'date' ? 'date' : 'text'}
                                min={c.min}
                                max={c.max}
                                value={String(row[c.key] ?? '')}
                                disabled={!editable || off}
                                onChange={(e) => setCell(f.key, i, c.key, coerce(c.kind, e.target.value))}
                              />
                            ) : (
                              <span>{`${String(row[c.key] ?? '–')}${c.unit ? ` ${c.unit}` : ''}`}</span>
                            )}
                            {c.editable && c.unit && <span className="confirm-unit">{c.unit}</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              // 外層用 div：輸入框已有 aria-label，再包 <label> 會讓同一欄被比對兩次
              <div key={f.key} className="confirm-card-field">
                <span>{f.label}</span>
                {f.editable ? (
                  f.kind === 'select' ? (
                    <select aria-label={f.label} value={String(values[f.key] ?? '')} disabled={!editable} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      aria-label={f.label}
                      type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
                      min={f.min}
                      max={f.max}
                      value={String(values[f.key] ?? '')}
                      disabled={!editable}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: coerce(f.kind, e.target.value) }))}
                    />
                  )
                ) : (
                  <span>{String(f.value ?? '')}</span>
                )}
              </div>
            ),
          )}
        </div>
      )}
      {error && phase === 'ready' && <div className="confirm-card-error" role="alert">{error}</div>}
      {phase === 'ready' || phase === 'busy' ? (
        <div className="confirm-card-actions">
          <button type="button" className="confirm-card-primary" data-testid="action-confirm" disabled={phase === 'busy' || emptyTable} onClick={() => void run('confirm')}>
            {phase === 'busy' ? t('action.running') : t('action.confirm')}
          </button>
          <button type="button" data-testid="action-cancel" disabled={phase === 'busy'} onClick={() => void run('cancel')}>
            {t('action.cancel')}
          </button>
        </div>
      ) : (
        <div className="confirm-card-status" role="status">
          {statusText[phase]}
          {error && <div className="confirm-card-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4：API、App、樣式**

`client/src/api.ts`：
- 共用型別 import 加入 `DisplayBlock`（與 `PendingActionView` 同一處），並加入型別重新匯出清單。
- `TurnData` 加 `/** 本回合的畫面區塊（表格等） */ blocks?: DisplayBlock[];`
- `confirmAction` 改為：

```ts
  /** 確認卡片「確認」：不經 LLM；input 為使用者修改後的參數（省略＝照原參數） */
  confirmAction(userId: string, convId: string, actionId: string, input?: Record<string, unknown>): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/actions/${actionId}/confirm`, {
      method: 'POST',
      headers: headers(userId),
      body: JSON.stringify(input ? { input } : {}),
    });
  },
```

`client/src/App.tsx`：
- import 加 `import { DisplayBlockView } from './DisplayBlockView';` 與型別 `DisplayBlock`
- 訊息型別加 `/** 本則回覆的畫面區塊 */ blocks?: DisplayBlock[];`
- `pushMsg` 增加最後一個參數 `blocks?: DisplayBlock[]` 並寫入訊息物件
- `applyTurn` 中 `pushMsg('agent', data.reply, data.suggestions, data.report?.id, data.pendingAction)` 改為 `pushMsg('agent', data.reply, data.suggestions, data.report?.id, data.pendingAction, data.blocks)`
- `confirmPendingAction` 改為接收 `input?: Record<string, unknown>` 並傳給 `api.confirmAction(userId, convId, action.id, input)`；JSX 中 `onConfirm={() => confirmPendingAction(m.pendingAction!)}` 改為 `onConfirm={(input) => confirmPendingAction(m.pendingAction!, input)}`
- 在 `{m.pendingAction && (` 區塊之前加：

```tsx
                  {m.blocks?.map((b, i) => <DisplayBlockView key={i} block={b} />)}
```

`client/src/index.css` 檔尾加：

```css
/* 回覆中的表格區塊 */
.display-block { margin-top: 0.5rem; border: 1px solid var(--border-color); border-radius: 0.75rem; background: var(--card-bg); overflow: hidden; }
.display-block-title { font-weight: 600; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--border-color); }
.display-block-scroll { overflow-x: auto; }
.display-table, .confirm-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.display-table th, .display-table td, .confirm-table th, .confirm-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
.display-table th, .confirm-table th { font-size: 0.8rem; opacity: 0.7; font-weight: 600; }
.display-table tr:last-child td, .confirm-table tr:last-child td { border-bottom: none; }
.display-cell { display: inline-flex; align-items: center; gap: 0.5rem; }
.display-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 6px; }
.block-delta { color: #dc2626; background: #fef2f2; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 0.4rem; }
.block-muted { opacity: 0.5; }
.block-badge { font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 0.4rem; }
.block-badge[data-tone='success'] { color: #15803d; background: #f0fdf4; }
.block-badge[data-tone='warning'] { color: #b45309; background: #fffbeb; }
.block-badge[data-tone='danger'] { color: #dc2626; background: #fef2f2; }
.block-badge[data-tone='neutral'] { color: inherit; background: var(--border-color); }
.confirm-card-form { display: grid; gap: 0.75rem; margin-bottom: 0.75rem; }
.confirm-card-form .confirm-card-field { display: grid; grid-template-columns: minmax(6rem, max-content) 1fr; gap: 0.75rem; align-items: center; }
.confirm-card-form input, .confirm-card-form select { min-height: 2.25rem; padding: 0 0.5rem; border: 1px solid var(--border-color); border-radius: 0.5rem; background: var(--card-bg); color: inherit; }
.confirm-table input[type='number'] { width: 5.5rem; }
.confirm-table tr[data-removed] td { opacity: 0.45; }
.confirm-unit { margin-left: 0.35rem; opacity: 0.7; }
```

- [ ] **Step 5：確認通過、型別、commit**

Run: `cd client && npx vitest run src/DisplayBlockView.test.tsx src/ConfirmActionCard.test.tsx && npm test && npm run typecheck`
Expected: PASS。

```bash
git add client/src
git commit -m "$(cat <<'EOF'
feat(client): 顯示表格區塊並支援可編輯的確認卡片

回覆下方渲染工具結果表格（縮圖、單位、delta、色調徽章）；確認卡片依 form
可勾選列、改數量、選日期，有修改才附上參數，422 時顯示原因並允許修正重送。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11：端到端整合（真實門市 MCP 服務）

**Files:**
- Modify: `server/package.json`（devDependencies 加 `"@hyagent/store-demo": "*"`）
- Modify: `server/jest.config.js`（moduleNameMapper）
- Test: `server/tests/store-demo-e2e.test.ts`

**Interfaces:**
- Consumes: Task 8 `createStoreDemoApp`；Task 3 agent blocks；Task 6 `proposeAction`、`confirmAction(…, editedInput)`；Task 9 `analyzeShelf`（以假 LLM）

- [ ] **Step 1：依賴與對應**

`server/package.json` 的 `devDependencies` 加 `"@hyagent/store-demo": "*"`；`server/jest.config.js` 的 `moduleNameMapper` 加：

```js
    '^@hyagent/store-demo$': '<rootDir>/../mcp/store-demo/src/index.ts',
```

Run: `npm install`

- [ ] **Step 2：寫測試**

`server/tests/store-demo-e2e.test.ts`：

```ts
/**
 * 端到端：真實的門市 Demo MCP 服務（JWT 驗章）＋ agent ＋ 確認流程 ＋ 影像辨識（假 LLM）。
 */
const llmCreate = jest.fn();
jest.mock('@/lib/llm', () => {
  const actual = jest.requireActual('@/lib/llm');
  return { ...actual, getLLMProvider: () => ({ name: 'fake', createMessage: llmCreate }) };
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createStoreDemoApp, type StoreState } from '@hyagent/store-demo';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { conversationService } from '@/modules/conversation/conversation.service';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey, mcpJwks } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { analyzeShelf } from '@/modules/vision/vision.service';
import { tenantStore } from '@/modules/tenant/tenant.store';

const usage = { inputTokens: 1, outputTokens: 1 };
const res = (p: Record<string, unknown>) => ({ text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform', ...p });

let http: Server;
let store: StoreState;
let tenantId: string;

beforeEach(async () => {
  llmCreate.mockReset();
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  const verifier = createHyAgentVerifier({ jwksUrl: 'http://unused', audience: 'store-demo', fetchJwks: async () => mcpJwks() as never, rejectReplay: true });
  const created = createStoreDemoApp({ verifier, publicBaseUrl: 'http://localhost' });
  store = created.store;
  http = await new Promise((r) => { const s = created.app.listen(0, '127.0.0.1', () => r(s)); });
  const { port } = http.address() as AddressInfo;
  const t = tenantStore.createTenant(`store-e2e-${Date.now()}`);
  tenantId = t.id;
  tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });
  scopePolicy.setPolicy(tenantId, { groups: {}, accounts: { kevin: ['mcp:store-demo'] } });
  mcpStore.create({ id: 'store-demo', name: '門市', url: `http://127.0.0.1:${port}/mcp`, ownerTenantId: tenantId, description: '門市庫存與補貨' });
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); });
  mcpStore.clear();
  scopePolicy.clear();
  configureMcpSigningKey(null);
});

it('問庫存 → 回覆帶表格（資料來自門市服務）', async () => {
  llmCreate
    .mockResolvedValueOnce(res({ toolCalls: [{ id: 't1', name: 'mcp_store-demo_inventory_query', input: { keyword: '御飯糰' } }], stopReason: 'tool_use' }))
    .mockResolvedValueOnce(res({ text: '鮭魚與明太子御飯糰庫存偏低。' }));
  const s = { id: 's1', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting', activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: '查御飯糰庫存' }] }], createdAt: new Date().toISOString() } as unknown as Session;
  const out = await agentAgentService.handleTurn(s, '查御飯糰庫存', { name: 'fake', createMessage: llmCreate });
  expect(out.blocks?.[0]).toMatchObject({ type: 'table', title: '商品庫存' });
  expect(out.blocks?.[0].rows[0]).toMatchObject({ name: '鮭魚御飯糰', stock: 6, suggested: 24, status: '庫存偏低' });
});

it('貨架辨識 → 提議補貨單 → 改數量、刪一列後確認 → 門市服務收到修改後的補貨單', async () => {
  llmCreate.mockResolvedValueOnce(res({
    toolCalls: [{ id: 'r1', name: 'report_shelf', input: { items: [
      { name: '鮭魚御飯糰', status: 'out_of_stock', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } },
      { name: '火腿蛋三明治', status: 'out_of_stock', box: { x: 0.3, y: 0.1, w: 0.1, h: 0.1 } },
      { name: '和風雞肉沙拉', status: 'ok', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ] } }],
    stopReason: 'tool_use',
  }));
  const shelf = await analyzeShelf({ tenantId, userId: 'kevin' }, { mediaType: 'image/png', data: Buffer.from('x') });
  expect(shelf.counts).toEqual({ outOfStock: 2, expiring: 1, misplaced: 0 });
  expect(shelf.replenishment!.input.items).toHaveLength(2);

  const conv = conversationStore.create(tenantId, 'kevin', '');
  conversationStore.save(conv);
  const { pendingAction } = await conversationService.proposeAction(tenantId, 'kevin', conv.id, shelf.replenishment!.toolId, shelf.replenishment!.input);
  expect(pendingAction.form?.fields[0]).toMatchObject({ kind: 'table', selectable: true });

  const items = shelf.replenishment!.input.items as Record<string, unknown>[];
  const edited = { ...shelf.replenishment!.input, items: [{ ...items[0], quantity: 30 }] };
  const done = await conversationService.confirmAction(tenantId, 'kevin', conv.id, pendingAction.id, edited);
  expect(done.actionOk).toBe(true);
  expect(store.replenishments).toHaveLength(1);
  expect(store.replenishments[0]).toMatchObject({ by: 'kevin', tenantId });
  expect(store.replenishments[0].items).toEqual([expect.objectContaining({ productId: 'P001', quantity: 30 })]);
});
```

- [ ] **Step 3：跑測試與全套**

Run: `cd server && npx jest tests/store-demo-e2e.test.ts`
Expected: PASS。若 `conversationStore.create` 的參數順序與此不同，依 `conversation.service.ts` 的 `start` 中的呼叫方式調整。

Run: `npm run typecheck && npm test`（repo 根目錄）
Expected: 全部 PASS（已知偶發測試單獨重跑即過）。

- [ ] **Step 4：commit**

```bash
git add server/package.json package-lock.json server/jest.config.js server/tests/store-demo-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(store-demo): 新增門市 Demo 端到端整合測試

以真實門市 MCP 服務（JWT 驗章）驗證：問庫存回表格區塊；貨架辨識產生補貨提議，
經 propose 與帶修改的 confirm 後，門市服務收到修改後的補貨單與正確呼叫者。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12：辨識效果檢視腳本與文件

**Files:**
- Create: `server/scripts/vision-eval.ts`
- Modify: `INTEGRATION.md`、`DEPLOY.zeabur.md`、`server/.env.example`、`README.md`、`mcp/kit/README.md`

- [ ] **Step 1：檢視腳本**

`server/scripts/vision-eval.ts`：

```ts
/**
 * 影像辨識效果檢視（Demo 前調校提示詞用；會呼叫真實 LLM 與門市 MCP，產生費用）。
 *
 * 用法（server/ 目錄）：
 *   DATA_BACKEND=file MCP_SIGNING_KEY="<私鑰>" npx tsx scripts/vision-eval.ts <照片資料夾> <shelf|coupon> [租戶id] [使用者id]
 * 輸出：<照片資料夾>/vision-eval.html（每張照片疊上框選與結果 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initMcpStore } from '@/modules/mcp/mcp.store';
import { analyzeCoupon, analyzeShelf } from '@/modules/vision/vision.service';
import type { VisionMediaType } from '@/modules/vision/vision.types';

const MIME: Record<string, VisionMediaType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const COLOR: Record<string, string> = { out_of_stock: '#dc2626', expiring: '#f59e0b', misplaced: '#7c3aed', ok: '#16a34a' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function main(): Promise<void> {
  const [dir, mode, tenantId = 'default', userId = 'kevin'] = process.argv.slice(2);
  if (!dir || (mode !== 'shelf' && mode !== 'coupon')) {
    console.error('用法：npx tsx scripts/vision-eval.ts <照片資料夾> <shelf|coupon> [租戶id] [使用者id]');
    process.exit(1);
  }
  await initMcpStore();
  const files = fs.readdirSync(dir).filter((f) => MIME[path.extname(f).toLowerCase()]);
  const sections: string[] = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const image = { mediaType: MIME[path.extname(f).toLowerCase()], data: buf };
    const started = Date.now();
    try {
      const out = mode === 'shelf' ? await analyzeShelf({ tenantId, userId }, image) : await analyzeCoupon({ tenantId, userId }, image);
      const boxes = out.mode === 'shelf'
        ? out.findings.map((x) => `<div class="box" style="left:${x.box.x * 100}%;top:${x.box.y * 100}%;width:${x.box.w * 100}%;height:${x.box.h * 100}%;border-color:${COLOR[x.status]}"><span style="background:${COLOR[x.status]}">${esc(x.name)}</span></div>`).join('')
        : '';
      sections.push(`<section><h2>${esc(f)}（${Date.now() - started}ms）</h2><div class="wrap"><img src="data:${image.mediaType};base64,${buf.toString('base64')}">${boxes}</div><pre>${esc(JSON.stringify(out, null, 2))}</pre></section>`);
      console.log(`✓ ${f}`);
    } catch (err) {
      sections.push(`<section><h2>${esc(f)}</h2><pre>錯誤：${esc((err as Error).message)}</pre></section>`);
      console.log(`✗ ${f}：${(err as Error).message}`);
    }
  }
  const html = `<!doctype html><meta charset="utf-8"><title>vision-eval</title><style>body{font-family:sans-serif;margin:24px}section{margin-bottom:40px}.wrap{position:relative;display:inline-block;max-width:900px}.wrap img{max-width:900px;display:block}.box{position:absolute;border:3px solid}.box span{color:#fff;font-size:12px;padding:1px 4px;position:absolute;top:-18px;left:-3px;white-space:nowrap}pre{background:#f4f4f5;padding:12px;max-width:900px;overflow:auto}</style>${sections.join('')}`;
  const out = path.join(dir, 'vision-eval.html');
  fs.writeFileSync(out, html);
  console.log(`輸出：${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run: `cd server && npm run typecheck`
Expected: 無錯誤（腳本在 tsconfig 的 include 範圍內）。

- [ ] **Step 2：文件**

`server/.env.example`：在 `MCP_PREVIOUS_PUBLIC_KEY` 那段之後加：

```bash
# 影像辨識查詢門市資料用的 MCP serverId（預設 store-demo）
# VISION_STORE_SERVER_ID=store-demo
```

`DEPLOY.zeabur.md` 的 server 環境變數表，在 `MCP_PREVIOUS_PUBLIC_KEY` 那一列之後加：

```markdown
| `VISION_STORE_SERVER_ID` | 選填 | 影像辨識查詢門市資料的 MCP serverId，預設 `store-demo` |
```

並在 MCP 相關說明處加一段：門市 Demo MCP 服務（`mcp/store-demo`）需另外部署為一個服務，環境變數 `HYAGENT_JWKS_URL`、`MCP_SERVER_ID`、`PUBLIC_BASE_URL`、`PORT`，啟動指令 `npm start -w mcp/store-demo`。

`INTEGRATION.md` 的「自建 MCP 服務」章節末尾追加：

````markdown
### 回傳表格（顯示提示）

工具可在結果的 `_meta["hyagent/display"]` 宣告表格，HyAgent 會把資料原樣畫成表格（不經 AI 轉述），
AI 只負責說明重點：

```jsonc
{ "type": "table", "title": "商品庫存", "rows": "items",
  "columns": [
    { "key": "name", "label": "商品名稱", "image": "image" },
    { "key": "stock", "label": "目前庫存", "unit": "個" },
    { "key": "suggested", "label": "建議補貨", "unit": "個", "format": "delta" },
    { "key": "status", "label": "狀態", "badge": { "庫存偏低": "danger", "正常": "success" } } ] }
```

限制：最多 50 列、12 欄；儲存格只接受字串或數字；色調只有 success／warning／danger／neutral；圖片須為 http(s) 網址。
對話 API 的回應會在 `blocks` 帶出這些表格。

### 可編輯的確認卡片

寫入工具的確認卡片由輸入 schema 自動產生：`readOnly` 不可改、數字帶 `minimum`／`maximum`、
`format: "date"` 為日期、`enum` 為下拉（`x-enumLabels` 顯示文字）、物件陣列為可勾選表格
（項目需有唯讀欄位辨識列）；延伸關鍵字 `x-unit`、`x-image`、`x-hidden`、`x-display: "html"`。

前端確認時可帶修改後的完整參數：`POST /api/conversations/:id/actions/:actionId/confirm`，body `{ input }`。
後端驗證唯讀不變（可刪列、不可新增或改唯讀值）與 schema；不合法回 `422 ACTION_INPUT_INVALID`，動作保留。
不經 AI 直接提議：`POST /api/conversations/:id/actions/propose`，body `{ toolId, input }`（只接受寫入工具）。

### 影像辨識

`POST /api/vision/analyze`（multipart：`image` 為 jpeg／png／webp ≤ 5MB、`mode` 為 `shelf` 或 `coupon`）：

- `shelf`：回傳 `findings`（名稱、商品編號、狀態、0–1 相對座標框選、庫存、到期日）、`counts`，
  以及可直接送到 `propose` 的 `replenishment`。
- `coupon`：讀出券號後查券，回傳 `extracted`、`result` 與表格 `block`；讀不到券號時 `message` 提示改用掃條碼。

查詢門市資料用的 MCP serverId 由 `VISION_STORE_SERVER_ID` 指定（預設 `store-demo`）。
Demo 前可用 `server/scripts/vision-eval.ts` 以實際照片檢視辨識效果。
````

`mcp/kit/README.md` 的「寫一個工具的規範」清單末尾加：

```markdown
6. **需要表格顯示或可編輯確認卡片**：用 `_meta["hyagent/display"]` 宣告表格；寫入工具的 schema 用 `readOnly`、`x-unit` 等關鍵字（見 INTEGRATION.md）。`McpServer.registerTool` 的 zod 寫法表達不了這些關鍵字時，可改用低階 Server API 提供原始 JSON Schema，範例見 `mcp/store-demo/src/app.ts`。
```

`README.md` 的文件地圖在 `mcp/kit/README.md` 那一列之後加：

```markdown
| [`mcp/store-demo/README.md`](mcp/store-demo/README.md) | 門市 Demo MCP 服務：庫存、補貨單、活動、優惠券（假資料） |
```

專案結構在 `mcp/kit/` 那一行之後加：

```
├─ mcp/store-demo/     門市 Demo MCP 服務 @hyagent/store-demo（POC 用假資料）
```

- [ ] **Step 3：全專案驗證與 commit**

Run: `npm run typecheck && npm test`（repo 根目錄）
Expected: 全部 PASS。

```bash
git add server/scripts/vision-eval.ts INTEGRATION.md DEPLOY.zeabur.md server/.env.example README.md mcp/kit/README.md
git commit -m "$(cat <<'EOF'
docs(store-demo): 補上表格、可編輯確認、影像辨識的整合說明與調校腳本

新增 vision-eval 腳本（實際照片產出框選疊圖報告）；INTEGRATION 說明顯示提示、
schema 推導規則、confirm 帶修改與 propose、影像辨識 API；部署文件補
VISION_STORE_SERVER_ID 與門市 Demo 服務部署方式。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
