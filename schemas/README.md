# Schema 說明文件

`schemas/<formId>/` 是整個 OA Agent 的**單一事實來源（single source of truth）**：一張表單由數個 JSON 檔定義，後端的驗證引擎、LLM 工具、簽核流程，以及前端的表單渲染，全部由這些 JSON 衍生。**新增一張表單 = 新增一個資料夾，不需改編排層程式。**

> 型別 canonical 定義在 [`shared/src/index.ts`](../shared/src/index.ts)，前後端共用；後端透過 [`server/src/modules/form/form.types.ts`](../server/src/modules/form/form.types.ts) 再匯出。

## 目錄

- [檔案總覽](#檔案總覽)
- [一份 Definition 的組成](#一份-definition-的組成)
- [各層詳細規格](#各層詳細規格)
  - [① Data — `data.schema.json`](#-data--dataschemajson必要)
  - [② Field — `field.schema.json`](#-field--fieldschemajson必要)
  - [③ Validation — `validation.schema.json`](#-validation--validationschemajson必要)
  - [④ Agent — `agent.schema.json`](#-agent--agentschemajson必要)
  - [⑤ Layout — `layout.schema.json`](#-layout--layoutschemajson選用)
  - [⑥ Workflow — `workflow.schema.json`](#-workflow--workflowschemajson選用)
  - [⑦ Policy — `policy.schema.json`](#-policy--policyschemajson選用僅時數計算表單)
  - [⑧ OA — `oa.schema.json`](#-oa--oaschemajson選用僅需送出至-oa-的表單)
- [引擎如何消費這些 schema](#引擎如何消費這些-schema)
- [如何新增/設定一張表單](#如何新增設定一張表單)
- [常見問題](#常見問題)

---

## 檔案總覽

| # | 層 | 檔名 | 必要 | 用途 | 主要消費者 |
|---|----|------|------|------|-----------|
| ① | Data | `data.schema.json` | ✅ 必要 | 資料形狀（JSON Schema = OA 契約）| 驗證引擎、LLM `fill_fields` 工具 |
| ② | Field | `field.schema.json` | ✅ 必要 | 欄位 UI 元件、標籤、選項 | 前端渲染、錯誤訊息 |
| ③ | Validation | `validation.schema.json` | ✅ 必要 | 必填 + 跨欄商規 | 驗證引擎、完整性判斷 |
| ④ | Agent | `agent.schema.json` | ✅ 必要 | 詢問順序、提示、確認話術、意圖路由 | 對話 Agent、意圖路由 |
| ⑤ | Layout | `layout.schema.json` | 🔸 選用 | 版面：分組、顯示順序、多步驟 | 前端 `FormView` |
| ⑥ | Workflow | `workflow.schema.json` | 🔸 選用 | 簽核關卡 | 送出後簽核進度計算 |
| ⑦ | Policy | `policy.schema.json` | 🔸 選用 | 工時政策（請假時數計算）| `compute_leave_hours` 工具 |
| ⑧ | OA | `oa.schema.json` | 🔸 選用 | OA 端點 + 送出欄位映射 + 回應解析 | OA 連接器（`submitForm` / `oa.mapper`）|

> **必要 vs 選用**：loader（[`form.loader.ts`](../server/src/modules/form/form.loader.ts)）對 ①②③④⑤⑥ 直接讀檔，對 ⑦ policy、⑧ oa 用 `readJsonOptional`（不存在回 `undefined`）。雖然 ⑤⑥ 目前在 loader 是直接讀，但型別上為選用、且引擎對缺值有 fallback；實務上建議每張表單至少提供 ①②③④，⑤⑥ 視需要。
>
> 現況：三張表單皆有 ①〜⑥與 ⑧；只有 `leave-request` 額外有 ⑦ `policy.schema.json`。要真正送出至 OA 的表單才需 ⑧（領域 service 找不到 `def.oa` 會擲錯）。

---

## 一份 Definition 的組成

loader 把資料夾內各檔組成一個 `Definition` 物件（[`shared/src/index.ts`](../shared/src/index.ts)）：

```ts
interface Definition {
  formId: string;            // = 資料夾名稱
  data: DataSchema;          // ①
  field: FieldSchema;        // ②
  validation: ValidationSchema; // ③
  agent: AgentSchema;        // ④
  layout?: LayoutSchema;     // ⑤ 選用
  workflow?: WorkflowSchema; // ⑥ 選用
  policy?: PolicySchema;     // ⑦ 選用
  oa?: OASchema;             // ⑧ 選用
}
```

---

## 各層詳細規格

### ① Data — `data.schema.json`（必要）

標準 [JSON Schema draft-07](https://json-schema.org/) 子集，描述「最終送進 OA 的資料長相」。**這是與 OA 的契約**，也是 LLM `fill_fields` 工具的 input schema 來源。

**頂層欄位**

| 欄位 | 型別 | 說明 |
|------|------|------|
| `$schema` | string | 固定 `http://json-schema.org/draft-07/schema#`（選填）|
| `formId` | string | 表單 ID（建議與資料夾名相同）|
| `title` | string | 表單顯示名稱 |
| `type` | `"object"` | 固定 |
| `properties` | object | **欄位定義**，key = 機器名稱 |
| `additionalProperties` | boolean | 建議 `false`，拒絕未定義欄位 |

**每個 property 支援的關鍵字**（`JsonSchemaProperty`）

| 關鍵字 | 適用 | 說明 |
|--------|------|------|
| `type` | 全部 | `string` / `number` / `integer` / `boolean` / `array` / `object` |
| `enum` | string/number | 限定值集合 |
| `const` | 全部 | 固定值（同意欄位常用 `true`）|
| `format` | string | `date`（YYYY-MM-DD）等；由 `ajv-formats` 驗證 |
| `pattern` | string | 正則，如時間 `^\\d{2}:\\d{2}$` |
| `minLength`/`maxLength` | string | 長度限制 |
| `minimum`/`maximum` | number | 數值範圍 |
| `items` | array | 陣列元素的 schema |
| `maxItems` | array | 陣列上限 |
| `properties`/`required` | object | 巢狀物件（如附件 metadata）|
| `description` | 全部 | 欄位語意，**會餵給 LLM**，請寫清楚 |

**範例**（節錄自 `leave-request`）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "formId": "leave-request",
  "title": "請假單",
  "type": "object",
  "properties": {
    "leaveType": {
      "type": "string",
      "enum": ["annual", "personal", "sick", "official", "funeral", "marriage"],
      "description": "請假類型 / leave type"
    },
    "startDate": { "type": "string", "format": "date", "description": "開始日期 YYYY-MM-DD" },
    "startTime": { "type": "string", "pattern": "^\\d{2}:\\d{2}$", "description": "開始時間 HH:mm" }
  },
  "additionalProperties": false
}
```

> **`description` 很重要**：它同時是 LLM 抽取欄位的依據。寫得明確（含格式、單位、範例），slot-filling 命中率越高。

---

### ② Field — `field.schema.json`（必要）

把 data 的每個欄位對應到 **UI 元件 + 顯示語意**。key 必須對應 data 的欄位名稱。

**每欄支援**（`FieldSpec`）

| 屬性 | 必要 | 說明 |
|------|------|------|
| `component` | ✅ | UI 元件型別，見下表 |
| `label` | ✅ | 欄位標籤（也用於錯誤訊息）|
| `placeholder` | | 輸入提示 |
| `options` | | `Select` 用：`[{ value, label }]` |
| `help` | | 欄位下方輔助說明 |
| `links` | | 欄位旁的補充資料連結：`[{ label, url }]`。URL **僅接受 `http(s)://` 或單斜線起始的站內絕對路徑**，其餘於 `validateDefinition` 就被擋下（`javascript:`、protocol-relative `//host` 都不行）|
| `requiresTrue` | | 該欄位必須由使用者**明確勾選**才算完成：`false` 不視為已填。條款同意用 |

> ℹ️ **條款連結與明確同意**。`links` 與 `requiresTrue` 兩個屬性讓「我已閱讀並同意服務條款」這類欄位成立：
>
> - 前台 [`FormView.tsx`](../client/src/FormView.tsx) 把 `links` 渲染成可點擊連結（`target="_blank"`），未勾選則擋住送出。
> - 後端 [`form.engine.ts`](../server/src/modules/form/form.engine.ts) 對這種欄位改用「值必須是 `true`」判定是否已填——所以它同時也擋得住 Agent。
> - Agent 的欄位說明（[`form.agent-service.ts`](../server/src/modules/conversation/form.agent-service.ts)）會附上條款連結，並明文要求「必須由使用者閱讀後明確表示同意，不得自動填入 true 或從送出意圖推定同意」。
> - 兩個屬性都沒設時，[`field-links.ts`](../server/src/modules/form/field-links.ts) 會依欄位文字（含「同意 / 服務條款 / 隱私權 / 個資」且為 `Checkbox`）推定為同意欄位、並補上示範連結（`client/public/legal/` 的三份頁面）。**這是給既有表單的後備，schema 一旦寫了 `links` 就完全以 schema 為準。**
> - data schema 對應欄位建議定義成 `{ "type": "boolean", "const": true }`。

**可用 `component`（`FieldComponent`）**

| component | 前端對應元件 | 備註 |
|-----------|-------------|------|
| `Input` | 文字輸入 | |
| `Password` | 密碼輸入 | 值仍是 `string`；畫面遮蔽，送出後的唯讀摘要顯示 `••••••` |
| `Number` | 數字輸入 | |
| `Textarea` | 多行文字 | |
| `Select` | 下拉選單 | 需 `options` |
| `Radio` | 單選群組 | 需 `options`；值同 `Select`（data 建議配 `enum`） |
| `MultiSelect` | 多選標籤輸入 | 需 `options`；**值為 `string[]`**，見下方說明 |
| `DatePicker` | 日期 | 搭配 data `format: "date"` |
| `TimePicker` | 時間 | 搭配 data `pattern` HH:mm |
| `Checkbox` | 勾選 | 對應 data `boolean` |
| `Upload` | 附件上傳（`FileUploader`）| 值為 `Attachment[]`；見下方說明 |

> ℹ️ **`MultiSelect` 走 [`registry.tsx`](../client/src/form/registry.tsx) 的 `arrayFieldRegistry`**（值為 `string[]`，不走「value 一律字串」的 `fieldRegistry`）。data schema 對應欄位請定義成 `type: "array"`、`items: { "type": "string", "enum": [...] }` —— 可選值放在 `items.enum`，放頂層 `enum` 會誤擋整個陣列。必填的陣列欄位給空陣列 `[]` 視同未填（[`form.engine.ts`](../server/src/modules/form/form.engine.ts) 的 `isEmpty`）。
>
> ℹ️ **`Upload` 由 [`FormView.tsx`](../client/src/FormView.tsx) 特例渲染，不經 registry**。因其值為 `Attachment[]`（非字串）且需非同步上傳到後端，不符 registry「value 一律字串」的契約。整條鏈已接好：FormView → `@hyagent/ui` 的 `FileUploader` → client `api.uploadAttachment`/`deleteAttachment` → 後端 `POST/DELETE /conversations/:id/attachments`（multer + `attachmentStore`）→ 送出時 `attachments` metadata 隨 payload 交付 OA。data schema 對應欄位請定義成 `type: array`、`items` 為附件 metadata 物件。`leave-request` 與 `business-trip-domestic` 已示範。

**範例**

```json
{
  "leaveType": {
    "component": "Select",
    "label": "請假類型",
    "options": [
      { "value": "annual", "label": "特休" },
      { "value": "sick", "label": "病假" }
    ]
  },
  "reason": { "component": "Textarea", "label": "事由", "placeholder": "請簡述請假事由" }
}
```

---

### ③ Validation — `validation.schema.json`（必要）

定義**必填欄位**與**跨欄商業規則**。完整性（`isComplete`）由引擎依此計算，不靠 LLM 自述。

| 屬性 | 必要 | 說明 |
|------|------|------|
| `required` | ✅ | 必填欄位名稱陣列 |
| `rules` | | 跨欄商規陣列 |

**商規（`BusinessRule`，目前支援 `compareField`）**

| 屬性 | 說明 |
|------|------|
| `id` | 規則識別 |
| `type` | 固定 `"compareField"` |
| `field` | 被檢查欄位 |
| `op` | `>=` `>` `<=` `<` `==` `!=` |
| `other` | 用來比較的另一欄位 |
| `message` | 違反時的錯誤訊息 |

> 比較對 `YYYY-MM-DD` 字串與數字皆有效（字串字典序對齊日期序）。任一比較欄位為空時**不評**（屬「缺值」範疇，由 `required` 處理）。

**範例**

```json
{
  "required": ["applicant", "leaveType", "startDate", "endDate", "reason"],
  "rules": [
    {
      "id": "endAfterStart", "type": "compareField",
      "field": "endDate", "op": ">=", "other": "startDate",
      "message": "結束日期不可早於開始日期"
    }
  ]
}
```

---

### ④ Agent — `agent.schema.json`（必要）

對話蒐集策略：意圖辨識、詢問順序、每欄提示、確認話術。

| 屬性 | 必要 | 說明 |
|------|------|------|
| `intent` | ✅ | 意圖代號 |
| `description` | ✅ | 表單用途，會寫進 `fill_fields` 工具描述餵給 LLM |
| `examples` | | 使用者語句範例 |
| `keywords` | | **意圖路由**關鍵字：使用者未指定表單時，比對訊息命中數最高者勝出 |
| `askOrder` | | 詢問欄位順序；省略時用 `data.properties` 的 key 順序 |
| `fieldGuidance` | | `欄位名 → 給 LLM 的提示`（如何問、如何換算）|
| `confirmationTemplate` | | 確認摘要範本，`{欄位名}` 會被代入值 |

**範例**（節錄）

```json
{
  "intent": "leave-request",
  "description": "員工請假申請，需要申請人、假別、起訖日期時間、事由",
  "examples": ["我要請病假", "我下週一到週二要請特休"],
  "askOrder": ["applicant", "leaveType", "startDate", "startTime", "endDate", "endTime", "reason"],
  "fieldGuidance": {
    "startDate": "詢問開始日期，將相對日期（明天、下週一）換算成 YYYY-MM-DD",
    "endDate": "若只請一天，結束日期同開始日期"
  },
  "confirmationTemplate": "請確認：{leaveType}，{startDate} {startTime} 至 {endDate} {endTime}，事由：{reason}。回覆「確認」即送出。"
}
```

---

### ⑤ Layout — `layout.schema.json`（選用）

控制前端表單的**分組、顯示順序、多步驟**。沒有此檔時，前端 fallback 成扁平單頁（依 `data.properties` 順序）。

| 屬性 | 說明 |
|------|------|
| `sections` | 區塊陣列；**`sections.length > 1` 時前端自動變成多步驟（step）填寫** |
| `sections[].title` | 區塊標題（選用）|
| `sections[].fields` | `string[][]`：外層為「列」，內層為「同一列的欄位」 |

> 同一列放多個欄位（如 `["startDate", "startTime"]`）= 並排顯示。未被任何 section 涵蓋的欄位，前端會補成額外區塊（[`FormView.tsx`](../client/src/FormView.tsx)）。

**範例**

```json
{
  "sections": [
    { "title": "申請資訊", "fields": [["onBehalf"], ["applicant"], ["deputy"]] },
    {
      "title": "請假資訊",
      "fields": [["leaveType"], ["startDate", "startTime"], ["endDate", "endTime"], ["reason"]]
    }
  ]
}
```

---

### ⑥ Workflow — `workflow.schema.json`（選用）

定義簽核關卡。送出後由 [`approvals.ts`](../server/src/modules/form/approvals.ts) 依關卡與送出時間計算 `approved` / `current` / `pending`。**Demo 以時間自動推進**（每 15 秒過一關）；真串接時改由 OA 連接器查詢真實狀態。

| 屬性 | 說明 |
|------|------|
| `steps` | 關卡陣列（依序）|
| `steps[].type` | 關卡類型（如 `manager` / `hr`）|
| `steps[].name` | 關卡顯示名稱；省略時用 `type` |
| `steps[].assigneeId` | 指定簽核人（選用）|

**範例**

```json
{
  "steps": [
    { "type": "manager", "name": "主管審核" },
    { "type": "hr", "name": "人資審核" }
  ]
}
```

---

### ⑦ Policy — `policy.schema.json`（選用，僅時數計算表單）

工時政策，供 `compute_leave_hours` 工具換算請假時數（排除午休、週休、國定假日，並可依地區覆寫）。**只有定義了此檔的表單，LLM 才會多出 `compute_leave_hours` 工具。**

| 屬性 | 說明 |
|------|------|
| `default` | 找不到地區時的後備工時政策（`WorkTimePolicy`）|
| `regions` | `地區名 → WorkTimePolicy` 覆寫（如 台北 / 新竹）|
| `holidays` | 國定假日 `YYYY-MM-DD` 陣列（全地區共用，不計時數）|

**`WorkTimePolicy`**

| 屬性 | 說明 |
|------|------|
| `workDay` | `{ start, end }` 上下班時間 HH:mm |
| `lunchBreak` | `{ start, end }` 午休區間（計算時排除）|
| `weekendDays` | 週休日 `0=日…6=六`；省略預設 `[0, 6]` |

**範例**（節錄）

```json
{
  "default": { "workDay": { "start": "08:30", "end": "17:30" }, "lunchBreak": { "start": "12:00", "end": "13:00" } },
  "regions": {
    "台北": { "workDay": { "start": "09:00", "end": "18:30" }, "lunchBreak": { "start": "12:00", "end": "13:30" } }
  },
  "holidays": ["2026-01-01", "2026-02-16"]
}
```

---

### ⑧ OA — `oa.schema.json`（選用，僅需送出至 OA 的表單）

把「表單值 → 真 OA 系統」的送出**完全 schema 化**：OA 端點、送出欄位映射、回應解析全由此檔決定。由 OA 連接器（[`submitForm`](../server/src/lib/oa/types.ts)）透過純函式 mapper（[`oa.mapper.ts`](../server/src/lib/oa/oa.mapper.ts)）消費。**OA 真欄位名／狀態值改動時只改此 JSON，不動程式。**

> 領域 service（`leave` / `outing` / `business-trip`）送出前會把表單值與衍生欄位（如請假的 `hours` / `region`、所有表單的 `userId`）合成「來源」，交給 `submitForm`；缺 `oa.schema.json` 時 service 會擲錯。

| 屬性 | 必要 | 說明 |
|------|------|------|
| `endpoint` | ✅ | OA 端點路徑（接在 `OA_BASE_URL` 後）|
| `method` | | `POST`（預設）/ `PUT` |
| `request.fieldMap` | ✅ | `來源欄位 → OA body 欄位名`。**同時是 allowlist**：只有列出的欄位會送出；值為 `undefined` 不帶 |
| `request.constants` | | 固定欄位（如 `{ "FormType": "LEAVE" }`），直接併入 body |
| `response.idField` | ✅ | OA 回應的請求 id 欄位名（缺值時 fallback `id`）|
| `response.statusField` | | OA 回應的狀態欄位名；省略用 `status` |
| `response.statusMap` | | OA 狀態字串 → `accepted`/`pending`/`rejected`；未命中 fallback `pending` |

**範例**（節錄自 `leave-request`，目前為 identity 範本；OA 規格到位後改各 value 即可）

```json
{
  "endpoint": "/api/leave-requests",
  "method": "POST",
  "request": {
    "fieldMap": {
      "applicant": "applicant", "leaveType": "leaveType",
      "startDate": "startDate", "endDate": "endDate",
      "hours": "hours", "region": "region", "attachments": "attachments"
    },
    "constants": {}
  },
  "response": {
    "idField": "requestId", "statusField": "status",
    "statusMap": { "accepted": "accepted", "pending": "pending", "rejected": "rejected" }
  }
}
```

---

## 引擎如何消費這些 schema

| 程式 | 讀哪幾層 | 做什麼 |
|------|---------|--------|
| [`form.loader.ts`](../server/src/modules/form/form.loader.ts) | 全部 | 讀 `schemas/<formId>/` 組成 `Definition`（policy 為選用）|
| [`form.engine.ts`](../server/src/modules/form/form.engine.ts) | Data + Validation + Field | Ajv 欄位/整表驗證、型別 coerce、跨欄商規、`computeStatus`、`setField` |
| [`form.tools.ts`](../server/src/modules/form/form.tools.ts) | Data + Agent + Policy | 由 schema 生成 LLM 工具（見下）|
| [`approvals.ts`](../server/src/modules/form/approvals.ts) | Workflow | 計算各關卡簽核狀態 |
| [`oa.mapper.ts`](../server/src/lib/oa/oa.mapper.ts) + 連接器 `submitForm` | OA | 依 `oa` 組 OA body、解析回應（送出時）|
| [`conversation.service.ts`](../server/src/modules/conversation/conversation.service.ts) | Agent.keywords | 意圖路由：未指定表單時比對命中數選 formId |
| [`conversation.agent.ts`](../server/src/modules/conversation/conversation.agent.ts) | Agent | 用 `askOrder` / `fieldGuidance` / `confirmationTemplate` 組系統提示 |
| [`FormView.tsx`](../client/src/FormView.tsx) + [`registry.tsx`](../client/src/form/registry.tsx) | Field + Layout | 依 `field.component` 查 registry 渲染、依 layout 分組/多步驟 |

**由 schema 自動生成的 LLM 工具**（[`form.tools.ts`](../server/src/modules/form/form.tools.ts)）

| 工具 | 何時提供 |
|------|---------|
| `fill_fields` | 一律（input schema = `data.properties`）|
| `submit` | 一律（伺服器端守門，僅 `confirming` 可執行）|
| `get_leave_balances` | data 有 `leaveType` 欄位時 |
| `find_deputy_candidates` | data 有 `deputy` 欄位時 |
| `compute_leave_hours` | 有 `policy.schema.json` 時 |

> 條件式工具靠「欄位是否存在 / policy 是否存在」自動掛載，**新增表單時不必改工具生成程式**。

---

## 如何新增/設定一張表單

以新增「加班申請 `overtime`」為例：

1. **建資料夾**：`schemas/overtime/`

2. **`data.schema.json`（必要）** — 先想清楚最終要送進 OA 的欄位與型別，寫成 JSON Schema。`description` 寫清楚（會餵給 LLM）。

3. **`field.schema.json`（必要）** — 為每個 data 欄位指定 `component` 與 `label`；`Select` 記得帶 `options`。
   - 元件型別只能用 [可用 component](#-field--fieldschemajson必要) 表中的值。

4. **`validation.schema.json`（必要）** — 列出 `required`；需要跨欄檢查就加 `rules`（目前支援 `compareField`）。

5. **`agent.schema.json`（必要）** — 填 `intent` / `description` / `keywords`（意圖路由用）/ `askOrder` / `fieldGuidance` / `confirmationTemplate`。

6. **`layout.schema.json`（選用）** — 想要分組或多步驟才加；多個 section = 多步驟。

7. **`workflow.schema.json`（選用）** — 有簽核流程就定義 `steps`。

8. **`policy.schema.json`（選用）** — 只有需要「依工時政策算時數」的表單才加（會自動啟用 `compute_leave_hours` 工具）。

9. **`oa.schema.json`（選用，要真送 OA 才需）** — 定義 `endpoint` + `request.fieldMap`（來源欄位→OA 欄位）+ `response`（id/status 解析）。送出邏輯由 `submitForm` 通用處理，不必改連接器。

10. **領域 service（若要真的送出）** — 在 `server/src/modules/<form>/` 加最終驗證 → `connector.submitForm({ formId, oa: def.oa, source })` 的 service，參考既有的 `leave` / `business-trip` / `outing`。純對話/驗證不送出則可先略過 ⑨⑩。

11. **驗證**：

    ```bash
    npm run smoke       # 離線驗證 schema 引擎，不需 API key
    npm run typecheck   # 型別檢查
    ```

> **編排層（conversation / form 引擎 / 前端 FormView）完全不需改動** —— 表單行為由上述 JSON 決定。

---

## 常見問題

**Q：欄位填了卻一直被當成沒填？**
A：檢查 `validation.required` 的欄位名是否與 `data.properties` 的 key 完全一致；空字串 / null / undefined 都算未填。

**Q：LLM 抽不到某欄位？**
A：把該欄位 `data` 的 `description` 與 `agent.fieldGuidance` 寫清楚（格式、單位、相對日期換算規則）。

**Q：前端某欄位顯示成純文字框？**
A：該 `component` 未在 [`registry.tsx`](../client/src/form/registry.tsx) 註冊，fallback 成文字輸入；需自行加 adapter。（`Upload` 例外：已由 [`FormView.tsx`](../client/src/FormView.tsx) 特例渲染 `FileUploader`，不經 registry，無需另加 adapter。）

**Q：哪些檔可以省略？**
A：`layout` / `workflow` / `policy` / `oa` 為選用；`data` / `field` / `validation` / `agent` 為必要。（要真送 OA 的表單才需 `oa`。）

**Q：表單路由怎麼決定？**
A：使用者明確指定則用該 formId；否則比對各表單 `agent.keywords` 命中數，最高者勝出（見 [`conversation.service.ts`](../server/src/modules/conversation/conversation.service.ts)）。
