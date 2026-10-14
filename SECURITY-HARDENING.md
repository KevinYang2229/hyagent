# 第二批安全修正

修改前快照：本機 annotated tag `v1.2.2`，對應 `cae825e`。本文件描述該快照之後的修改。

## 租戶使用者目錄

使用者姓名、部門、地區、通知 email、代理人與部門權限都以目前租戶的目錄解析。相同 userId 在不同租戶不再共用 mock profile。只有非 production 的 default 租戶保留開發名錄；未登錄的 SSO 使用者仍可登入，但 profile 只有其識別碼與未知部門，不會繼承其他租戶的資料或部門授權。既有帳號直接授權仍有效。

平台管理 API（需管理員憑證）：

- `GET /api/admin/tenants/:id/users`：讀取已設定的目錄。
- `POST /api/admin/tenants/:id/users`：新增單一帳號，保留既有人員，重複 id 回 409。
- `PUT /api/admin/tenants/:id/users`：完整取代該租戶目錄，完成持久化後回應。空陣列可清空。

```json
{
  "users": [
    { "id": "employee-001", "name": "王小明", "department": "業務部", "email": "employee-001@example.com", "deputyIds": ["employee-002"] },
    { "id": "employee-002", "name": "李小華", "department": "業務部" }
  ]
}
```

id 不可重複，代理人必須存在於同一份目錄。另支援 title、region。後台租戶頁新增「使用者目錄」（`?tab=users`），可查看與新增人員；權限設定的人員與部門選單也會使用此目錄。前後端須一併部署。新增只建立此租戶的 profile，不設定個別密碼；帳密登入仍使用既有 `AUTH_DEV_PASSWORD` 設定與開關。上線前應匯入各租戶資料，避免原先依賴共用 mock 部門的授權失效。

## 知識庫 ACL

所有租戶強制權限過濾。三態旗標（`knowledgeAcl`）與 shadow 統計已於後續清理中整個移除，不再有每租戶開關：管理 API 不接受該欄位（送出即 422），租戶資料上的殘值也不影響行為。向量檢索、靜態索引、表格目錄與表格內容均適用。未標記或空標籤文件不可見；須先建立標籤、標註文件／網站，再授權給對應部門、帳號或套餐。不自動將既有資料公開。

靜態索引讀取目前 metadata 的標籤，網站設定同步更新資料庫的 chunk／table 投影，刪除標籤也清除網站設定。公開訪客使用獨立的權限解析，不會取得與 tenantId 同名帳號的授權。

自動推薦問句僅採用訪客可見的語料。公開 widget 只顯示與目前 ACL 指紋一致的生成快取；舊快取或權限變更後的快取隱藏，需重新生成。生成期間若權限變動則丟棄結果。管理員手動設定的推薦問句仍視為主動公開內容。widget config 回應設定 `Cache-Control: no-store`。

## 登入保護

帳密登入由 `AUTH_PASSWORD_LOGIN` 控制：`auto`（預設）在 `NODE_ENV=production` 關閉、其他環境開啟；`off` 一律關閉；`on` 明確開啟。關閉狀態同時拒絕先前以帳密簽發的 access／refresh token。正式使用者走 SSO，平台管理員登入獨立保留。

`production` + `on` 另有兩道門檻：`AUTH_DEV_PASSWORD` 不得沿用 repo 內的預設值（boot fail-fast），且可登入帳號以該租戶後台設定的人員目錄為準——內建的開發名錄只有非 production 的 default 租戶提供，開了開關也不會讓 repo 裡的 mock 帳號能登入，沒建目錄的租戶則沒有任何帳號可登入。

帳密登入的 token 綁定「呼叫端 API Key 解析到的租戶」（未帶金鑰＝預設租戶），與 `requireAuth` 的租戶比對一致，嵌入式 widget 才不會登入成功後每支 API 都被判成租戶不符。每次請求重查目錄，帳號被移出後既有 token 立即失效。

此模式下 `AUTH_DEV_PASSWORD` 是全站唯一一組密碼、由所有租戶目錄內的帳號共用，屬過渡用途；宿主端 SSO 接上後應改回 `auto`。

登入、後台登入、SSO exchange、refresh 各自按來源 IP 限流；變更 username、user header 或租戶 key 不會重置額度。預設每 15 分鐘分別為 20、10、60、120 次，超過回 429 與 Retry-After。設定見 `server/.env.example` 的 `AUTH_*RATE_LIMIT*`。

預設不信任代理標頭。反向代理部署須以 `TRUST_PROXY` 填寫實際可信代理 IP／CIDR，避免所有訪客被算成代理的同一個 IP，也避免任意來源偽造 X-Forwarded-For。限流目前為單程序記憶體計數，重啟會重置；多副本部署需共用限流儲存或入口限流。

## 部署

本批目錄與 ACL 快取欄位存於既有 JSON config/meta，不新增資料庫 migration。後續清理移除三態旗標與 shadow 統計時新增 `0014_drop_knowledge_acl_shadow.sql`，刪除已無程式碼讀寫的 `knowledge_acl_shadow` 表；該步驟不可逆，套用前請先 `pg_dump` 備份。前一批 `SECURITY-FIXES.md` 要求的 migration、SDK 更新與重新登入仍適用。本批未對正式資料庫執行遷移或修改既有租戶授權。

## AI Agent 高優先防護（2026-10-14）

### 敏感文字外傳與 Email 網域

LLM 對話（含 system、工具定義、工具結果與歷史）、embedding 文字、MCP 工具參數，以及 Agent Email 執行前，統一檢查已知平台／租戶憑證、私鑰標記、常見 API key／JWT 格式與租戶指定的敏感文字。命中回 `EGRESS_BLOCKED`，不將命中文字帶入錯誤訊息。Email 稽核不再記錄收件人或主旨，避免被阻擋內容落入稽核。

由平台管理 API `PATCH /api/admin/tenants/:id` 設定：

```json
{
  "egressPolicy": {
    "allowedEmailDomains": ["example.com"],
    "sensitiveTerms": ["公司機密文件標記"]
  }
}
```

網域採完整比對，不隱含子網域、不支援萬用字元；收件人僅接受單一純 Email 位址。production 未設定允許網域即拒絕 Agent 寄信；開發／測試只有未設定此欄位時保留原先行為，明確設定空陣列仍拒絕全部網域。政策於每次執行重新讀取，使用者確認不會繞過政策。政策更新為整包取代，欲清除敏感文字請設 `sensitiveTerms: []`。

這是文字規則防護，並非完整 DLP：不辨識圖片、語音、任意編碼／拆分的內容，也不能推斷所有個資與商業機密。`sensitiveTerms` 應填保密標記或需阻擋的文字，不應用作憑證儲存庫。沒有自動掃描既有知識庫；後續 embedding 與模型傳送才套用檢查。

### MCP 目的地政策

production 的 MCP URL 必須為 HTTPS，禁止 URL 帳密與 fragment。每次 HTTP 請求驗證來源與 DNS 所有解析結果，實際 socket 固定連到已檢查 IP，避免 DNS rebinding。禁止 HTTP 重新導向與跨 origin 的 transport 請求，JWT 不會跟隨重新導向外傳。

私有網路預設拒絕。確有內網 MCP 需求時，在伺服器環境變數設定完整 origin（包含非預設 port）：

```dotenv
MCP_ALLOWED_PRIVATE_ORIGINS=https://mcp.internal.example.com:8443
```

例外只允許 RFC1918／loopback／IPv6 ULA，metadata、link-local、IPv4-mapped IPv6、multicast 等仍拒絕。開發／測試可使用 loopback HTTP 跑本機 demo；production 即使有例外仍要求 HTTPS。既有不符政策的 MCP 會連線失敗，部署前先調整 URL／網路設定。

### MCP 唯讀工具版本核准

核准以 SHA-256 綁定 endpoint URL 與完整工具定義（名稱、描述、schema、annotations）。舊的 `approvedReadOnly: true` 沒有指紋時，一律退回寫入確認流程。URL 或定義改變也不沿用核准；後台顯示待核准目前版本，須重新整理清單並審查後再核准。

API：先 `POST /api/admin/mcp-servers/:id/refresh`，取得工具列的 `fingerprint`，再 PATCH `toolOverrides.<toolName>` 帶 `approvedReadOnly: true` 與 `approvedFingerprint`。後端驗證該指紋符合目前快取，缺少或不符回 409；建立服務時不可預先核准。前後端須一併部署，不需新增 DB migration。

工具指紋只能偵測宣告的改變，不能驗證遠端程式行為；不可信服務即使宣告唯讀也不應核准。既有工具清單快取為 10 分鐘，可用後台重新整理立即取得新版本。
