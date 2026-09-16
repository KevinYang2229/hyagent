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
