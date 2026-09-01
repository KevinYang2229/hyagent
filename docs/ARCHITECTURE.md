# HyAgent 平台架構

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
    ├─ RAG / Vector DB（file / pgvector 雙後端）
    └─ Email / OA Connector（stub / http）
```

\* Memory：跨對話的使用者記憶，尚未實作（見觸發點）。

## 現況對照

| 目標元件 | 現況對應（程式） | 狀態 |
| --- | --- | --- |
| Conversation Manager | `modules/conversation/`（session store + agent loop） | ✅ |
| Authentication | JWT login + SSO exchange（`modules/auth/`） | 🟡 demo 級，五項缺口見 [HANDOFF-SSO](HANDOFF-SSO.md) §4 |
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
| OA Connector | `lib/oa/`（`OA_CONNECTOR=stub \| http`；端點與欄位映射由 `schemas/<formId>/oa.schema.json` 經 `oa.mapper.ts` 驅動） | 🟡 送單已通，三處缺口見 [HANDOFF-OA-HTTP](HANDOFF-OA-HTTP.md) §5 |
| RAG / Vector DB | `DATA_BACKEND` 切換 file / pgvector；索引持久化見「知識庫檢索後端」 | ✅ |
| Workflow / BPM | workflow schema（Demo 以時間推進） | 🔴 真 BPM 待接 |
| Memory | — | 🔴 未實作 |
| Management Portal | admin 後台（8 分頁 + Skill Library） | ✅ |

持久化：10 個 runtime store 皆支援 `DATA_BACKEND=db`（Prisma + Supabase Postgres），
DDL 見 `server/db/migrations/`。API key 存 sha256 雜湊、BYO key / ssoSecret 以
`DATA_ENCRYPTION_KEY` 靜態加密。詳見 [../README.md](../README.md)。

### 知識庫檢索後端

索引持久化由 `knowledge.index.repo.ts` 收斂，依 `env.DATA_BACKEND` 分流：

| 後端 | 索引儲存 | 檢索器 | 取候選方式 |
| --- | --- | --- | --- |
| `file` | `server/data/knowledge-index.{tenantId}.json` | `retriever.staticIndex` | 全量載入記憶體，JS 算餘弦 |
| `db` | `knowledge_chunks`（`halfvec(3072)`，精確掃描） | `retriever.pgvector` | SQL `order by embedding <=> $vec limit 20` |

兩個檢索器共用 `retriever.scoring.ts` 的評分公式與保留條件，換後端不改變召回與排序。
pgvector 那路額外跑一支 lexical 分支再與 dense 候選聯集——單看語意距離
會漏掉「語意遠但精確命中產品代碼」的片段。兩路都以餘弦距離排序後截斷，
候選池的內容不依賴列的實體順序。

**沒有 ANN 索引**：0005 原本建了 `hnsw (embedding halfvec_cosine_ops)`，已於
`0006_knowledge_chunks_index.sql` 移除。pgvector 的近似索引是先掃索引再套 `WHERE`
（post-filter），而檢索熱路徑帶 `where tenant_id = $1`；預設 `hnsw.ef_search = 40` 下，
只占全表 2% 列數的小租戶平均拿不到一列，會靜默變成「查無相關資料」。
目前全表約 1.8k 列、單租戶最多 1.5k 列，精確掃描是個位數毫秒且結果完全正確。
單一租戶破十萬列時再回頭加 ANN，且必須用 per-tenant partial index 或依 `tenant_id`
分區，否則同樣的陷阱會再犯一次。

`halfvec` 而非 `vector`：`text-embedding-3-large` 為 3072 維，超過 `vector` 型別
HNSW 索引的 2000 維上限，只有 `halfvec`（上限 4000 維）建得了索引——型別保留不動，
就是為了留著未來加回 ANN 的選項。

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
| **OA 送單對接** | 公司 OA 端點/欄位規格到位 | 連接器（`lib/oa/http.connector.ts`）已完成且不該改，要改的是每張表單的 `oa.schema.json` |
| **OA 介面補完**（簽核狀態查詢／附件本體／額度端點） | 同上，且 OA 的查詢與收附件方式確認 | 這三處**填 schema 解決不了**：`OAConnector` 沒有查簽核的方法（現為本地時間推演）、`Attachment` 只有 metadata 沒有檔案、`LEAVE_BALANCE_PATH` 寫死於程式。見 [HANDOFF-OA-HTTP](HANDOFF-OA-HTTP.md) §5 |
| **真實身分來源 / OAuth** | 導入正式部署、SSO 決策定案 | 目前 mock 名錄 + SSO handoff 足夠 demo；上線前必補的五項（鎖 `algorithms`／驗 `iss`+`aud`／強制 `exp`／replay 防護／名錄回退）見 [HANDOFF-SSO](HANDOFF-SSO.md) §4 |

## 不做清單（明確排除，避免反覆糾結）

- 表單**不**升格為獨立 skill——表單是 Form Skill 的 schema 資料，升格會放棄「新增表單不改程式」的核心優勢。
- Skill Layer 的能力管理**不**做動態程式碼載入——skill 以程式碼註冊、後台唯讀展示即可，動態載入是安全與維運的淨負擔。
