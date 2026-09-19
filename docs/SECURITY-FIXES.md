# 六項安全修正與升級說明

修改前版本：本機 annotated tag `v1.2.1`，指向 `bb65877`。
本次修改尚未代表正式環境已部署。

> **本文是那一次修正的紀錄，不是現行 SSO 契約。** 其後 SSO 已整套改為非對稱的
> **Identity Assertion**（RS256 / ES256，租戶登記公鑰，HyAgent 不再持有任何共享密鑰）——
> 底下凡提到 HS256 簽章、`ssoSecret`、`ssoConfigured` 的段落**都已被取代**，
> 以 [SSO 契約](HANDOFF-SSO.md) 為準。非 SSO 的部分（防重複送出、跨租戶隔離、
> `sk_default` 撤銷、migration 順序）仍然有效。

## 修正範圍

| 問題 | 修正 |
| --- | --- |
| 租戶 SSO 提升平台管理員 | 外部 role 不作為授權來源，一律換發 employee（仍然有效）；管理員、一般使用者、Refresh Token 使用不同 audience，明確驗證 HS256 與 issuer——這三種是 **HyAgent 自家帳密登入路徑**的 JWT，至今未變；SSO 那一側已改為非對稱驗章。租戶建立、列表、更新不回傳密鑰（仍然有效），但狀態欄位由 `ssoConfigured` 改為 `activeKeyCount`（現行為公鑰數量）。 |
| 跨租戶讀取 | requireAuth 統一檢查 Token 所屬租戶、登入來源、現行憑證與撤銷紀錄；內部帳密綁定 default，SSO 綁定交換時的租戶。舊對話、報告、表單、任務路由都受保護。 |
| 固定預設秘密金鑰 | 不再建立 sk_default；啟動時撤銷舊紀錄，查詢時亦固定拒絕。pk_default 維持公開 widget 相容。需要伺服器自助設定時，由管理 API 另發隨機 sk_ 金鑰。 |
| 表單權限繞過 | 表單建立、讀取、編輯、附件、取消、HTTP 送出、Agent 表單工具及送出 registry 重查 service:form 與 form:<id>。沒有表單授權時建立 formId 為空字串的一般對話，可繼續使用已授權的知識／報告服務，不能退回請假單。 |
| 重複送出 | HTTP 與 Agent 使用共用 submitSession，送出前驗證與複製欄位，阻擋送出中的修改／取消；先持久化唯一 claim 和 submitting 狀態，再呼叫 OA。資料庫以唯一主鍵 INSERT ON CONFLICT、file 以 exclusive create 防止重複。 |
| Token 生命周期 | SSO 強制 exp、iat、最長 5 分鐘、指定 issuer/audience（現行契約沿用此上限，`iss` 改為 Tenant ID、`aud` 為 `hyagent`）；每次 SSO 設定變更更新版本，舊密鑰恢復亦不復活舊登入（現行改以撤銷 `kid` 表達，且連帶作廢以該金鑰建立的所有 Session）。Refresh Token 單次使用，重用會撤銷整個登入 family（含 Access Token）；租戶刪除、停用 SSO 或密鑰變更後拒絕舊 Token。DB 模式直接查最新租戶憑證。 |

## 部署順序與相容性

1. **先套用 `server/db/migrations/0012_security_claims.sql`**，再部署伺服器。file 模式不需要 SQL。資料表尚未建立或不可寫入時，驗證／續期／送出會拒絕操作，不會略過安全檢查。
2. 升級整合方的 `@hyagent/sdk/server` 或依 [SSO 契約](HANDOFF-SSO.md) 更新簽章。
   ~~新版要求 `iss=hyagent:handoff`、`aud=hyagent:sso`、HS256、最多 300 秒有效期限。~~
   **此要求已作廢**：現行契約為 RS256 / ES256 以**整合方私鑰**簽發，`iss` 為 Tenant ID、`aud` 為 `hyagent`，
   header 需帶 `kid`，`exp - iat` 上限 300 秒（建議 60 秒），並帶一次性的 `jti`。照舊的 HS256 簽會被驗章拒絕。
3. 前端與 SDK 一起更新，確保同一執行環境內的多個 401 共用一次續期請求。前端另在支援 Web Locks 的瀏覽器協調跨分頁續期。
4. **既有登入 Token 不相容，使用者與後台管理員需要重新登入。** 不能把舊 Token 的 audience/role 驗證放寬作為過渡。
5. 仍使用 `sk_default` 的整合方，改用管理 API 新簽發的隨機秘密金鑰。API 只在簽發時回傳原始值一次。
6. 租戶讀取回應不再包含密鑰與 `llmConfig`；LLM 設定繼續走專用的遮罩端點。
   （當時的 `ssoSecret` / `ssoConfigured` 欄位已隨非對稱改造移除，現行為 `publicKeys[]` 與 `activeKeyCount`。）
7. 舊 `/api/leave` 額度端點使用平台 OA 連接器，限定 default 的內部帳密身分；其他租戶需另行實作租戶專屬 OA 額度連接器。

## 送出與儲存界線

- 這次採用「同一對話最多嘗試一次外部送出」。OA 逾時可能已受理，因此不自動移除 claim 或重送。需先由管理人員核對 OA 單據結果，再決定後續處理；不能靠重啟服務解鎖。
- claim 包含租戶與對話 ID，在 session 舊快取或程序重啟後仍會擋重複。它不依賴遠端 OA 是否支援 Idempotency-Key。
- file 模式必須把 `OA_AGENT_DATA_DIR` 放在持久磁碟，並與 sessions 一起保存；不同主機不能各自用獨立檔案目錄來宣稱共享防重複機制。多程序／主機的共同 claim 應使用 DB 模式。
- 安全 claim 分兩類。**送出防重與 refresh 使用紀錄永不自動清除**，避免有效 Token 重放或歷史申請重送——營運需監控其大小；清理需先制定 Token 最大登入期限與申請封存政策，不能直接截斷此表／刪除目錄。**Assertion 的 `jti` 則帶到期時間並由排程回收**（同一張表／目錄，每 5 分鐘一輪，見 `server/src/lib/expiry-sweeper.ts`）：它最多只活 5 分鐘，不回收會無限累積。回收只是空間管理，不是安全邊界——兩類的讀取路徑都自行判斷到期，排程沒跑到時過期紀錄一樣不被採信。
- 專案其他 store 仍採記憶體加快照寫入，這次沒有將整個專案改為多實例資料一致性架構。租戶／權限設定管理仍按既有單一寫入實例部署；本次 DB 憑證讀取與 claim 是特別加強的安全路徑。

## 驗證

新增／更新測試涵蓋管理員 audience、密鑰遮蔽、跨租戶路由、固定秘密金鑰撤銷及重啟、未授權表單與權限撤回、同時送出、Agent／HTTP 共用防重複、OA 不確定錯誤、持久化失敗、Refresh 重用、密鑰恢復、租戶刪除與 DB 舊快取。

DB 單元測試使用 mock 驗證 SQL 參數化與錯誤行為；部署前仍須在目標資料庫套用 migration。測試不操作正式 OA 或正式資料庫。
