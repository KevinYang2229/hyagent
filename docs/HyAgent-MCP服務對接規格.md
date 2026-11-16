# HyAgent MCP 服務對接規格（Java 17／Spring Framework 6 版）

| 項目 | 內容 |
| --- | --- |
| 文件版本 | v1.1（2026-11-11） |
| 範例專案 | `inventory-mcp-demo`（Java 17＋Spring Boot 3.5，隨本文件提供） |
| 適用對象 | 要把既有系統包裝成 MCP 服務、供 HyAgent 智慧代理呼叫的開發團隊 |
| 協定 | Model Context Protocol（MCP），Streamable HTTP 傳輸 |
| 由 HyAgent 提供 | JWKS 公鑰網址、分配的 `serverId`、測試環境 |
| 由貴方提供 | MCP 端點網址、工具清單與說明、角色定義（選填） |

> 文件中的 `<HYAGENT_URL>`、`<serverId>` 等角括號項目，於對接時由雙方確認後填入。

---

## 1. 整體架構

```text
使用者 ──對話──▶ HyAgent（智慧代理＋MCP Client）──HTTPS＋JWT──▶ 貴方 MCP Server ──▶ 貴方業務系統
                        ▲                                              │
                        └──────── GET JWKS（驗章用公鑰）◀──────────────┘
```

- **HyAgent 是 MCP Client**，貴方實作 **MCP Server**。HyAgent 負責理解使用者意圖、決定呼叫哪個工具、處理權限與使用者確認；貴方負責執行業務並回傳結果。
- 每個 HTTP 請求都帶一張 HyAgent 簽發的短效 JWT，貴方用 HyAgent 公開的 JWKS 驗章，就能知道「是哪個租戶、哪位使用者」在呼叫。
- 網路需求（雙向）：
  - HyAgent 後端 → 貴方 `https://<貴方主機>/mcp`
  - 貴方 MCP Server → `<HYAGENT_URL>/.well-known/hyagent-mcp-jwks.json`

---

## 2. 傳輸層規範

| 項目 | 規範 |
| --- | --- |
| 傳輸方式 | **Streamable HTTP**（MCP 規範 2025-03-26 之後的版本）。**不支援** stdio，也不支援舊版 HTTP+SSE 雙端點 |
| 端點 | 單一端點，建議 `POST /mcp` |
| 協定 | 正式環境**必須是 HTTPS**；HTTP 只限開發環境 |
| 狀態 | **建議採無狀態（stateless）模式**：每個請求獨立處理、不依賴 session。HyAgent 會在連線中斷後自動重建連線 |
| 回應格式 | `application/json` 或 `text/event-stream` 都可以 |
| Accept 標頭 | HyAgent 一律送 `Accept: application/json, text/event-stream`。MCP Java SDK 會要求兩者都要有，缺少時回 400 |
| GET `/mcp` | 無狀態模式可回 `405 Method Not Allowed`，HyAgent 會正常處理 |
| 重新導向 | **HyAgent 不跟隨任何 3xx**（避免把 JWT 送到別的主機）。端點不可有 http→https、補斜線之類的跳轉，請登記最終網址（例如登記 `/mcp` 就不要再讓 `/mcp` 跳到 `/mcp/`） |
| 內網部署 | HyAgent 預設禁止連往私有 IP。若貴方服務部署在內網，請提供完整 origin（如 `https://10.1.2.3:8443`），由 HyAgent 管理員加入白名單 |

### 2.1 HyAgent 送出的請求

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9...
MCP-Protocol-Version: 2025-06-18

{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"inventory_query","arguments":{"keyword":"牛奶"}}}
```

`MCP-Protocol-Version` 的值依 `initialize` 協商結果而定，上例僅供示意，由 SDK 自動處理。

HyAgent 會呼叫的 MCP 方法：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`。貴方只需宣告 `tools` 能力，不必實作 resources、prompts。

### 2.2 逾時與大小限制

| 項目 | 限制 | 超過時 |
| --- | --- | --- |
| 建立連線（initialize） | 10 秒 | 視為連不上 |
| `tools/list` | 10 秒 | 視為連不上 |
| `tools/call` | 預設 20 秒（HyAgent 管理員可依服務調整） | 回報使用者「回應逾時」 |
| 單次結果 | 序列化後 16,000 字元 | 截斷成文字，**表格顯示失效**（見 §6） |

---

## 3. 身分驗證（JWT）

### 3.1 Token 格式

每個 HTTP 請求都會帶一張**新簽發**的 JWT：

```json
// Header
{ "alg": "ES256", "typ": "JWT", "kid": "Jx3...k9" }

// Payload（一般使用者呼叫）
{
  "iss": "hyagent",
  "aud": "<serverId>",
  "sub": "u_12345",
  "tenant": "t_acme",
  "scopes": ["mcp:<serverId>", "mcp:<serverId>:manager"],
  "iat": 1762838400,
  "exp": 1762838460,
  "jti": "7f1c2e9a-...-..."
}

// Payload（系統呼叫：initialize、tools/list）
{
  "iss": "hyagent",
  "aud": "<serverId>",
  "sub": "hyagent-system",
  "scopes": [],
  "iat": 1762838400, "exp": 1762838460, "jti": "..."
}
```

| Claim | 說明 |
| --- | --- |
| `iss` | 固定為 `hyagent` |
| `aud` | 貴方的 `serverId`（字串）。**必須比對**，防止發給其他服務的 token 被拿來呼叫貴方 |
| `sub` | 使用者 ID；系統呼叫時為 `hyagent-system` |
| `tenant` | 租戶 ID；系統呼叫時不存在 |
| `scopes` | 只會帶與貴方服務相關的權限：`mcp:<serverId>`，以及登記時宣告的角色 `mcp:<serverId>:<role>` |
| `iat`／`exp` | 效期 60 秒 |
| `jti` | 每張 token 唯一，可用於防重放與稽核串接 |

### 3.2 驗證規則（貴方必須實作）

1. 簽章演算法只接受 **ES256**（EC P-256），依 header 的 `kid` 從 JWKS 選鑰。
2. `iss == "hyagent"`、`aud == <serverId>`。
3. `sub`、`iat`、`exp`、`jti` 都必須存在。
4. `exp - iat ≤ 300` 秒（拒絕效期異常長的 token）。
5. 時間誤差容許 15 秒：`now ≤ exp + 15`、`iat ≤ now + 15`。
6. （建議）同一個 `jti` 在效期內只接受一次。
7. **驗證失敗回 HTTP 401**。HyAgent 後台會顯示「驗證失敗」，方便雙方排查。

> **ES256 簽章格式陷阱**：JWS 的 ES256 簽章是 64 bytes 的 R‖S 原始格式（IEEE P1363），**不是** Java `Signature.getInstance("SHA256withECDSA")` 預設的 DER 格式。請使用 Nimbus JOSE+JWT 等成熟函式庫，不要自己手寫驗章。

### 3.3 JWKS 公鑰

- 網址：`GET <HYAGENT_URL>/.well-known/hyagent-mcp-jwks.json`（不需登入）
- 回應帶 `Cache-Control: public, max-age=300`
- **換鑰期間 JWKS 會同時列出新、舊兩把公鑰**。請依 `kid` 選鑰，遇到未知 `kid` 時重抓 JWKS（建議至少間隔 30 秒，避免被惡意 token 觸發大量重抓）。
- 建議快取 5 分鐘；重抓失敗時保留舊快取。

```json
{ "keys": [ { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "kid": "Jx3...k9", "alg": "ES256", "use": "sig" } ] }
```

### 3.4 系統呼叫

`initialize` 與 `tools/list` 以 `sub = "hyagent-system"` 呼叫，沒有 tenant、scopes 是空陣列。**驗章通過就必須放行**，否則 HyAgent 取不到工具清單，整個服務都不會出現。

### 3.5 權限與角色

- HyAgent 只會把 `mcp:<serverId>` 授權給特定部門或帳號，沒有授權的使用者根本不會呼叫到貴方。
- 若需要區分角色（例如一般員工只能查、主管才能核准），請在登記時提供角色名稱（小寫英數、`_`、`-`，最多 32 字元）。HyAgent 授權後會在 `scopes` 帶上 `mcp:<serverId>:<role>`，**角色能做什麼由貴方判斷**。
- 建議貴方用 `tenant`＋`sub` 做二次權限檢查與稽核紀錄。

---

## 4. 工具定義（`tools/list`）

### 4.1 回應範例

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "tools": [
      {
        "name": "inventory_query",
        "title": "查詢商品庫存",
        "description": "依商品名稱關鍵字查詢門市庫存、到期日與建議補貨量。使用者詢問庫存、缺貨、即期品時使用。",
        "inputSchema": {
          "type": "object",
          "properties": {
            "keyword": { "type": "string", "description": "商品名稱關鍵字" },
            "storeId": { "type": "string", "description": "門市代碼，不填則查詢使用者所屬門市" }
          }
        },
        "annotations": { "readOnlyHint": true }
      },
      {
        "name": "replenishment_create",
        "title": "建立補貨單",
        "description": "為指定商品建立補貨單。",
        "inputSchema": {
          "type": "object",
          "required": ["sku", "name", "quantity"],
          "properties": {
            "sku":      { "type": "string", "description": "商品編號", "x-hidden": true },
            "name":     { "type": "string", "description": "商品名稱", "readOnly": true },
            "quantity": { "type": "integer", "description": "補貨數量", "minimum": 1, "maximum": 999, "x-unit": "個" },
            "deliveryDate": { "type": "string", "format": "date", "description": "希望到貨日" },
            "priority": { "type": "string", "description": "優先等級", "enum": ["normal", "urgent"],
                          "x-enumLabels": { "normal": "一般", "urgent": "緊急" } }
          }
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false }
      }
    ]
  }
}
```

### 4.2 命名與內容規範

| 項目 | 規範 | 不符合時 |
| --- | --- | --- |
| `name` | 只能用英數、`_`、`-`。HyAgent 會組成 `mcp_<serverId>_<name>` 給 AI 模型，**總長不可超過 64 字元**。例：serverId 為 `inventory`（9 字）時，`name` 最多 50 字 | 該工具不出現 |
| `inputSchema` | 合法的 JSON Schema，頂層為 `object`。`$schema`、`$id` 會被忽略 | 該工具不出現 |
| `description` | 寫清楚**做什麼、什麼情境該用**，這是 AI 判斷要不要呼叫的唯一依據。上限 1,024 字元 | 超過會被截斷 |
| 每個欄位的 `description` | **一定要寫**，會成為確認卡片上的欄位名稱（有 `title` 時優先用 `title`） | 卡片顯示英文 key |
| `title` | 確認卡片標題，建議 60 字元內 | 改用 description |

### 4.3 讀寫判定（重要）

| 情況 | HyAgent 的處理 |
| --- | --- |
| `annotations.readOnlyHint: true`，**且** HyAgent 管理員已核准 | 視為唯讀：AI 可直接呼叫，不需使用者確認 |
| `readOnlyHint: true`，但管理員尚未核准 | 仍當寫入處理 |
| 沒有標 `readOnlyHint`，或為 `false` | 一律當寫入：AI 只能提議，**使用者在確認卡片按「確認」後才會呼叫** |

注意事項：

1. **唯讀工具不得有任何副作用。** 核准後的唯讀工具除了給 AI 用，也可能被 HyAgent 前台（例如 App 首頁摘要）直接呼叫，不經 AI、也不經使用者確認。
2. **工具定義一變更，唯讀核准就會失效。** 核准綁定的是「端點網址＋工具完整定義」（name、title、description、inputSchema、annotations）的指紋，任何一項變動都會回到「待核准」並改走確認卡片。上線後要調整工具定義，請事先通知 HyAgent 管理員重新核准。
3. HyAgent 管理員也可以對單一工具強制確認或停用。

### 4.4 確認卡片的 Schema 關鍵字

寫入工具的確認卡片會依 `inputSchema` 自動產生，使用者可以在卡片上修改參數後再送出。

| 關鍵字 | 卡片上的效果 |
| --- | --- |
| `title`／`description` | 欄位名稱（`title` 優先） |
| `type: "integer"`／`"number"` | 數字輸入，搭配 `minimum`／`maximum` 限制範圍 |
| `format: "date"` | 日期選擇器，值為 `YYYY-MM-DD` |
| `enum` | 下拉選單；`x-enumLabels` 提供顯示文字 `{ "值": "顯示文字" }` |
| `readOnly: true` | 顯示但不可修改 |
| `x-hidden: true` | 不顯示、不可修改（例如內部編號） |
| `x-unit` | 數值後方顯示單位 |
| `x-image: "<欄位名>"` | 在此欄旁顯示圖片，圖片網址取自指定欄位（須為 http(s) 網址） |
| `x-display: "html"` | 欄位值為 HTML，顯示時去除標籤，不可修改 |
| `type: "array"`＋物件 `items` | 顯示成表格；項目中有 `readOnly` 或 `x-hidden` 欄位時，使用者可以勾選移除列（保留至少 `minItems` 列） |

HyAgent 對使用者修改的保證：

- `readOnly`、`x-hidden`、`x-display: "html"`、`x-image` 指向的欄位一定維持原值；陣列只能刪列，不能新增列。
- 其他欄位會先依 schema 驗證才送給貴方。

**貴方仍必須自行驗證所有參數。** 尤其 `x-hidden` 欄位（如商品編號）使用者看不到，請驗證它和顯示欄位（如商品名稱）對得上，不要只相信其中一個。

---

## 5. 工具呼叫（`tools/call`）

### 5.1 成功回應

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "structuredContent": {
      "items": [
        { "name": "鮮乳 936ml", "stock": 3, "suggested": 12, "status": "庫存偏低", "image": "https://cdn.example.com/p/1001.jpg" },
        { "name": "優格 400g",  "stock": 20, "suggested": 0, "status": "正常", "image": "https://cdn.example.com/p/1002.jpg" }
      ]
    },
    "content": [ { "type": "text", "text": "{\"items\":[...]}" } ],
    "_meta": {
      "hyagent/display": {
        "type": "table", "title": "商品庫存", "rows": "items",
        "columns": [
          { "key": "name", "label": "商品名稱", "image": "image" },
          { "key": "stock", "label": "目前庫存", "unit": "個" },
          { "key": "suggested", "label": "建議補貨", "unit": "個", "format": "delta" },
          { "key": "status", "label": "狀態", "badge": { "庫存偏低": "danger", "正常": "success" } }
        ]
      }
    }
  }
}
```

- **優先回 `structuredContent`（JSON 物件）**，HyAgent 會優先讀它；沒有時才讀 `content` 中的文字。依 MCP 規範，建議同時在 `content` 放一份序列化文字以相容其他 Client。
- **回傳內容要直接回答問題。** 例如「這個時段會議室有沒有空」就回 `{ "available": false, "nextFreeAt": "14:00" }`，不要丟整張排程表讓 AI 自己推論（AI 容易讀錯）。
- 資料量大時請在服務端分頁或限制筆數（表格最多顯示 50 列），避免超過 16,000 字元。

### 5.2 業務錯誤

```json
{
  "jsonrpc": "2.0", "id": 4,
  "result": {
    "isError": true,
    "content": [ { "type": "text", "text": "此商品目前盤點鎖定中，暫時無法建立補貨單，請於盤點結束後再試。" } ]
  }
}
```

- 業務層面的失敗（查無資料、規則不允許、庫存不足等）**一律回 `isError: true`**，並在文字中寫出**使用者看得懂的原因**。AI 會如實轉述給使用者。
- 錯誤文字不要包含堆疊追蹤、SQL、內部主機名稱。

### 5.3 錯誤類型與 HyAgent 的反應

**請勿用 HTTP 5xx 表達業務錯誤**，否則 HyAgent 會判定整個服務斷線。

| 貴方回應 | HyAgent 判定 | 影響 |
| --- | --- | --- |
| `result.isError: true` | 單次業務失敗 | 只影響這次呼叫，AI 轉述錯誤原因 |
| JSON-RPC `error`（如參數錯誤 `-32602`） | 單次呼叫失敗 | 只影響這次呼叫 |
| HTTP 4xx（401、403 以外） | 單次呼叫失敗 | 只影響這次呼叫 |
| HTTP 401／403 | **驗證失敗** | 服務標記為斷線，進入退避 |
| HTTP 5xx、連線失敗、逾時於連線階段 | **服務無法連線** | 服務標記為斷線，進入退避 |

退避：連續失敗時以 1 秒、2 秒、4 秒……遞增等待，最長 5 分鐘。**退避期間該服務的所有工具都不會出現在 AI 可用清單中**，下一次成功呼叫後自動恢復。

### 5.4 冪等性（建議）

寫入工具建議設計成可安全重送，例如以 `jti` 或業務單號判斷重複請求，避免網路異常時重複建立資料。

---

## 6. 表格顯示提示（`_meta["hyagent/display"]`）

工具可以在結果的 `_meta["hyagent/display"]` 宣告表格，HyAgent 會把資料**原樣畫成表格**（不經 AI 轉述，不會讀錯數字），AI 只補一兩句重點說明。

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `type` | 是 | 固定為 `"table"` |
| `title` | 否 | 表格標題 |
| `rows` | 是 | `structuredContent` 中**陣列欄位的名稱**（例如 `"items"`） |
| `columns[].key` | 是 | 每列物件中的欄位名稱 |
| `columns[].label` | 是 | 欄位標題 |
| `columns[].unit` | 否 | 單位，例如 `"個"`、`"元"` |
| `columns[].format` | 否 | `text`（預設）、`delta`（正數顯示 +號，適合增減量）、`date` |
| `columns[].image` | 否 | 同列中存放圖片網址的欄位名稱（須為 http(s) 網址） |
| `columns[].badge` | 否 | 依值顯示色塊：`{ "值": "色調" }`，色調只有 `success`、`warning`、`danger`、`neutral` |

限制：

- 最多 **50 列、12 欄**，超過的列不顯示。
- 儲存格只接受**字串或數字**，其他型別顯示為空白。
- 任何欄位不合法時，**整張表格不顯示**（AI 仍會依資料回答）。
- `structuredContent` 超過 16,000 字元時會被截斷成文字，表格同樣不顯示。

---

## 7. Java 17＋Spring Framework 6 實作參考

本節程式碼取自**範例專案 `inventory-mcp-demo`（隨本文件提供）**，已實際編譯、通過自動化測試，並與 HyAgent 的 MCP Client 端對端連線驗證。完整程式請直接參考範例專案；本節只列出關鍵片段。

### 7.1 技術選型與版本

| 用途 | 套件 | 已驗證版本 |
| --- | --- | --- |
| 框架 | Spring Boot（Spring Framework 6.2） | 3.5.16 |
| MCP 協定 | `io.modelcontextprotocol.sdk:mcp-core`，使用內建的 **`HttpServletStatelessServerTransport`** | 1.1.5 |
| JSON | `io.modelcontextprotocol.sdk:mcp-json-jackson2` | 1.1.5 |
| JWT 驗證 | `com.nimbusds:nimbus-jose-jwt` | 10.10 |

> **版本注意事項**
>
> - **請勿使用 MCP Java SDK 2.x。** 2.x 的 Spring WebMVC／WebFlux transport 已移到 Spring AI 2.0+，而 Spring AI 2.0 需要 Spring Framework 7。Spring 6 環境請維持 1.1.x，使用核心模組內建的 Servlet transport（有沒有用 Spring Boot 都可以）。
> - **請勿使用聚合套件 `io.modelcontextprotocol.sdk:mcp`。** 它的 1.1.x 版會帶入 Jackson 3；Spring Boot 3 使用 Jackson 2，請改用 `mcp-core`＋`mcp-json-jackson2`。
> - **Spring Boot 3.5 不管理 `nimbus-jose-jwt` 的版本**，需要自行指定。

### 7.2 Maven 相依

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.5.16</version>
</parent>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>io.modelcontextprotocol.sdk</groupId>
    <artifactId>mcp-core</artifactId>
    <version>1.1.5</version>
  </dependency>
  <dependency>
    <groupId>io.modelcontextprotocol.sdk</groupId>
    <artifactId>mcp-json-jackson2</artifactId>
    <version>1.1.5</version>
  </dependency>
  <dependency>
    <groupId>com.nimbusds</groupId>
    <artifactId>nimbus-jose-jwt</artifactId>
    <version>10.10</version>
  </dependency>
</dependencies>
```

### 7.3 JWT 驗證

```java
public record HyAgentCaller(String tenantId, String userId, List<String> scopes, String jti, boolean system) {
  public boolean hasRole(String serverId, String role) {
    return scopes.contains("mcp:" + serverId + ":" + role);
  }
}

public class HyAgentVerifier {
  public static final String SYSTEM_SUBJECT = "hyagent-system";
  static final int MAX_LIFETIME_SECONDS = 300;
  static final int CLOCK_SKEW_SECONDS = 15;

  private final DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
  private final boolean rejectReplay;
  private final Clock clock;
  private final Map<String, Long> seenJti = new ConcurrentHashMap<>();

  public HyAgentVerifier(JWKSource<SecurityContext> jwks, String serverId, boolean rejectReplay, Clock clock) {
    this.rejectReplay = rejectReplay;
    this.clock = clock;
    processor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.ES256, jwks));
    DefaultJWTClaimsVerifier<SecurityContext> claims = new DefaultJWTClaimsVerifier<>(
        serverId,                                              // aud 必須等於 serverId
        new JWTClaimsSet.Builder().issuer("hyagent").build(),  // iss 必須等於 hyagent
        Set.of("sub", "iat", "exp", "jti"));                   // 必填 claim
    claims.setMaxClockSkew(CLOCK_SKEW_SECONDS);
    processor.setJWTClaimsSetVerifier(claims);
  }

  /** JWKSourceBuilder 預設：快取 5 分鐘、未知 kid 時重抓（含限頻）、重抓失敗沿用舊快取。 */
  public static HyAgentVerifier fromJwksUrl(String jwksUrl, String serverId, boolean rejectReplay) throws MalformedURLException {
    return new HyAgentVerifier(JWKSourceBuilder.create(new URL(jwksUrl)).build(), serverId, rejectReplay, Clock.systemUTC());
  }

  /** 驗證 Authorization 標頭；失敗丟例外，呼叫端回 401。 */
  public HyAgentCaller verify(String authorizationHeader) throws Exception {
    if (authorizationHeader == null || !authorizationHeader.startsWith("Bearer ")) {
      throw new BadJWTException("missing_bearer");
    }
    JWTClaimsSet c = processor.process(authorizationHeader.substring("Bearer ".length()).trim(), null);

    long now = clock.instant().getEpochSecond();
    long iat = c.getIssueTime().toInstant().getEpochSecond();
    long exp = c.getExpirationTime().toInstant().getEpochSecond();
    if (exp - iat > MAX_LIFETIME_SECONDS) throw new BadJWTException("lifetime_too_long");
    if (iat > now + CLOCK_SKEW_SECONDS) throw new BadJWTException("not_yet_valid");
    if (rejectReplay) {
      seenJti.entrySet().removeIf(e -> e.getValue() < now);
      if (seenJti.putIfAbsent(c.getJWTID(), exp + CLOCK_SKEW_SECONDS) != null) throw new BadJWTException("replayed");
    }

    boolean system = SYSTEM_SUBJECT.equals(c.getSubject());
    return new HyAgentCaller(
        Optional.ofNullable(c.getStringClaim("tenant")).orElse(""),
        system ? "" : c.getSubject(),
        Optional.ofNullable(c.getStringListClaim("scopes")).map(List::copyOf).orElse(List.of()),
        c.getJWTID(),
        system);
  }
}
```

> jti 防重放只在單機記憶體有效。多台部署時請改用 Redis 等共用儲存，或關閉此選項（其餘規則仍須實作）。

驗證失敗時，在 Servlet Filter 直接回 401，請求不會進到 MCP 層：

```java
public class HyAgentAuthFilter extends OncePerRequestFilter {
  public static final String CALLER_ATTR = HyAgentCaller.class.getName();
  private final HyAgentVerifier verifier;

  public HyAgentAuthFilter(HyAgentVerifier verifier) { this.verifier = verifier; }

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    try {
      req.setAttribute(CALLER_ATTR, verifier.verify(req.getHeader("Authorization")));
    } catch (Exception e) {
      log.warn("HyAgent JWT 驗證失敗：{}", e.getMessage());     // 只記原因，不記 token
      res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      res.setContentType("application/json");
      res.getWriter().write("{\"error\":\"unauthorized\"}");   // 不回傳例外細節
      return;
    }
    chain.doFilter(req, res);
  }
}
```

### 7.4 MCP Server 組裝

```java
@Configuration
public class McpServerConfig {

  @Bean
  public McpJsonMapper mcpJsonMapper(ObjectMapper objectMapper) {
    return new JacksonMcpJsonMapper(objectMapper);           // 沿用 Spring 的 Jackson 2 ObjectMapper
  }

  @Bean
  public HttpServletStatelessServerTransport mcpTransport(McpJsonMapper jsonMapper) {
    return HttpServletStatelessServerTransport.builder()
        .jsonMapper(jsonMapper)
        .messageEndpoint("/mcp")
        // 把 Filter 驗好的呼叫者放進 MCP transport context，工具 handler 才拿得到
        .contextExtractor(request -> request.getAttribute(HyAgentAuthFilter.CALLER_ATTR) instanceof HyAgentCaller c
            ? McpTransportContext.create(Map.of("hyagent.caller", c))
            : McpTransportContext.EMPTY)
        .build();
  }

  @Bean
  public ServletRegistrationBean<HttpServletStatelessServerTransport> mcpServlet(HttpServletStatelessServerTransport t) {
    return new ServletRegistrationBean<>(t, "/mcp");
  }

  @Bean
  public FilterRegistrationBean<HyAgentAuthFilter> mcpAuthFilter(HyAgentVerifier verifier) {
    FilterRegistrationBean<HyAgentAuthFilter> reg = new FilterRegistrationBean<>(new HyAgentAuthFilter(verifier));
    reg.addUrlPatterns("/mcp");
    return reg;
  }

  @Bean
  public McpStatelessSyncServer mcpServer(HttpServletStatelessServerTransport t, McpJsonMapper jsonMapper,
      InventoryTools tools) {
    return McpServer.sync(t)
        .serverInfo("inventory-mcp-demo", "1.0.0")
        .jsonMapper(jsonMapper)
        .capabilities(McpSchema.ServerCapabilities.builder().tools(true).build())
        .requestTimeout(Duration.ofSeconds(20))
        .tools(tools.all())
        .build();
  }
}
```

> 上例使用 Spring Boot 的 `ServletRegistrationBean`／`FilterRegistrationBean`。純 Spring Framework 6（沒有 Boot）請在 `WebApplicationInitializer` 中以 `ServletContext.addServlet`／`addFilter` 註冊同一組物件。

### 7.5 工具定義與 handler

**用原始 JSON Schema 定義 `inputSchema`**（範例專案放在 `src/main/resources/mcp/schemas/*.json`），不要只靠註解或反射產生。自動產生的 schema 通常放不進 `readOnly`、`x-unit`、`x-hidden` 等 §4.4 的關鍵字，也較難控制每個欄位的 `description`。

```java
// 工具定義：inputSchema(McpJsonMapper, String) 直接吃原始 JSON Schema 字串
McpSchema.Tool tool = McpSchema.Tool.builder()
    .name("inventory_query")
    .title("查詢商品庫存")
    .description("依商品名稱或分類查詢門市庫存、到期日、狀態與建議補貨量。使用者詢問庫存、缺貨、即期品時使用。")
    .inputSchema(jsonMapper, schemaJson)
    // ToolAnnotations(title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint, returnDirect)
    .annotations(new McpSchema.ToolAnnotations(null, true, false, true, false, null))
    .build();

// handler：(McpTransportContext, CallToolRequest) -> CallToolResult
SyncToolSpecification spec = new SyncToolSpecification(tool, (ctx, req) -> {
  HyAgentCaller caller = (HyAgentCaller) ctx.get("hyagent.caller");
  if (caller == null || caller.system()) {
    return CallToolResult.builder().isError(true).addTextContent("此工具需要使用者身分才能執行。").build();
  }
  try {
    Map<String, Object> data = Map.of("items", inventoryService.query(caller.tenantId(), req.arguments()));
    return CallToolResult.builder()
        .structuredContent(data)                                   // HyAgent 優先讀取
        .addTextContent(jsonMapper.writeValueAsString(data))       // 相容其他 Client
        .meta(Map.of("hyagent/display", INVENTORY_TABLE))          // §6 的表格宣告
        .build();
  } catch (BusinessException e) {
    return CallToolResult.builder().isError(true).addTextContent(e.getMessage()).build();  // §5.2
  } catch (Exception e) {
    log.error("inventory_query failed", e);                        // 細節只進 log
    return CallToolResult.builder().isError(true).addTextContent("系統暫時無法處理此請求，請稍後再試。").build();
  }
});
```

範例專案把「取得呼叫者、拒絕系統身分、錯誤轉 `isError`、稽核紀錄」集中在 `ToolSupport.spec(...)`，各工具只需撰寫業務邏輯。

### 7.6 本機測試

範例專案啟用 `dev` profile 時，會自帶測試用 JWKS（`GET /dev/jwks.json`）與 token 簽發端點（`GET /dev/token`），不必連 HyAgent 就能開發。**正式環境不可啟用 dev profile。**

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev   # 啟動
./scripts/smoke-test.sh                                  # 用 curl 走一遍 HyAgent 會發出的請求
./mvnw test                                              # 自動化測試
```

自行產生測試金鑰與 token 的方式：

```java
ECKey key = new ECKeyGenerator(Curve.P_256).keyID("test-key").generate();
String jwksJson = new JWKSet(key.toPublicJWK()).toString();   // 用任一 HTTP 端點提供這段 JSON

Instant now = Instant.now();
JWTClaimsSet claims = new JWTClaimsSet.Builder()
    .issuer("hyagent").audience("inventory-demo").subject("u_test")
    .claim("tenant", "t_test").claim("scopes", List.of("mcp:inventory-demo"))
    .issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(60)))
    .jwtID(UUID.randomUUID().toString())
    .build();
SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES256).keyID("test-key").type(JOSEObjectType.JWT).build(), claims);
jwt.sign(new ECDSASigner(key));
String token = jwt.serialize();
```

JWT 驗證至少要涵蓋以下情境（範例專案的 `HyAgentVerifierTest` 全部都有）：

| 情境 | 預期 |
| --- | --- |
| 正常使用者 token | 通過，取得 tenant、sub、scopes |
| `sub = hyagent-system`、無 tenant | 通過（系統呼叫） |
| 換鑰期間，新舊金鑰簽的 token | 都通過 |
| `aud` 是別的 serverId | 401 |
| `iss` 不是 hyagent | 401 |
| 已過期超過 15 秒 | 401（15 秒內仍通過） |
| `exp - iat` 超過 300 秒 | 401 |
| `iat` 在未來超過 15 秒 | 401 |
| 缺少 `jti` | 401 |
| 用另一把金鑰簽章、未知 `kid` | 401 |
| `alg` 為 HS256 或 none | 401 |
| 缺少 Authorization 標頭 | 401 |
| 同一張 token 重送（有開防重放時） | 401 |

可用 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)（`npx @modelcontextprotocol/inspector`）選擇 Streamable HTTP、填入 `Authorization` 標頭，手動測試 `tools/list`、`tools/call`。開啟 jti 防重放時，同一張 token 只能用一次，用 Inspector 測試前請先關閉防重放。

---

## 8. 對接流程

| 步驟 | 負責方 | 內容 |
| --- | --- | --- |
| 1 | 雙方 | 確認 `serverId`（小寫英數與 `-`，最多 32 字元）、工具清單、讀寫分類、角色 |
| 2 | HyAgent | 提供測試環境的 `<HYAGENT_URL>` 與 JWKS 網址 |
| 3 | 貴方 | 依本文件開發（可從範例專案 `inventory-mcp-demo` 起步），以 §7.6 自測通過 |
| 4 | 貴方 | 提供 MCP 端點網址；若在內網，提供 origin 以加入白名單 |
| 5 | 貴方 | 提供「能力描述」（一段話說明服務用途）與「路由關鍵字」（使用者常用的說法，例如：庫存、缺貨、補貨），HyAgent 用來判斷何時使用貴方服務 |
| 6 | HyAgent | 後台登記服務、測試連線、核准唯讀工具、授權給試用部門 |
| 7 | 雙方 | 以實際對話進行驗收（見 §9） |
| 8 | 雙方 | 正式環境重複步驟 2、4、6 |

---

## 9. 驗收檢查清單

### 傳輸與驗證

- [ ] 正式環境使用 HTTPS，端點沒有任何 3xx 跳轉
- [ ] JWT 驗證涵蓋 §3.2 全部規則，失敗回 401
- [ ] 系統呼叫（`hyagent-system`）可以正常取得工具清單
- [ ] HyAgent 換鑰時（JWKS 出現新 `kid`）服務不中斷

### 工具定義

- [ ] 工具名稱符合 §4.2 長度與字元限制
- [ ] 每個工具的 `description` 說明用途與使用情境
- [ ] 每個參數都有 `description`（或 `title`）
- [ ] 唯讀工具已標 `readOnlyHint: true`，且確實沒有副作用
- [ ] 寫入工具的確認卡片欄位顯示正確（隱藏、唯讀、單位、下拉）

### 回應與錯誤

- [ ] 回應以 `structuredContent` 為主，內容直接回答問題
- [ ] 業務錯誤回 `isError: true` 和使用者看得懂的訊息，不回 5xx
- [ ] 一般查詢在 20 秒內回應
- [ ] 單次結果在 16,000 字元內；表格不超過 50 列、12 欄
- [ ] 寫入工具自行驗證所有參數，`x-hidden` 欄位與顯示欄位一致

### 安全與稽核

- [ ] 依 `tenant`、`sub`、角色 scope 做二次權限檢查
- [ ] 記錄稽核紀錄（建議含 `jti`、`tenant`、`sub`、工具名稱、結果）
- [ ] 錯誤訊息與日誌不含 token 內容或敏感資料

---

## 附錄 A：名詞對照

| 名詞 | 說明 |
| --- | --- |
| MCP | Model Context Protocol，AI 應用呼叫外部工具的開放協定 |
| MCP Server | 提供工具的一方（貴方） |
| MCP Client | 呼叫工具的一方（HyAgent） |
| serverId | HyAgent 中識別貴方服務的代碼，同時是 JWT 的 `aud` |
| 租戶（tenant） | HyAgent 中的客戶單位，一個租戶代表一個組織 |
| JWKS | JSON Web Key Set，公開金鑰清單，用來驗證 JWT 簽章 |
| 確認卡片 | 寫入工具執行前，HyAgent 顯示給使用者確認或修改參數的介面 |
