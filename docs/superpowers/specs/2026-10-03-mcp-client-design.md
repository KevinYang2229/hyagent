# 後端 MCP Client：讓 Agent 呼叫自建 MCP 服務

**日期**：2026-10-03
**狀態**：設計（已逐段確認，待實作計畫）
**驅動力**：前台 app（React Native + Expo）v1 要提供「知識庫問答 + 呼叫外部服務」；外部服務由我們自建為 MCP server，部分為特定客戶專屬，讀寫皆有。

---

## 0. 這份文件是什麼

後端當 MCP client、把自建 MCP server 的工具接進既有 Tool Registry 的完整設計。範圍只含後端、`mcp/kit`、後台與 web 前台的確認卡片；**app 前台另開 spec，且動工前先重新設計畫面**。

本設計**推翻** [tool-registry 藍圖](2026-07-08-tool-registry-target-architecture-design.md) 的 D2（「非 C MCP」）與 §9 非目標「不做 MCP 式外掛」。當時理由是「單體 Node 過度工程」；現況已不同：

- 工具要由**獨立部署、可能客戶專屬**的服務提供，不再只是單體內的連接器。
- Spike 證實接入成本低：MCP 工具的 `inputSchema` 就是 JSON Schema，可直接進 `ToolDef`，`runToolLoop` 與 Agent 服務零修改即可呼叫（見 §1）。
- D2 的「工具即一等公民」不變——MCP 只是 `ToolDef` 的另一種來源，連接器仍是工具的內部依賴。

---

## 1. Spike 結論（2026-10-02，分支 `spike/mcp-tool-call`，不合併）

最小 MCP server（Streamable HTTP、唯讀工具 `rooms_availability`）＋ 後端以 `@modelcontextprotocol/sdk` 連線、`listTools` 後逐一 `registerTool`，再以真 LLM 跑 `runToolLoop`：

| 驗證項目 | 結果 |
|---|---|
| `listTools` → `registerTool` → `availableFor` | ✅ |
| LLM 自選 MCP 工具、相對日期換算 | ✅（Claude Sonnet 4.5、gpt-4o-mini 皆會呼叫） |
| `toolRegistry.invoke`（scope + Ajv）→ `callTool` | ✅ |
| 身分經 `_meta` 抵達 MCP server | ✅（但明文可偽造 → 本設計改用 JWT，§5） |
| 無 token 呼叫 MCP server | ✅ 401 |
| 結果轉述正確性 | Claude 兩題皆對；**gpt-4o-mini 誤讀結果**（把只有 13:00 空檔答成早上有空） |

推論：串接機制沒有架構障礙；答案品質取決於模型與工具回傳設計。Agent 維持 Sonnet 等級模型；自建工具的回傳應直接回答問題（例如「該時段是否有空」），而非丟整張表讓模型推。

---

## 2. 決策紀錄（brainstorming 已確認）

| # | 決策 | 選定 |
|---|---|---|
| M1 | 誰連 MCP | **後端當 MCP client**，工具註冊進 Tool Registry（非由 LLM 廠商直連、非 app 直連） |
| M2 | 登記與歸屬 | **平台管理員於後台登記**；每個 server 有「擁有租戶」欄：空＝共用，有值＝該租戶專屬 |
| M3 | 授權 | 每 server 一個 scope `mcp:<serverId>`，沿用現有租戶／部門／帳號／套餐授權 |
| M4 | 讀寫 | **讀寫皆支援**；寫入一律「AI 提議 → 使用者確認 → 後端執行」，AI 永遠不直接執行寫入 |
| M5 | 確認方式 | **結構化確認卡片 + 按鈕**（專屬端點，不經 LLM）；打字「確認」為備援 |
| M6 | 服務歸屬 | **全部併入既有「智慧代理」服務**（非每 server 一個 AgentService） |
| M7 | 身分傳遞 | **後端每次呼叫簽發短效 ES256 JWT**，MCP 端以 JWKS 驗章；資料模型預留每使用者 OAuth |
| M8 | 傳輸 | Streamable HTTP（MCP server 獨立部署，非 stdio） |

---

## 3. 架構

```
使用者訊息
  → intent-router（關鍵字 / Haiku 分類；agent.intents() 帶入 MCP 描述與關鍵字）
  → agentAgentService
      tools = toolRegistry.availableFor(ctx)
                ├ 靜態工具（oa.* / email.*）
                └ 動態來源：mcpToolSource.toolsFor(ctx)   ← 依租戶歸屬 + scope 過濾
  → runToolLoop
      讀取工具：toolRegistry.invoke → mcpConnection.callTool（帶 JWT）→ MCP server
      寫入工具：驗權限 + Ajv → 存 session.pendingAction → 回 LLM「已提議」
  → TurnResult { reply, pendingAction? }  → 前台畫確認卡片
  → POST /conversations/:id/actions/:actionId/confirm
      → 重檢權限 → toolRegistry.invoke → MCP server → 稽核 → 回結果
```

---

## 4. 元件

### 4.1 新模組 `server/src/modules/mcp/`

| 檔案 | 職責 |
|---|---|
| `mcp.types.ts` | `McpServerConfig`、`McpToolOverride`、連線狀態型別 |
| `mcp.store.ts` | 登記資料存取；照 [webhook.store.ts](../../../server/src/modules/webhook/webhook.store.ts) 的「記憶體 Map + file/db 雙後端 + 整包 jsonb」。新增 Prisma 模型 `McpServerRow` |
| `mcp.identity.ts` | 簽發呼叫 JWT（ES256）；提供 JWKS 端點 |
| `mcp.connection.ts` | 每 server 一條連線：延遲建立、退避重連、逾時、`listTools` 快取 |
| `mcp.tool-source.ts` | MCP 工具 → `ToolDef`；讀寫判定、命名、撞名檢查 |
| `mcp.admin.controller.ts` / `mcp.admin.routes.ts` | 後台 API（`requireAdmin`）：CRUD、測試連線、重新整理工具 |

`McpServerConfig`：

```ts
interface McpServerConfig {
  id: string;                    // serverId：/^[a-z0-9-]{1,32}$/，不可含 _ 或 .
  name: string;
  url: string;                   // Streamable HTTP 端點
  ownerTenantId: string | null;  // null＝共用；有值＝專屬
  description: string;           // 能力描述：進 agent.intents() 與系統提示詞
  keywords: string[];            // 路由關鍵字（0-token 命中 agent）
  timeoutMs: number;             // callTool 逾時，預設 20000
  enabled: boolean;
  toolOverrides: Record<string, McpToolOverride>;
  auth: { mode: 'hyagent-jwt' }; // 預留 'user-oauth'（非 v1）
  createdAt: string;
  updatedAt?: string;
}

interface McpToolOverride {
  disabled?: boolean;
  requireConfirm?: boolean;      // 強制視為寫入
  cardTitle?: string;            // 確認卡片標題
}
```

### 4.2 既有程式修改

| 位置 | 修改 |
|---|---|
| [tool.registry.ts](../../../server/src/modules/tools/tool.registry.ts) | 新增 `registerToolSource(source)`：動態來源提供 `toolsFor(ctx)` 與 `resolve(id, ctx)`。`availableFor` / `invoke` 合併靜態表與來源；靜態工具行為不變 |
| [tool.types.ts](../../../server/src/modules/tools/tool.types.ts) | `ToolDef` 新增 `effect: 'read' \| 'write'`（靜態工具補標）與選用 `confirmCard(input)` |
| [agent.agent-service.ts](../../../server/src/modules/conversation/agent.agent-service.ts) | `intents()` 合併該租戶可用 MCP 的描述與關鍵字；系統提示詞加「寫入工具只能提議」；`dispatchTool` 依 `effect` 分流；移除 email 專用確認閘 |
| [conversation.types.ts](../../../server/src/modules/conversation/conversation.types.ts) | `pendingEmail` → `pendingAction`；`TurnResult` 加 `pendingAction?` |
| conversation routes / controller | 新增 confirm / cancel 端點 |
| [email.tools.ts](../../../server/src/modules/tools/email.tools.ts) | `email.propose` 移除；`email.send` 標 `effect: 'write'`、`agentExposed: true`，由通用確認機制把關 |
| [scope-catalog.ts](../../../server/src/modules/authz/scope-catalog.ts) | scope 目錄改為「靜態 + 已登記 MCP server」；專屬 server 只對其租戶列出 |

### 4.3 `mcp/kit/`（新 workspace）

- `verifyHyAgentRequest()`：Express middleware，抓 JWKS（快取 + `kid` 未命中時重抓）、驗簽章／`aud`／`exp`、選用 `jti` 防重送，驗完以 `{ tenantId, userId, scopes }` 提供給工具 handler。
- `examples/rooms/`：由 spike 改寫的範例 server，一讀（查空檔）一寫（預約），示範欄位 `title` 規範與「直接回答問題」的回傳設計。
- README：自建 MCP 的規範（欄位必寫 `title`、讀工具標 `readOnlyHint: true`、寫工具標 `destructiveHint`）。

---

## 5. 身分 JWT

- **金鑰**：平台 ES256 私鑰存環境變數 `MCP_SIGNING_KEY`（PEM，僅存在部署平台設定）。JWKS 端點 `GET /.well-known/hyagent-mcp-jwks.json` 可列多把公鑰（`kid`），換鑰時新舊並存。簽章重用 [lib/assertion/](../../../server/src/lib/assertion/) 的 JOSE 工具（ES256 需 `ieee-p1363`）。
- **Claims**：

  | claim | 值 |
  |---|---|
  | `iss` | `hyagent` |
  | `aud` | `<serverId>` |
  | `sub` | `<userId>`；系統呼叫（`listTools`）為 `hyagent-system` |
  | `tenant` | `<tenantId>` |
  | `scopes` | 僅與該 server 相關者 |
  | `iat` / `exp` | 60 秒 |
  | `jti` | 隨機 ID |

- **每請求簽新 token**：連線跨使用者共用，身分在請求而非連線上。以 `AsyncLocalStorage` 把當次 `ToolContext` 帶進 transport 的自訂 `fetch`，由它依當下使用者簽 token 填 `Authorization: Bearer`。
- 未設 `MCP_SIGNING_KEY` 時：MCP 功能整體停用（不登記工具、後台顯示原因），不得退回無簽章模式。

---

## 6. 連線管理

- 每 server 一條連線，第一次需要時建立，跨租戶共用。
- `listTools` 快取 10 分鐘；後台「重新整理」或重連成功後立即更新。
- 逾時：`callTool` 預設 20 秒（每 server 可調）、`listTools` 10 秒。
- 故障：連不上的 server，其工具暫不出現在 `toolsFor`；指數退避重連（上限 5 分鐘）；狀態（`ok` / `unreachable` / `auth_failed`、最後錯誤、最後成功時間）供後台顯示。
- 結果：優先 `structuredContent`，否則串接 text content；超過 16KB 截斷並註明。

### 命名

- 工具 id：`mcp.<serverId>.<toolName>`；給 LLM 的名稱：`mcp_<serverId>_<toolName>`。
- 因 `serverId` 不含 `_`，`mcp_<serverId>_` 前綴可唯一切分。
- LLM 名稱超過 64 字元、不符 `^[a-zA-Z0-9_-]+$`、或撞名時：該工具不暴露、記錄警告、後台標紅。

### 讀寫判定

| 條件 | effect |
|---|---|
| 覆寫 `requireConfirm: true` | write |
| `annotations.readOnlyHint === true` | read |
| 其他（含未標註） | write（安全預設） |

覆寫 `disabled: true` 的工具不暴露。

---

## 7. 寫入確認流程

```ts
pendingAction?: {
  id: string;                 // 隨機；確認時必帶
  toolId: string;
  input: unknown;             // 已通過 Ajv，確認後原封執行
  summary: { title: string; fields: { label: string; value: string }[] };
  expiresAt: string;          // 10 分鐘
}
```

1. LLM 呼叫 `effect: 'write'` 的工具 → `dispatchTool` **不執行**：先跑 scope 與 Ajv，通過則存 `pendingAction`，回 LLM「已提議；請說明內容並等待使用者確認，不得宣稱已完成」。驗證失敗照常回錯誤讓 LLM 修正。
2. `TurnResult.pendingAction` 只帶 `{ id, summary, expiresAt }`，不帶 `input` 原文。
3. 卡片摘要：欄位標籤取 `inputSchema.properties[k].title ?? description ?? k`，值依型別格式化；標題取覆寫 `cardTitle` ?? 工具 `title` ?? 描述。
4. `POST /conversations/:id/actions/:actionId/confirm`：比對 id、檢查過期、**重新 `resolveScopes`**，由後端 `toolRegistry.invoke`（稽核開啟），回 `{ ok, result | error }`，並把結果以 assistant 訊息附入逐字稿，讓後續對話有上下文。
5. `POST /conversations/:id/actions/:actionId/cancel`：清除並附入「使用者已取消」。
6. 打字備援：沿用現行確認詞判斷（整句即確認、取消詞優先），僅在有未過期 `pendingAction` 時執行。
7. 失效：同時只存一筆；新提議、非確認的下一輪、過期皆使舊筆失效。
8. 舊前台：看不到卡片，但 LLM 文字仍請使用者打「確認」，功能可用。

---

## 8. 後台與前台

### 後台（admin）

- 平台層新頁「MCP 服務」（與租戶列表同層）：列表（名稱、`serverId`、共用／專屬租戶、狀態、工具數）、登記／編輯、測試連線、工具清單（讀寫判定、停用／強制確認／卡片標題覆寫、衝突標紅）。
- 租戶權限分頁：`mcp:<serverId>` 自動出現；專屬 server 只在其租戶出現。

### Web 前台（client）

- `pendingAction` 出現時畫確認卡片（標題、欄位、確認／取消），按下後顯示結果或失敗原因；過期顯示「已失效，請重新提出」。

---

## 9. 錯誤處理

| 狀況 | 行為 |
|---|---|
| MCP 連不上／逾時 | 回 LLM 錯誤（「XX 服務暫時無法使用」）讓它如實轉述；本輪不中斷 |
| 工具回 `isError` | 錯誤內容交 LLM 轉述 |
| 確認時過期／id 不符 | 409，不執行 |
| 確認時權限已撤銷 | 403，不執行 |
| 確認後執行失敗 | 稽核記失敗、卡片顯示錯誤，可重新提議 |
| MCP 端 JWT 驗證失敗 | kit 回 401；後端記警告、狀態標 `auth_failed` |
| 未設 `MCP_SIGNING_KEY` | MCP 功能整體停用並於後台說明 |

---

## 10. 測試

- **單元**：tool-source 轉換與讀寫判定、命名／撞名、JWT claims 與 `aud`、`pendingAction` 效期與失效規則、確認端點權限重檢、專屬 server 的租戶隔離（他租戶 `toolsFor` 與 scope 目錄皆看不到）。
- **整合**：測試中啟動 `mcp/kit` 範例 server，以假 LLM provider（固定回指定 `tool_use`）跑「讀取 → 回答」與「寫入 → 卡片 → 確認 → 執行」兩條完整路徑；kit 端驗 JWT 實際通過。
- **回歸**：既有 email 確認相關測試改寫後全綠；靜態工具 `availableFor` 結果不變。

---

## 11. 範圍

**v1 包含**：§4 後端模組與修改、`mcp/kit` 與範例 server、後台 MCP 頁、web 確認卡片、email 遷移至通用確認、[INTEGRATION.md](../../../INTEGRATION.md) 新增「自建 MCP」章節、在 tool-registry 藍圖註記 D2／§9 已被本文件取代。

**非目標**：

- 租戶自行登記 MCP（需 SSRF 防護與租戶管理員角色）。
- 每使用者 OAuth（M7 預留 `auth.mode`）。
- MCP resources / prompts（只做 tools）。
- 串流回應。
- App 前台（另開 spec，先重新設計畫面）。

---

## 12. 風險

| 風險 | 緩解 |
|---|---|
| email 遷移動到既有寄信流程 | 先把現行 email 確認行為寫成測試再遷移 |
| 路由把 MCP 問句誤派到知識庫或表單 | 後台關鍵字 0-token 命中；分類器目錄帶入描述；以實際問句做路由評估 |
| 模型誤讀工具結果（spike 已見） | Agent 用 Sonnet 等級；kit 規範回傳直接回答問題 |
| MCP server 慢拖垮整輪 | 每 server 逾時、故障熔斷不暴露工具 |
| 多副本部署時連線與快取各自一份 | 連線與快取本就是每程序狀態，無正確性問題；登記資料走 store（db 模式共用） |
