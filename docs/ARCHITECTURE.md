# OA Agent 平台架構

本文是**目標架構圖 + 現況對照 + 演進觸發點**的單一來源。用途：每當有人（包括未來的自己）問「要不要平台化 / 做某個平台機制」，答案是**查觸發點，而不是重新辯論**。

> 心智模型：這張圖是 roadmap，不是 sprint backlog。多數框已存在（只是名字不同），少數框綁明確觸發條件，個別框（Ranking / Community / Marketplace）在 skill 規模長大前刻意不做。

## 目標架構

```
Management Portal（admin 後台）
  AI 設定 │ Skill Library │ 權限/套餐 │ 表單 │ 知識庫 │ 用量 │ Webhook │ 稽核
        │
        ▼
──────────────── Runtime Layer ────────────────
  Conversation Manager
        ▼
  Authentication（JWT / SSO；OAuth 待接）
        ▼
  Context Builder（User / Role / History / Memory* / Tenant）
        ▼
  Intent Router（LLM_ROUTER_MODEL 分類）
        ▼
  Skill Router
    ├─ Bundle Filter（套餐 → 部門/帳號）
    ├─ Permission（scope 聯集解析）
    ├─ 意圖比對（keywords + 分類器）
    └─ Fallback（assistant）
        ▼
──────────────── Skill Layer ────────────────
  Form Skill（schema-driven 表單，多張）
  Knowledge Skill（RAG 問答）
  Agent Skill（多步驟工具代理）
  Assistant Skill（兜底/護欄，恆啟用）
  〔HR / IT / Meeting / Search / Custom … 未來插件位〕
        ▼
──────────────── Execution Layer ────────────────
  Tool Executor（toolRegistry.invoke：scope 檢查 + audit）
    ├─ API / Webhook Connector
    ├─ Form Engine（Ajv，六層 schema）
    ├─ RAG / Vector DB（檔案索引；pgvector 待遷移）
    └─ Email / OA Connector（stub / http）
```

\* Memory：跨對話的使用者記憶，尚未實作（見觸發點）。

## 現況對照

| 目標元件 | 現況對應（程式） | 狀態 |
| --- | --- | --- |
| Conversation Manager | `modules/conversation/`（session store + agent loop） | ✅ |
| Authentication | JWT login + SSO exchange（`modules/auth/`） | ✅（缺 OAuth） |
| Context Builder | resolve-tenant + user directory + session history | 🟡 缺 Memory |
| Intent Router | `conversation/intent-router.ts`（Haiku 分類器） | ✅ |
| Skill Router | `conversation/service.registry.ts`（sticky + enabledFor） | ✅ |
| Skill 契約 | `SkillDescriptor` + `registry.describe()`（`GET /api/admin/skills`） | ✅ |
| Bundle Filter | 能力套餐（`authz/scope-policy.ts` bundles + resolveScopes 展開） | ✅ |
| Permission | scope 聯集（BASE ∪ 租戶 ∪ 部門 ∪ 帳號 ∪ 套餐） | ✅ |
| Fallback | `conversation/assistant.agent-service.ts` | ✅ |
| Form Skill | `conversation/form.agent-service.ts` + `schemas/`（3 張表單） | ✅ |
| Knowledge Skill | `modules/knowledge/`（RAG 檢索 + 重排） | ✅ |
| Tool Executor | `modules/tools/`（scope 檢查 + `modules/audit/`） | ✅ |
| Dynamic Form | 六層 schema 引擎（`modules/form/`） | ✅ |
| API / Webhook | `lib/connectors/` + `modules/webhook/` | ✅ |
| RAG / Vector DB | 每租戶檔案索引；Vector DB = pgvector | 🟡 檔案索引 |
| Workflow / BPM | workflow schema（Demo 以時間推進） | 🔴 真 BPM 待接 |
| Memory | — | 🔴 未實作 |
| Management Portal | admin 後台（8 分頁 + Skill Library） | ✅ |

持久化：8 個 runtime store 皆支援 `DATA_BACKEND=db`（Prisma + Supabase Postgres），
DDL 見 `server/db/migrations/`。API key 存 sha256 雜湊、BYO key / ssoSecret 以
`DATA_ENCRYPTION_KEY` 靜態加密。詳見 [../README.md](../README.md)。

## 演進觸發點

決策原則：**換一個專案還用得到的能力 → 平台機制；只服務眼前需求 → 現在別做。**
下列每項在觸發條件出現前，一行都不寫。

| 待做 | 觸發條件 | 為何等它 |
| --- | --- | --- |
| **Skill 契約再抽象** | 加第 5 個 skill（HR / IT / Meeting…）時順手做 | 要有真實案例驗證契約設計，而非憑空預測 |
| **Role/Bundle 進階**（跨租戶預設套餐、繼承） | 有客戶要「總部定義、分公司沿用」 | 現有每租戶套餐已夠用，繼承是更大需求才划算 |
| **Memory（跨對話記憶）** | 使用者回訪率高、抱怨「每次都要重講」 | sessions 已在 DB，加 user_memory 表即延伸 |
| **Skill Ranking** | 出現「兩個 skill 搶同一意圖」的真實衝突 | 目前 keywords + 分類器足夠，ranking 是為不存在的問題買保險 |
| **Community / Marketplace** | 內建 skill 數 > 20 且有第三方供給 | 規模未到，維護成本 > 價值 |
| **真 BPM / Workflow 引擎** | 公司 OA 簽核規格到位 | 等外部規格，非工程自主 |
| **Vector DB（pgvector）** | 知識庫索引量級成長、檔案檢索變慢 | 現行檔案索引在小量下夠快 |
| **真 OA HTTP Connector** | 公司 OA 端點/欄位規格到位 | 骨架已就緒（`lib/oa/http.connector.ts`），改三個對接點即可 |
| **真實身分來源 / OAuth** | 導入正式部署、SSO 決策定案 | 目前 mock 名錄 + SSO handoff 足夠 demo |

## 不做清單（明確排除，避免反覆糾結）

- 表單**不**升格為獨立 skill——表單是 Form Skill 的 schema 資料，升格會放棄「新增表單不改程式」的核心優勢。
- Skill Layer 的能力管理**不**做動態程式碼載入——skill 以程式碼註冊、後台唯讀展示即可，動態載入是安全與維運的淨負擔。
