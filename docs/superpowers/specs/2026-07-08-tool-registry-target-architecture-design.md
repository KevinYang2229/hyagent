# 目標架構藍圖：Tool Registry × 四服務 × 多連接器

**日期**：2026-07-08
**狀態**：設計（藍圖，尚未落地）
**後續**：D2「非 C MCP」與 §9「不做 MCP 式外掛」已由 [2026-10-03 後端 MCP Client 設計](2026-10-03-mcp-client-design.md) 取代（MCP 作為 ToolDef 的動態來源，工具即一等公民不變）。
**驅動力**：先畫完整目標藍圖，之後分階段實作。

---

## 0. 這份文件是什麼

把現況演進到下列目標架構的完整設計。**本文件是藍圖，不是本次要一次做完的工單**；實作依 §7 演進路線分階段進行，每階段各自 spec → plan → 實作。

目標架構（使用者最初手繪）：

```
Chat UI → Conversation Manager → Intent Router
    → (Knowledge / Form / Workflow / Agent)
        → Tool Registry
            → (ERP API / OA API / Calendar / Email)
```

---

## 1. 現況 vs 目標（落差盤點）

| 節點 | 現況 | 目標動作 |
|---|---|---|
| Chat UI | ✅ client / widget / SDK / admin | 不變 |
| Conversation Manager | ✅ `conversation.service` + store（記憶體 session） | 不變 |
| Intent Router | ✅ `intent-router.ts`（關鍵字→sticky→Haiku 分類器） | 分流目標從 3→4 個服務 |
| Form | ✅ `formAgentService`（sticky） | 送出改走 Tool Registry |
| Knowledge | ✅ `knowledgeAgentService`（旁路） | 幾乎不變；選用可呼工具 |
| Assistant/守門 | ✅ `assistantAgentService`（旁路） | 不變（不在原圖，但保留） |
| **Workflow** | ❌ 僅 Form 送出後的 `approvals.ts` schema 層 | **獨立成服務** |
| **Agent** | ❌ 無 | **新增**（平行第四服務） |
| **Tool Registry** | ❌ 無統一層；只有 `form-submit.registry` + `OAConnector` | **新增共用層** |
| OA 連接器 | ✅ `lib/oa`（stub/http） | 收編為工具的內部依賴 |
| ERP / Calendar / Email | ❌ 不存在 | **保留 seam**，各自補 adapter |

> 圖上四個連接器：**OA 已實作（實線）**；ERP / Calendar / Email 為預留擴充點（虛線 seam），照同一工具契約未來各補一個 adapter。

**本質**：這是**重構＋擴充**，不是重寫。已有三個對的接縫——`AgentService`（可插拔服務）、`OAConnector`（連接器抽象）、`form-submit.registry`（查表送出）——目標是把後兩者上提成一層通用 Tool Registry，再補 Workflow / Agent。

---

## 2. 決策紀錄（brainstorming 已確認）

| # | 決策 | 選定 |
|---|---|---|
| D1 | Tool Registry 歸屬 | **全層共用**：Form / Workflow / Agent 都從同一 Registry 取工具 |
| D2 | Tool Registry 設計 | **A：工具即一等公民**（`ToolDef`）；連接器退為工具內部依賴（非 B 連接器目錄、非 C MCP） |
| D3 | Agent 定位 | **平行的第四服務**（非上層總控編排器） |
| D4 | Agent 黏性 | `sticky: true`（多步驟任務需保護） |
| D5 | 連接器優先序 | OA(已有) → Email → ERP → Calendar |
| D6 | 權限 by group/account | **寫進藍圖，實作晚做**：以 scope 為基的 RBAC，seam 現在留，第一版全通過 |

---

## 3. 目標分層架構

```
┌──────────────────────────────────────────────────────────┐
│ Chat UI        client / widget / SDK / admin              │
└───────────────┬──────────────────────────────────────────┘
                │ HTTP (REST)
┌───────────────▼──────────────────────────────────────────┐
│ Conversation Manager   session / status 機 / 逐輪編排      │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│ Intent Router   關鍵字 → sticky 點黏 → Haiku 分類器        │
└──┬──────────┬───────────┬───────────────┬─────────────────┘
   ▼          ▼           ▼               ▼
┌──────┐ ┌─────────┐ ┌──────────┐ ┌──────────────────┐
│ Form │ │Knowledge│ │ Workflow │ │ Agent            │   4 個平行 AgentService
│sticky│ │ bypass  │ │  bypass  │ │ sticky·跨工具    │
│ ✅   │ │  ✅     │ │  ❌ 新   │ │  ❌ 新           │
└──┬───┘ └────┬────┘ └────┬─────┘ └────────┬─────────┘
   │          │(內部檢索) │                │
   └──────────┴───────────┴────────────────┘
                     │  都透過同一層（碰外部系統的動作）
┌────────────────────▼─────────────────────────────────────┐
│ Tool Registry   ToolDef { id, description, inputSchema,   │
│                 scopes, handler }                         │
│                 invoke() = 驗證 → 檢查 scope → 記帳 → 執行 │
└──┬──────────┬───────────┬───────────────┬─────────────────┘
   ▼          ▼           ▼               ▼
┌──────┐ ┌ ─ ─ ┐ ┌ ─ ─ ─ ─ ┐ ┌ ─ ─ ─ ─ ─ ─ ┐
│ OA   │  ERP    │ Calendar │  Email/寄信    │   Connector adapters
│stub/ │ │     │ │ (OAuth) │ │ (SMTP/API)   │   實線=已實作 虛線=seam
│http✅│  seam   │  seam    │  seam         │
└──────┘ └ ─ ─ ┘ └ ─ ─ ─ ─ ┘ └ ─ ─ ─ ─ ─ ─ ┘
```

**要點**
- Intent Router / Conversation Manager 不變，只是分流目標 3→4。
- **Tool Registry 是唯一碰外部系統的出口**：權限（scope）、用量計費、稽核集中此層攔一次。
- 連接器從 1（OA）成長到 4，**上層服務碼不因新增連接器而改**——只在 Registry 註冊新工具。
- Knowledge 的檢索走內部向量索引，不算外部工具；但保留它需要時也能呼工具的能力。
- 圖上畫 4 個服務（對應原手繪藍圖）；實際另有既有的 **Assistant/守門** 服務（`sticky:false` 旁路，處理打招呼/離題），沿用不變，未於圖中重畫。

---

## 4. Tool Registry 契約

### 4.1 ToolDef（工具即一等公民）

```ts
// server/src/modules/tools/tool.types.ts
export interface ToolContext {
  tenantId: string;
  userId: string;
  locale?: string;
  scopes: string[];          // resolveScopes(ctx) 的結果
}

export interface ToolDef<I = unknown, O = unknown> {
  readonly id: string;              // 'oa.submitForm' / 'calendar.findFreeSlots' / 'email.send'
  readonly description: string;     // 給 Agent 的 LLM 分類/挑選用
  readonly inputSchema: object;     // JSON Schema：一物二用（LLM tool schema + 執行前 Ajv 驗證）
  readonly scopes: string[];        // 需具備的權限，如 ['oa:write']
  handler(input: I, ctx: ToolContext): Promise<O>;   // 內部才 getConnector(...)
}
```

- `inputSchema` 一物二用：Agent 讓 LLM 選工具時當 tool schema；任何服務呼叫前先用它驗證（重用 `form.engine` 的 Ajv）。
- `scopes` = 未來 by group/account 權限的落腳點。
- `handler` 內部才 `getConnector('oa')`——**工具是連接器的消費者**，服務不再直接碰連接器。

### 4.2 Registry（與 service.registry 同構）

```ts
// server/src/modules/tools/tool.registry.ts
export function registerTool(t: ToolDef): void;

export const toolRegistry = {
  get(id: string): ToolDef;                              // 找不到 throw
  availableFor(ctx: ToolContext): LLMTool[];             // Agent 用：scope 允許+租戶未停用 → 轉 LLMTool[]
  invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown>;  // 唯一執行入口
};
```

`invoke()` 是唯一執行入口——scope 檢查、Ajv 驗證、usage 記錄、`AppError` 錯誤包裝都在此發生一次。Agent 走 `availableFor`+`invoke`；Form/Workflow 直接 `invoke('oa.submitForm', …)`。

### 4.3 界線：哪些工具進 Registry

- **進 Registry**：只有「碰外部系統」的動作（送單、查額度、查簽核、寄信、查/建行事曆、查 ERP）。
- **不進 Registry**：對話控制類工具（如 Form 的 slot-filling `form.tools`，只改 session 值）留在各服務自己手上。

---

## 5. 現有兩塊怎麼併（重構，非重寫）

### 5.1 OAConnector → 留著，降級為工具的內部依賴

`OAConnector`（`submitForm` / `getLeaveBalance`）**完全不動**，`OA_CONNECTOR=stub|http` 切換照舊。改變的是「誰呼叫它」：包成兩個工具。

```
oa.submitForm      handler → getConnector('oa').submitForm(input)
oa.getLeaveBalance handler → getConnector('oa').getLeaveBalance(userId)
```

### 5.2 form-submit.registry → 保留分派，送出改走工具

`form-submit.registry` 的查表分派（哪張表用專屬 service、其餘走通用送出）留著。只改最裡面碰 OA 那一行：

```ts
// 現在
const result = await getOAConnector().submitForm({ formId, oa: def.oa, source });
// 目標
const result = await toolRegistry.invoke('oa.submitForm', { formId, oa: def.oa, source }, ctx);
```

差別只有一行方向，意義是：**送出從 Form 專屬變成任何服務都能用的共用工具**（Agent 之後要送單呼同一個即可）。

### 5.3 安全性

- 向後相容：`invoke('oa.submitForm')` 底層還是同一 `OAConnector`，stub 行為不變，現有測試應全綠。
- 零新連接器也有價值：光把 OA 收編，就把「權限/稽核/計費集中一層」「Agent 可複用送出」先立起來。

---

## 6. 四服務如何消費 Tool Registry

| 服務 | 消費模式 | sticky | 外部工具 |
|---|---|---|---|
| **Form** | 指名 `invoke` | `true` | `oa.submitForm`、`oa.getLeaveBalance` |
| **Knowledge** | 內部檢索（選用 `invoke`） | `false` | 選用：`oa.getLeaveBalance` |
| **Workflow** | 指名 `invoke` | `false` | `oa.getApprovalStatus`、`oa.listMyRequests`、`email.send`/`oa.remind` |
| **Agent** | LLM 自選（`availableFor`+`invoke`） | `true` | 全部可用工具（依 scope） |

### 6.1 Form（改動最小）
`slot-filling → 驗證 → 摘要確認 → 送出`。唯一改動：送出改 `toolRegistry.invoke('oa.submitForm', …)`。欄位補齊工具是對話內工具，留在 Form 內。

### 6.2 Knowledge（幾乎不變）
檢索走內部向量索引，不是外部工具。保留「未來需即時查外部時也能 `invoke`」的能力（選用）。`sticky:false`。

### 6.3 Workflow（新服務）
把現藏在 Form 送出後的 `approvals.ts`「簽核關卡」獨立成可對話查詢/操作的服務：查簽核進度、列我的申請、催辦。`sticky:false`（旁路）。真串接後 `computeApprovals` 的計時器模擬改由 `oa.getApprovalStatus` 查真實狀態。

### 6.4 Agent（Tool Registry 的主客戶）
處理「一句話跨多工具、多步驟」的開放任務。**重用 `tool-loop.ts`**，工具來源換成 Tool Registry：

```ts
const tools = toolRegistry.availableFor(ctx);      // 依 scope 過濾
runToolLoop(llm, session, {
  system: Agent 守則,
  tools,
  dispatchTool: (name, input) => toolRegistry.invoke(name, input, ctx),
});
```

`sticky:true`。唯一走 `availableFor`（LLM 自選）的服務；MAX_ITERATIONS 等既有防護沿用。

---

## 7. 連接器層 + 認證 + 權限（RBAC）

### 7.1 連接器登記（泛化 getOAConnector）

```ts
// server/src/lib/connectors/index.ts
export function getConnector(name: 'oa' | 'erp' | 'calendar' | 'email'): Connector;
```

每連接器用環境變數選 stub/真實作，boot 時 fail-fast：

```
OA_CONNECTOR=stub|http           ✅ 已有
EMAIL_CONNECTOR=stub|smtp        seam
ERP_CONNECTOR=stub|http          seam
CALENDAR_CONNECTOR=stub|google   seam
```

新增連接器的固定三步（上層零改動）：
1. 寫 `lib/<sys>/<sys>.connector.ts`（stub + 真實作：認證/HTTP/三對接點：端點路徑、request 映射、response 映射）
2. 寫 `modules/tools/<sys>.tools.ts`（把 connector 方法包成工具、標 scope）
3. `registerTool(...)`

### 7.2 兩種認證型態

| 型態 | 系統 | 憑證存放 |
|---|---|---|
| 系統對系統 | OA、ERP、Email(SMTP) | 環境變數 / 每租戶 secret；`ctx.tenantId` 決定用哪把 |
| 使用者 OAuth | Calendar (Google/M365) | 每 `userId` 一組 token，存 DB（`user_oauth_tokens`）——Calendar 前置依賴 |

### 7.3 權限（scope）解析鏈 —— RBAC

```ts
// server/src/modules/authz/resolve-scopes.ts
export function resolveScopes(ctx: { tenantId; userId }): string[] {
  const tenantScopes  = tenantStore.getTenant(tenantId)?.grantedScopes ?? [];  // 租戶買了哪些能力
  const { department } = getApplicant(userId);                                 // 已有資料
  const groupScopes   = groupPolicy[department] ?? [];                          // by group
  const accountScopes = accountPolicy[userId] ?? [];                           // by account 例外
  return unique([...tenantScopes, ...groupScopes, ...accountScopes]);
}
```

- 資料源多為現成：`department`/`title` 來自 `user.directory.ts`（接真 HR 換這層），`tenantId` 來自 middleware。
- **唯一要新增**：`groupPolicy` / `accountPolicy` 兩張對照表（初期記憶體常數/JSON，之後 Prisma）。
- **檢查點只有一個**：`toolRegistry.invoke()` 開頭比對 `resolveScopes(ctx) ⊇ tool.scopes`，不足 `AppError.forbidden`。服務層不寫權限碼。

三種粒度疊加、同一機制：

| 粒度 | 對象 | 例子 |
|---|---|---|
| 租戶 | tenantId | 未買 Calendar → 全租戶拿不到 `calendar:*` |
| 群組 | department / title | 只有人資部能 `erp.hr.*`；經理以上能核 |
| 帳號 | userId | 例外授權 kevin 用某敏感工具 |

### 7.4 第一版全通過的降級
`resolveScopes` 第一版回 wildcard（或工具 `scopes` 皆空＝不需權限）＝現況行為。接第二個連接器時把 `groupPolicy` 填實、工具標 scope，**權限從「全通過」平滑收緊，上層零改動**。

---

## 8. 演進路線

原則：每階段可獨立上線、都有可驗證價值；順序依改動小→大、依賴淺→深。

```
Phase 0 (Tool Registry + OA收編)  ──┬──> Phase 1 (Agent)
                                    ├──> Phase 2 (Email + Workflow + 權限收緊)
                                    │        └──> Phase 3 (ERP)
                                    └──> Phase 4 (Calendar, 需 OAuth 基礎設施)
```

### Phase 0 — Tool Registry 地基（零新連接器，純重構）
- 新增 `modules/tools/`、`lib/connectors/index.ts`
- OA 包成 `oa.submitForm` / `oa.getLeaveBalance`
- Form 送出改 `toolRegistry.invoke`（form-submit.registry 只改一行）
- `ToolContext` + `resolveScopes`（**全通過**）+ `invoke` 檢查點骨架
- ✅ 驗收：現有測試全綠、demo 行為不變、送出改道成功

### Phase 1 — Agent 服務（用既有工具）
- `agent.agent-service.ts`（`sticky:true`），重用 `tool-loop.ts`，工具來源 `availableFor`
- Intent Router 分流目標加到 4
- ✅ 驗收：「查我剩幾天特休→請一天」跨步驟可跑（仍在 OA 工具內）

### Phase 2 — Email 連接器（第一個真新系統）
- `lib/email/`（stub+smtp）、`email.send`（scope `email:write`）
- **權限開始收緊**：填 `groupPolicy`，`email:write` 真的被擋
- Workflow 服務登場（`sticky:false`）：`oa.getApprovalStatus` + `email.send` 做查簽核/催辦
- ✅ 驗收：非授權部門呼 `email.send` 被 `forbidden`；授權者能寄

### Phase 3 — ERP 連接器
- `lib/erp/` + `erp.*` 工具（`erp.getInventory`、`erp.getHrInfo`…），細分 read/write scope
- ✅ 驗收：Agent 單一任務混用 OA + ERP + Email

### Phase 4 — Calendar 連接器（最後，需每使用者 OAuth）
- `user_oauth_tokens` 持久化、OAuth 授權流程、`lib/calendar/`（google/m365）
- `calendar.findFreeSlots` / `calendar.createEvent`
- ✅ 驗收：「查下週二有空就約會並寄邀請」端到端

### 橫向基礎設施（綁對應 Phase）
- Session/資料持久化（現記憶體）→ 綁 Phase 2（權限表、webhook 一起上 Prisma）
- OAuth token 儲存 → 綁 Phase 4
- 工具呼叫稽核/計費（`invoke` 內）→ Phase 0 留鉤子，Phase 2 補實

---

## 9. 非目標（YAGNI）

- **不做 MCP 式外掛**（C 方案）：現階段單體 Node 過度工程。
- **不做上層總控 Agent 編排器**（D3 已否決）：維持 Intent Router + sticky 的省 token 設計。
- **不在 Phase 0 接任何新連接器**：純重構先確保零行為變化。
- **不在藍圖階段實作權限授權表**：只留 seam，第一版全通過。

---

## 10. 風險與緩解

| 風險 | 緩解 |
|---|---|
| 重構 OA 送出路徑動到既有流程 | Phase 0 純重構、底層仍同一 OAConnector、以現有測試把關全綠 |
| Agent 多步驟工具呼叫失控/爆 token | 沿用 tool-loop 的 MAX_ITERATIONS；`availableFor` 依 scope 縮小工具面 |
| 權限「全通過」被忘記收緊 | 綁進 Phase 2 驗收條件（非授權被 forbidden 為驗收項） |
| Calendar OAuth 複雜度拖累整體 | 排最後（Phase 4），與其他連接器解耦，不阻塞 Email/ERP |
| in-memory store 上線即失 | 橫向基礎設施明列，綁 Phase 2 上 Prisma |
