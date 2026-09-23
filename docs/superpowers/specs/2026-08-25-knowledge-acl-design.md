# 設計：知識庫 · 角色型資料存取權限（ACL）

日期：2026-08-25
狀態：設計待確認

## Context（為什麼做）

知識庫目前只有一道權限閘：`service:knowledge` 這個 scope 決定**能不能用問答服務**，
不決定**能問到什麼**。授權之後，該租戶所有已索引的內容對所有人一律可見。

檢索端的隔離也只到租戶層。[`retriever.pgvector.ts`](../../../server/src/modules/knowledge/retriever.pgvector.ts)
的兩路候選查詢，where 條件都只有 `tenant_id = ?`；`knowledge_chunks` 的欄位是
`tenant_id, id, url, title, text, file_id, embedding`，沒有任何可見性維度。

這使知識庫無法承載有分級需求的內容——薪酬辦法、人事評核、財務數字、法務合約。
實務上這類文件只能被排除在知識庫之外，而它們恰好是問答價值最高的一批。

本設計新增**檔案層級的可見性標籤**，並把使用者身分下推到向量檢索的 SQL，
讓「誰可以查什麼」成為檢索條件的一部分。

### 現有的可利用資產

不需要新建權限體系，專案已有完整的一半：

- [`resolve-scopes.ts`](../../../server/src/modules/authz/resolve-scopes.ts) 把
  「BASE ∪ 租戶 ∪ 部門 ∪ 帳號 ∪ 套餐」聯集成有效 scope，**每次呼叫即時重算**
  （五個呼叫點全數確認無快取、未烤進 token）。改權限下一回合即生效。
- [`scope-policy.ts`](../../../server/src/modules/authz/scope-policy.ts) 已提供部門 / 帳號 / 套餐
  三層指派，含後台 UI。
- [`scope-catalog.ts`](../../../server/src/modules/authz/scope-catalog.ts) 的
  `tenantGrantableScopes()` 已有「租戶自訂 scope 動態展開」的先例（`form:<formId>`）。
- `knowledge_chunks` 已有 `file_id`，檔案層標籤有現成掛載點。

因此本設計只做「檔案 → 標籤」這一半，「人 → 標籤」全部沿用既有機制，後台授權頁面無需改動。

## Goals

1. 檔案層級的可見性控制，租戶自行定義分類。
2. 過濾在資料庫端與向量排序同時完成（pre-filter），不影響召回品質。
3. 未標記的內容預設不可見（fail-closed）。
4. 無權內容對使用者完全隱形，不洩漏存在性。
5. 可分階段上線，且任何一步都能在數十秒內回滾。

## Non-Goals

- **Chunk 層級權限**（同一文件不同段落不同可見性）。需要 ingest 時判定段落權限，
  實務上只能靠人工標註，維運成本不成比例。有需要時拆檔即可。
- **標籤階層**（`kb:hr` 自動含 `kb:hr.salary`）。YAGNI；扁平標籤 + 套餐已能表達多數需求。
- **Postgres RLS**。見「方案比較」。
- **改寫既有的 scope 指派 UI**。標籤沿用 `kb:` 前綴進入現有目錄，UI 自動涵蓋。

## 核心決定

| # | 決定 | 理由 |
|---|---|---|
| 1 | **粒度＝檔案／來源層** | `file_id` 是現成掛載點；管理者心智模型直觀（「這份薪酬辦法只有 HR 看得到」）。 |
| 2 | **標籤＝ `kb:<labelId>` scope** | 沿用 `resolveScopes`，不新增第二套權限概念，不做 role 表。 |
| 3 | **未標記＝ fail-closed** | 失效方向是「查不到」，使用者會馬上反應；fail-open 的失效方向是外洩，而且永遠不會有人來抱怨。 |
| 4 | **無權內容完全隱形** | 檔名本身常即機密（「2026裁員名單.xlsx」）。回「有但你不能看」等於確認存在性，可被當探測工具反覆試探。 |

## 方案比較

### 方案 A：身分下推到檢索介面（**採用**）

改 `KnowledgeRetriever` 契約，`search` 收 `RetrievalPrincipal` 而非 `tenantId`，
pgvector 實作把可見性條件併進 where 子句。

型別強制：改了介面後，四個呼叫端全部編譯失敗，不可能漏掉任何一個
——特別是報告那條（`report.compose`），它不在對話流程裡卻能把整份文件彙整成可下載檔案，
是最容易被忘記的一條路。

### 方案 B：外層過濾裝飾器（**否決**）

不動介面，包一層 `GuardedRetriever` 過濾回傳結果。改動最小，但這是 **post-filter**。

`POOL_SIZE = 20`（[`retriever.scoring.ts`](../../../server/src/modules/knowledge/retriever.scoring.ts)）。
`limit 20` 先執行、過濾後執行，權限窄的使用者候選池會被無權 chunk 佔滿，過濾後剩零筆。
這正是 `retriever.pgvector.ts` 開頭註解記載、0006 migration 移除 HNSW 索引的同一個坑
（「pgvector 的 post-filter 會讓小租戶幾乎撈不到自己的列」）。

失效是靜默的：測試環境資料少時完全重現不出來，上線後表現為
「HR 的人問什麼都說查無資料」，且日誌無異常。

### 方案 C：Postgres RLS（**否決**）

資料庫層強制，程式漏了也擋得住。但專案使用 Prisma 連線池，
session variable 會殘留到下一個借用同一條連線的請求——**bug 的長相是「A 使用者拿到 B 的權限」**，
機率性且與負載相關。要做對得把每次檢索包進交易先 `set local`。
以目前單一 where 條件即可解決的需求而言，防禦力增益配不上這個風險。
權限規則複雜到程式層守不住時再回頭考慮。

---

## §1 資料模型與真相來源

### 標籤目錄（租戶自訂）

`Tenant` 新增：

```ts
/** 知識庫可見性標籤目錄（租戶自訂分類）。id 進 scope 體系時前綴 kb:。 */
knowledgeLabels?: { id: string; label: string }[];
```

放 `Tenant` 而非 `KnowledgeIndexMeta`，理由有二：標籤是**授權概念**，與 `grantedScopes` 同層；
而 `KnowledgeIndexMeta` 的語意是索引**狀態**（`status` / `chunkCount` / `files`），
塞授權定義進去會混淆職責。且 `resolve-scopes` 既有相依已包含 `tenantStore`，不新增相依方向。

`scope-catalog.ts` 的 `tenantGrantableScopes()` 比照 `form:<formId>` 展開：

```ts
const labels: ScopeDef[] = (tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => ({
  id: `kb:${l.id}`,
  label: l.label,
  description: `檢索「${l.label}」分類的知識庫內容`,
  base: false,
}));
```

`assertGrantableScopes()` 同步放行 `kb:<id>`（比照 `validFormIds` 的作法）。

`labelId` 限 `[a-z0-9-]+`（不含冒號）。scope id 以冒號分段，label id 內含冒號會讓
`kb:` 前綴的比對出現歧義——而該比對正是 §3 那道「租戶層禁止授予 `kb:`」的硬性檢查所依賴的。
建立標籤時即驗證，不留給呼叫端。

### 三個存放位置

| 位置 | 角色 | 寫入者 |
|---|---|---|
| `Tenant.knowledgeLabels` | 標籤目錄 | 管理者建立分類 |
| `KnowledgeFileMeta.visibilityScopes`<br>`KnowledgeSource.visibilityScopes` | **真相來源** | 管理者標檔案／設定來源 |
| `knowledge_chunks.visibility_scopes`<br>`knowledge_tables.visibility_scopes` | 查詢投影 | 寫入管線自動帶入 |

### 為什麼真相來源不能只放在 chunk 列上

`knowledge_chunks` **從不就地更新**，只有兩種寫法，兩種都是先刪再塞回：

- [`replaceWebsiteChunksInDb`](../../../server/src/modules/knowledge/knowledge.index.repo.ts)：
  刪掉 `file_id is null` 的列再塞回。**每次重爬都會走，這條路徑是活的。**
- [`saveIndexToDb`](../../../server/src/modules/knowledge/knowledge.index.repo.ts)：
  `delete from knowledge_chunks where tenant_id = ?` — 刪光整個租戶再重寫。
  語意上是整份取代，但目前生產程式碼中唯一的呼叫者是一次性遷移腳本
  `scripts/knowledge-migrate-to-db.ts`（其輸入讀自磁碟 JSON，不經 `loadIndexFromDb`）。

> **勘誤（2026-08-26）**：本節初稿曾聲稱「`ingestFile` / `removeFile` 都走
> `loadIndex → saveIndex`，每次上傳、每次刪檔都會清空標籤」。該敘述取自
> `knowledge.index.repo.ts` 中一段未隨重構更新的註解，**與現況不符**：
> `ingestFile` 走 `appendChunks`（點狀 upsert）、`removeFile` 走 `removeFileChunks`
> （點狀 delete），兩者都不經 `saveIndex`。
>
> 結論不變、理由收斂：標籤的真相來源仍必須置於檔案 meta 與來源設定，
> 因為**重爬那條路徑確實會整批換掉網站 chunk**（活的），而讀寫兩端的
> 對稱性（寫入寫了、讀取要讀得回來）本身就是正確性要求。
> 但「每上傳一檔即失聲」的急迫性描述是錯的，不應據此排定優先序。

標籤若只活在 chunk 上，下一次重爬就會把網站來源的標籤整批清空。
配合 fail-closed，結果是**知識庫某天早上毫無預警全部失聲**：沒有錯誤、沒有告警、日誌正常。

真相來源置於檔案 meta 與來源設定、chunk 上僅為投影、寫回時從真相來源重新帶入，
此失效模式即結構性消失。

### Schema 變更

```sql
-- migration 0007
alter table knowledge_chunks add column visibility_scopes text[];
alter table knowledge_tables add column visibility_scopes text[];
```

**刻意不設 default。** `NULL` 與 `[]` 語意不同：

- `NULL` ＝ 從未標記（遷移遺留），是**待辦事項**
- `[]` ＝ 明確標成「目前誰都不能看」，是**已完成的決定**

查詢效果相同（都查不到），但盤點報表必須分得出來。

GIN index 暫不建立。現況本來就是精確掃描（見 `retriever.pgvector.ts` 檔頭關於 0006 移除 HNSW 的說明），
多一個陣列相交判斷成本可忽略；資料量長起來再加。

### 型別變更

`IndexedChunk` 新增 `visibilityScopes?: string[]`，與 `fileId` 同樣角色——讓型別守住投影這件事。

### 兩處 upsert 必須加欄位

`saveIndexToDb` 與 `replaceWebsiteChunksInDb` 的
`on conflict (tenant_id, id) do update set` 欄位清單都要加上：

```sql
visibility_scopes = excluded.visibility_scopes
```

漏掉的症狀是「改了權限但沒生效，重啟也沒用」——upsert 默默保留舊值。

### 網站來源的掛載點

網站 chunk 無 `fileId`，但有 `KnowledgeSource`。標籤掛在來源設定上（整個網站一組），
寫入時投影到 chunk。不需要合成假的 sourceId。

---

## §2 檢索路徑

### `RetrievalPrincipal` 只帶身分，不帶權限

```ts
export interface RetrievalPrincipal {
  tenantId: string;
  userId: string;
}

export interface KnowledgeRetriever {
  readonly name: string;
  search(principal: RetrievalPrincipal, query: string): Promise<KnowledgeChunk[]>;
}
```

**刻意不含 `scopes` 欄位。** 權限由 retriever 內部呼叫 `resolveScopes()` 算出，再篩 `kb:` 前綴。

直覺作法是呼叫端算好 scopes 傳進來，但那讓 `scopes` 成為呼叫端可捏造的參數：
傳錯的、傳成別人的、新呼叫端圖方便傳 `['kb:*']` 的，全都編譯得過。
**權限計算只有一份且不接受外部輸入**，才是 fail-closed 守得住的形狀。

代價是 knowledge 模組新增對 authz 的相依，方向向下（authz 為底層），不製造循環。

[`getApplicant`](../../../server/src/modules/user/user.directory.ts) 對未知帳號回
`department: "—"` 而非 throw，故測試與匿名情境不會炸。

### SQL

兩路候選都要加，與 `tenant_id` 並排：

```sql
where tenant_id = ${tenantId}
  and visibility_scopes && ${scopes}::text[]
order by embedding <=> ${vec}::halfvec(3072)
limit ${POOL_SIZE}
```

**lexical 那一路絕不可漏。** 漏掉的失效模式特別惡毒：平常都對，只有在問句字面命中無權文件時才漏
——而那正是最敏感的查詢（打了產品代號、專案代號、人名去問）。

### fail-closed 由 SQL 語意自動給予

- 使用者無任何 `kb:*` → `scopes` 為空陣列 → `&& '{}'` 恆為 false
- 舊列 `visibility_scopes` 為 `NULL` → `NULL && ...` 得 `NULL` → 不通過 where

兩者都是「查不到」，無需額外防守碼。

### 四個呼叫點

| 呼叫點 | 身分來源 | 工作量 |
|---|---|---|
| [`knowledge.agent-service.ts`](../../../server/src/modules/knowledge/knowledge.agent-service.ts) | `session.userId` | 現成 |
| [`report.compose.ts`](../../../server/src/modules/report/report.compose.ts) `composeSection` | `report.job` 的 `params.userId` 往下傳 | 加一個參數 |
| [`knowledge.admin.controller.ts`](../../../server/src/modules/knowledge/knowledge.admin.controller.ts) `queryTest` | 見下 | 要設計 |
| `loadTableContext`（表格檢索平行路徑） | `session.userId` | 同步改 |

### 後台試查須支援「以某使用者身分」

管理者權限最大，用自己的身分試查永遠成功，等於沒測到。
而 `queryTest` 的既有註解已載明，此工具存在的意義就是驗證檢索真的正常。
權限上線後管理者最需要回答的問題是「HR 的小明看不看得到這份」。

試查 API 新增選填欄位 `asUserId`；未帶時用管理者自身。

### stub 與 staticIndex 也要實作過濾

不能只做 pgvector。dev 與正式環境權限行為不一致，等於權限邏輯從未被日常開發驗證。

stub 為固定 FAQ，**全部視為公開**——這須是明確寫下的決定，不是漏掉的結果。

---

## §3 匯入與後台

### 標籤目錄 CRUD

```
GET    /admin/tenants/:id/knowledge/labels
POST   /admin/tenants/:id/knowledge/labels          { id, label }
PATCH  /admin/tenants/:id/knowledge/labels/:labelId { label }
DELETE /admin/tenants/:id/knowledge/labels/:labelId
```

刪除前須回報使用中的文件數。刪除後那些文件**回到未標記（鎖住），不變公開**
——刪除操作絕不能是提權操作。

### 檔案與來源標註

```
PATCH /admin/tenants/:id/knowledge/files/:fileId/visibility  { scopes: string[] }
PATCH /admin/tenants/:id/knowledge/source                    { ..., visibilityScopes }
```

### 批次匯入：fail-closed 的真正痛點

[`folder-ingest`](../../../server/src/modules/knowledge/folder-ingest.service.ts) 無人值守，
沒有人在旁邊標。照規則匯進來的檔案全部鎖死。

**「匯入成功但沒人看得到」是系統中最糟的狀態**：embedding 的錢付了、空間佔了、
`chunkCount` 漂亮地漲、面板一切正常，但這些文件對所有人都不存在，
且**不會有人來抱怨**——沒人知道它們該存在。殭屍文件會持續累積。

沿用既有慣例解決。[`batch-source.ts`](../../../server/src/modules/knowledge/batch-source.ts)
的 `PendingItem.tenantId` 即「本機來源＝子資料夾名」，用目錄結構編碼 metadata
是這條管線的既有作法。往下多一層：

```
inbox/<tenantId>/<labelId>/xxx.pdf   →  標上 kb:<labelId>
```

**對不上已知標籤的檔案不匯入**，直接歸檔至錯誤區（`settle` 已有此機制）。
這比「匯入後鎖住」好：錯誤區看得見、可處理、且尚未花掉 embedding 的錢。
fail-closed 在此的正確形狀是**擋在門口**，不是放進來再關燈。

### 重爬保住標籤

來源設定的 `visibilityScopes` 於 `replaceWebsiteChunks` 寫回時重新投影（§1 的落實）。

### 改標籤是廉價操作

```sql
update knowledge_chunks set visibility_scopes = ? where tenant_id = ? and file_id = ?
update knowledge_tables set visibility_scopes = ? where tenant_id = ? and file_id = ?
```

不碰 embedding、不重爬、不花 token。

**兩張表必須同一交易，且封裝成單一函式**，不讓呼叫端有機會只呼叫其中一個。
漏掉 `knowledge_tables` 就是一道側門，症狀為
「文件鎖起來了，但問它裡面的表格數字還是答得出來」。

### 檔案清單須標示未標記

fail-closed 讓未標記等於白花錢，此狀態必須以警示色刺眼呈現。
這也是遷移期間唯一能看見進度的地方。

### 公開 widget 的訪客身分

公開 widget 是實際使用中的情境，必須有明確的訪客可見範圍。

**訪客不是「未認證」。** `/api/conversations` 有掛 `requireAuth`
（[`app.ts`](../../../server/src/app.ts)），`conversation.controller` 裡
`x-user-id` 那條 fallback 在正式路徑上是死碼——
[`conversation.routes.ts`](../../../server/src/modules/conversation/conversation.routes.ts)
「MVP：未掛 requireAuth」的註解已過期，本設計實作時順手修正。

訪客的 token 由宿主經 `/auth/sso/exchange` 簽發，帶著宿主決定的 `sub`。
該 `sub` 不在使用者目錄中，`getApplicant` 回 `department: "—"`。

**掛鉤點因此是部門，不是租戶層。** `scopePolicy.groups` 以部門字串為 key，
把 `kb:public` 指派給「—」部門即可涵蓋所有訪客。

順帶一個正確的性質：員工尚未在目錄建檔時同樣落在「—」，拿到訪客權限——最小權限，方向正確。

實作上將該字串提為具名常數（`UNKNOWN_DEPARTMENT`，值沿用 `getApplicant` 現有的 `"—"`），
後台部門指派 UI 顯示為「訪客／未建檔帳號」。魔術字串散落在兩個模組是這裡唯一的壞味道，
用常數收斂掉。

### ⚠ 租戶層 `grantedScopes` 一律禁止 `kb:` 前綴

`resolveScopes` 會把 `Tenant.grantedScopes` 併給**該租戶所有人，包含訪客**。
該欄位語意是「這租戶買了哪些能力」，誤操作門檻很低——
把 `kb:hr` 放進去，等於對公開 widget 開放人事文件。

既然訪客走部門掛鉤，租戶層就**不需要任何 `kb:` 例外**：
`assertGrantableScopes` 在租戶層授予路徑上一律拒絕 `kb:` 前綴，無白名單。
此為硬性檢查，不是 UI 提示。

### 前提：ACL 的安全上限＝身分來源的可信度

SSO handoff 讓**宿主決定 `sub`**。宿主若以 `sub = "hr-manager-001"` 簽發 Assertion，
本系統就認定那是 HR 主管。亦即這套 ACL 的強度上限等於**整合方私鑰**的保管強度與其簽發紀律。

> 本段原本寫的是「等於 `ssoSecret` 的保管強度」。SSO 改為非對稱的 Identity Assertion 之後
> 這句話要改寫，而且**論述變強了**：共享密鑰時代雙方都持有可簽出任何身分的秘密，
> 我方的保管疏失同樣會塌；現在私鑰從不離開整合方環境，HyAgent 只有公鑰，
> **我方不再持有任何可偽造使用者身分的東西**。風險面因此收斂成單一方的保管紀律。

這是既有的信任模型，本設計未改變它。但要明講的是**分級會改變它的後果**：
在沒有分級的今天，冒充身分看到的東西完全一樣，無害；上線後，冒充即提權。
導入本設計時應同步向整合方重申**私鑰**的保管要求（建議 KMS / Vault），
並說明金鑰外洩時的止血動作：在後台撤銷該 `kid`，以它建立的所有 Session 立即失效。

---

## §4 遷移

### 核心：把「上線」拆成兩個獨立事件

不需在「既有資料一次標成公開」（實質 fail-open，且「之後再收緊」通常不會發生）
與「一次標成鎖住」（立刻失聲）之間二選一——兩者都假設程式上線與權限生效必須同時發生。

`Tenant` 新增三態旗標：

```ts
/** 知識庫 ACL 階段：off＝不過濾（預設）/ shadow＝不過濾但記錄影響 / on＝強制過濾 */
knowledgeAcl?: 'off' | 'shadow' | 'on';
```

未設視為 `'off'`。

### 步驟

**1. `off` — 程式上線，行為零改變。**
retriever 在 `off` 時完全不加可見性條件。schema 加欄位、程式部署、測試在正式環境跑過，
檢索結果與昨日完全相同。風險趨近於零，且把「新程式碼有無 bug」與「權限規則對不對」
兩個問題分開——一次只除錯一件事。

**2. 管理者標註期。** 後台標既有檔案與來源。此時未標記文件仍可查（旗標未開）。
檔案清單顯示未標記數量作為進度。

**3. `shadow` — 照常回答，但記錄影響。**
回傳完整結果不過濾，同時記下「若啟用會濾掉幾筆、是哪些檔」。跑一至兩週。

這是整個遷移的價值所在。它回答一個在辦公室裡想不出來的問題：
**大家實際天天在查、卻沒人記得去標的文件是哪些。**
管理者憑印象標註必有遺漏；shadow 用真實流量抓出來，過程中無人受影響。

少了這步，漏標會在 `on` 的第一天集中爆發，且以「知識庫壞了」而非「權限要調整」的形式抵達。

實作上，`shadow` 對 SQL 的處理與 `off` 相同（不加可見性條件），
過濾改在 Node 端對回傳結果**模擬**一次，只為算出差集；回傳給使用者的仍是未過濾結果。

這裡刻意不用 pre-filter 跑第二次查詢：那會多一次全租戶向量掃描，
而 shadow 要的只是「哪些檔會被擋掉」，不是「過濾後的正確排序」。
也因此 shadow 統計會低估影響——它看不到那些**因為候選池被佔滿而根本沒進 top-20** 的有權文件。
這個限制要讓管理者知道：shadow 回報零影響不等於切換 `on` 後零影響。

### shadow 統計的存放：專用計數表，不借用 `audit.store`

管理者需在後台看到這份統計，但**不可寫進 `auditStore`**：
`AuditEntry` 綁 `toolId`（語意對不上），且 `MAX_PER_TENANT = 500`
而 shadow 是每次查詢一筆的高頻寫入——**幾天內就會把真正的工具稽核紀錄整批擠掉**。

改用專用表，以 (租戶, 檔案) 為單位累加：

```sql
create table knowledge_acl_shadow (
  tenant_id       text not null,
  file_id         text not null,
  blocked_count   bigint not null default 0,
  sample_user_ids text[],           -- 最多保留 5 個，供追查是誰在找
  last_blocked_at timestamptz not null,
  primary key (tenant_id, file_id)
);
```

這個形狀有三個好處：資料量有界（等於檔案數，不是查詢數）、
後台直接讀不必聚合、切 `on` 後整表 drop 與旗標一起退場。

管理者要的是決策資訊（「這份檔被擋了 47 次」），不是逐筆日誌。

**不記問句全文**（可能含個資）；要定位漏標的檔案，`file_id` 與少量 `sample_user_ids` 已足夠。

**4. `on` — 正式生效。** 未標記文件自此鎖住，此為設計預期結果。

### 回滾成本＝改一個字

出事切回 `shadow`：不回滾資料、不重跑 embedding、不改 schema。
可以放心切換，因為切錯的代價是三十秒。

### 盤點 API

```
GET /admin/tenants/:id/knowledge/acl-report
→ { unlabeled: FileMeta[], explicitlyEmpty: FileMeta[], shadowStats: {...} }
```

`unlabeled`（`NULL`）與 `explicitlyEmpty`（`[]`）分開列——前者待辦，後者已決定。

### 旗標的移除時程（寫死在此）

**所有租戶切至 `on` 後，即移除三態邏輯，只留無條件過濾。**

遷移旗標兩年後仍躺在程式碼裡是常態，屆時沒人記得 `off` 是什麼意思、敢不敢刪。
此句現在寫進 spec，比日後靠記性可靠。

---

## §5 測試策略

好寫的案例（有權看得到、無權看不到）不會咬人。以下四條會：

| 測什麼 | 為什麼是這個 | 驗收條件 |
|---|---|---|
| **lexical 路徑也過濾** | 最易漏。既有回歸測試已看守「語意遠但字面精確命中」的場景，加上權限維度 | 無權使用者以精確詞（產品代號）查詢，回傳不含無權 chunk |
| **重爬後標籤仍在** | §1 的失效模式。可比照 `knowledge-manual-survives-reingest.test.ts` 的結構 | 爬 → 標 → 重爬 → 標籤與重爬前一致 |
| **候選池不被無權文件佔滿** | pre-filter 的守門員；此條在方案 B 下必然失敗 | 30 筆無權 + 3 筆有權（`POOL_SIZE`＝20），3 筆全數回傳 |
| **`knowledge_tables` 無側門** | 表格是平行檢索路徑 | 鎖住檔案後，問其表格內數字答不出來 |

**前三條在小資料量下錯誤實作也會通過**，故測試資料必須刻意造到超過 `POOL_SIZE`。
此點須寫入測試檔註解，否則接手者會覺得造 30 筆假資料很蠢而簡化掉。

補充案例：

- `off` / `shadow` 狀態下檢索結果與未套用權限時**逐筆相同**（遷移安全性的基礎）
- 空 scopes 使用者回傳零筆，且不拋錯
- 租戶層 `grantedScopes` 授予任何 `kb:` 前綴應被 `assertGrantableScopes` 拒絕（400），無白名單例外
- 未知 `sub`（訪客）解析出的部門為 `UNKNOWN_DEPARTMENT`，且僅取得指派給該部門的 `kb:` 標籤
- shadow 高頻寫入不影響 `auditStore.list()` 的內容（回歸測試：確保沒有人日後圖方便改回去寫 audit）

---

## 已解決的設計問題（保留紀錄）

1. **公開 widget 的訪客可見範圍**（2026-08-25 確認）。公開 widget 為實際使用情境。
   解法為「`kb:public` 指派給 `"—"` 部門」，租戶層則完全禁止 `kb:` 前綴。見 §3。
2. **shadow 統計存放位置**（2026-08-25 確認）。管理者需在後台看到統計，
   但走專用計數表而非 `auditStore`——後者會擠掉工具稽核紀錄。見 §4。

## 未決事項

無。實作前若發現 §3 的 `UNKNOWN_DEPARTMENT` 常數與 HR 系統串接後的部門值有衝突，回頭修訂本節。
