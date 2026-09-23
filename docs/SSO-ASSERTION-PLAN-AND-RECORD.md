# SSO Identity Assertion：實作規劃與記錄

| 項目 | 內容 |
| --- | --- |
| 文件目的 | 記錄 SSO handoff 由 HS256 對稱式共享密鑰改為 HyAgent Identity Assertion Protocol（RS256 / ES256 非對稱金鑰）的**動工前規劃**與**實際實作過程** |
| 讀者 | **僅限內部**。含工作量估算、風險評估與未完成項，不對外交付。要給整合方的是下面兩份 |
| 規範正本 | [HyAgent客戶網站自動登入規格.md](HyAgent客戶網站自動登入規格.md)（v1.0 定稿）。§0–§9 規劃當時對照的是它的前身 `tmp_hyagent_sdk/HyAgentSDK規格.md` v1.0-draft **2026-09-17 版**，該暫存目錄已不存在，內容已收進 repo |
| 對外文件 | [HANDOFF-SSO.md](HANDOFF-SSO.md)（簽章／換發契約）、[HyAgent客戶端整合手冊.md](HyAgent客戶端整合手冊.md)（客戶端工程師操作版） |
| 參考實作 | 規劃階段對照 `tmp_hyagent_sdk/HyAgentSDK(js)/`（零相依，**53 項測試**：verifier 33 + assertion 12 + keygen 8）。該目錄已不存在；移植後的正式實作見 `server/src/lib/assertion/` 與 `sdk/src/assertion.ts` |
| 前提 | **本產品無既有客戶**，因此不做雙軌並行或遷移觀察期，採直接替換 |
| 狀態 | **已完成並落地於本 repo**（commit `3e91222`、`ae0058c`）。規格的規範性內容已全數實作並由測試涵蓋；尚未完成的兩項見 §11.6 |

> **怎麼讀**：**§0–§9 是動工前的規劃**，刻意保留當時原貌——包含後來被推翻的判斷、已作廢的選項與工作量估算。它們記錄的是「當時憑什麼這樣決定」，不是現況，**不要當作現行行為的依據**。
> **§10 是驗收標準與實際達成狀況**，**§11 是實作記錄**（逐階段的實際做法、施工中發現的缺陷、改掉的自己的決定）。
> 想知道「現在怎麼運作」看 §11 與上表的三份文件；想知道「為什麼長成這樣」才回頭看 §0–§9。
>
> **章節編號有兩套**：內文的 `§n` 多半指**規格**的章節（通常寫作「規格 §n」），少數指本文自身。兩者在 §11 附近會撞號——例如「規格 §11.1」講的是逐租戶設定收斂，本文 §11.1 講的是線 A 驗證器移植。引用時請看前後文。

---

## 0. 本次規格更新對評估的影響

規格自上版評估所對照的版本（`cf23487`）後共 8 次修訂，原附錄 B 的 10 項待確認事項**已全數定稿** —— 最後 2 項於本輪回饋後拍板：npm 套件名沿用 `@hyagent/sdk`，SDK 載入路徑採 `https://{hyagent-host}/sdk/widget.js`（單一可變路徑、不含版本號、**不強制 SRI**，見 §7.2）。該附錄隨之自規格移除，規格狀態列改為「規範性內容已全數定稿，無未決事項」；規格內硬寫的部署網域亦改為 `{hyagent-host}` 佔位符（§1.4）。對本評估結論有實質影響的變動如下，依影響程度排序。

| # | 規格變動 | 章節 | 對本專案的影響 |
| --- | --- | --- | --- |
| 1 | HyAgent Session **必須**為伺服器端有狀態儲存，**不得**為 self-contained JWT，且**必須**記錄建立時驗證通過的 `kid`（並註明此欄位必須自第一版即納入 schema） | §7.1、§2.6 | **推翻上版決策 C**。現行 access token 正是 self-contained HS256 JWT，必須改造。新增 4–6 人日 |
| 2 | Clock skew 由「不容忍」改為**預設 15 秒、逐 Tenant 可設 0～30 秒且不得超過有效期 ¼**，並要求記錄偏移量、超過容忍值一半即告警 | §10.4、§4.3、§8.4 | **推翻上版「已相容，無需變動」的判斷**。從零成本變成新功能（逐租戶設定 + 可觀測性）。新增 1.5–2 人日 |
| 3 | 新增 §7.4「以 `sub` 批次作廢 Session」（僅後台 UI），含操作順序、冪等與稽核規範 | §7.4、§10.5 | 全新功能，後端 + admin UI 皆需新增。新增 1–1.5 人日 |
| 4 | 撤銷傳播的實作要求明文化：公鑰與 Session 查詢快取 TTL **≤ 30 秒**、撤銷狀態**必須**讀 primary、長連線須定期重檢授權 | §2.6 | 現行 `tenantStore` 的記憶體 Map 在多副本部署下等同**無限 TTL 快取**，需處理。新增 1–1.5 人日 |
| 5 | 版本策略大改：**不設協定版本**，破壞性變更改以**逐 Tenant 設定收斂**；後台**必須**呈現各 Tenant 現行設定值並標示尚未收斂者 | §11.1 | 上版「並行期暫緩」的決策失去對象；改為需要一個租戶設定總覽面板。新增 1–1.5 人日 |
| 6 | 每租戶公鑰上限由 3 把改為 **2 把 `active`**，並新增不變條件（恆保有至少 1 把 `active`、停用最後一把須拒絕、重複 `kid` 視為冪等） | §2.5、§7.3 | 金鑰模型多了狀態機約束與 2 個管理端錯誤碼。租戶金鑰模型 +1 人日 |
| 7 | 大小上限定稿 4096 bytes，且**必須置於任何解碼與驗章之前**（新編為步驟 0）；驗證規則由 21 項變 **22 項（步驟 0–21）** | §4.2.4、§8.0 | 參考實作已同步調整，移植成本不變，但驗收基準的數字與順序要求需更新 |
| 8 | 錯誤碼定稿**保留細分代碼**；新增管理端 3 碼；新增「客戶**不得**將代碼直接顯示給終端使用者」的規範 | §9、§7.5 | 與上版建議一致。需在 SDK 文件與 `onError` 契約中載明呈現義務 |
| 9 | 公鑰管理與 Session 管理定稿為**僅後台 UI，不對外開放 API** | §7.3、§7.4 | 與上版建議一致，省下對外管理憑證的設計與保管 |
| 10 | Session `expiresIn` 定稿：預設 3600，Tenant 得設 300～28800，且**應該**不長於客戶自家 session | §7.1、§10.5 | 需做成逐租戶設定（併入 #1 的改造） |
| 11 | 參考實作測試由 48 項增為 **53 項**（新增 5 項 clock skew）；附錄 A.3 必要測試案例由 18 增為 **23** | 附錄 A | 驗收基準數字更新 |
| 12 | §12.2「HyAgent 端」檢核清單由 9 項增為 **18 項** | §12.2 | 驗收基準更新 |

**淨效果**：「換演算法」本身的成本完全沒有改變 —— 新增的要求全部落在**撤銷語意、時間語意與營運可觀測性**。上版「真正的工作量落在規格順帶要求的事」這個判斷不但成立，而且這類要求又多了一批。

有一項是**淨簡化**：規格的續期模型（§7.1「到期前 60 秒由 SDK 重走 token provider」）根本不需要 refresh token，因此 SSO 路徑上現行的 refresh 輪替、`family` 家族撤銷與 reuse detection 可整套移除 —— 這抵銷了 #1 的一部分成本（帳密登入路徑仍需保留）。

---

## 1. 結論

**仍然可行。** 換演算法本身依舊不是難點：`jsonwebtoken@9` 原生支援 RS256 / ES256，現行驗章只有單一進入點。工作量落在規格順帶要求的五件事：

1. **kid 金鑰管理** —— 租戶的金鑰資料模型要從「單一密鑰欄位」變成「可輪替、可撤銷的公鑰集合」，並由後端強制執行上限 2 把、至少保留 1 把 `active` 的不變條件。
2. **jti 防重放** —— 現行完全沒有，但規格列為**必要**機制。
3. **Assertion 不得走 URL** —— 現行 widget 把 token 放在 iframe 的 query string，與規格 §10.1 **硬衝突**，必須改為 `postMessage`。
4. **Session 從 self-contained JWT 改為伺服器端有狀態儲存**（本次新增）—— 規格 §7.1 明文禁止 self-contained JWT，且 Session 紀錄**必須**帶 `kid` 才能支援 §2.6 的批次作廢。規格特別註明此欄位必須自第一版即納入 schema，**事後補建無法涵蓋既有 Session**，因此不能延後。
5. **時間與撤銷的營運面**（本次新增）—— 逐租戶 clock skew 設定與偏移可觀測性（§10.4）、撤銷傳播的快取與 primary 讀取要求（§2.6）、逐租戶設定總覽面板（§11.1）。

第 3 項與「對稱換非對稱」無關，卻仍是單一項目中工作量最大的一塊，且它本身就是現行實作的實質安全缺口，無論是否換演算法都應該修。

第 4 項是本次規格更新帶來的最大變化，它使上版「內部 token 不需變動」的結論失效。所幸現行的 `requireAuth` **每次請求都呼叫 `validateIdentity()`**（[require-auth.ts:12](../server/src/middlewares/require-auth.ts#L12)），撤銷語意本來就是即時的、沒有快取，已滿足規格 §2.6 第 4 條；真正缺的是「Session 有伺服器端紀錄、紀錄上帶 `kid`、可依 `kid` 或 `sub` 批次作廢」這個能力。

由於無既有客戶，可以直接拔除 HS256 路徑，不必保留相容層 —— 這同時省下約 2–3 人日的雙軌實作，以及整段客戶遷移溝通與觀察期。

總工作量估計 **約 25–37 人日**（§8），較上版的 15–22 人日上修約 10–15 人日，全部來自 §0 表中的 #1～#5。

---

## 2. 評估範圍

| 涵蓋 | 不涵蓋 |
| --- | --- |
| Assertion 的簽發、傳遞、驗證全鏈路 | LLM / 知識庫 / 表單等業務邏輯 |
| 租戶公鑰的儲存、輪替、撤銷與其不變條件 | 平台管理員登入（`signAdminToken`，獨立 audience） |
| widget ↔ iframe 的身分傳遞方式 | 對話資料模型 |
| **HyAgent Session 的儲存模型與作廢機制**（本次納入，見 §0 #1、§6.2.1） | 部署與基礎設施（KMS 佈建） |
| **逐租戶設定（clock skew、`expiresIn`）與其後台呈現**（本次納入） | 帳密登入路徑的 refresh 輪替機制（維持現狀；但 `requireAuth` 會因需同時支援兩種憑證形式而變動，見 §7.3 決策 G） |

---

## 3. 現況實作盤點

> **本節是改造「前」的快照**，描述的是已經被拔除的 HS256 共享密鑰機制。所列檔案位置與行號為**當時**狀態，部分檔案此後已搬移（`client/public/widget.js` → `client/public/sdk/widget.js`）或不再存在（`ssoSecret` / `ssoVersion` / `signUserToken`），連結點下去看到的會是改造後的內容。現行結構見 §11。
>
> 當時這段機制在 `docs/HANDOFF-SSO.md` 有完整說明；該文件已於本案改寫為 Identity Assertion 契約，**不再描述本節內容**。

摘要如下。

### 3.1 信任鏈

```
整合方後端（持有 ssoSecret）
  └─ signUserToken()  HS256 / iss=hyagent:handoff / aud=hyagent:sso / exp ≤ 300s
        └─ 前端：data-user-token 或 data-token-url
              └─ widget.js 轉成 iframe query：?userToken=<jwt>
                    └─ POST /api/auth/sso/exchange（帶 x-api-key: pk_…）
                          └─ 後端以租戶 ssoSecret 驗章 → 簽發自家 access / refresh token
```

### 3.2 關鍵位置

| 職責 | 位置 |
| --- | --- |
| 驗章（唯一進入點） | [auth.service.ts:74](../server/src/modules/auth/auth.service.ts#L74) |
| 換發後的內部 token | [jwt.ts](../server/src/utils/jwt.ts)（HS256 self-contained，**本次起需變動**，見 §6.2） |
| 每請求身分重驗 | [require-auth.ts:12](../server/src/middlewares/require-auth.ts#L12)（每次請求都 `validateIdentity()`，無快取） |
| 密鑰撤銷鏈 | [credential-version.ts](../server/src/modules/auth/credential-version.ts) |
| 租戶密鑰欄位 | [tenant.types.ts:50](../server/src/modules/tenant/tenant.types.ts#L50)（`ssoSecret` / `ssoVersion`） |
| 租戶讀取（**記憶體 Map**） | [tenant.store.ts:301](../server/src/modules/tenant/tenant.store.ts#L301) 的 `getTenant`，見 §6.4 |
| 密鑰落地加密 | `tenant.store.ts` 的 `sealTenant` / `unsealTenant` |
| 簽發端 SDK | [server.ts](../sdk/src/server.ts) 的 `signUserToken` / `verifyUserToken` |
| token 進 URL | `client/public/widget.js:120`（檔案已搬至 [`client/public/sdk/widget.js`](../client/public/sdk/widget.js)）→ [embedConfig.ts:47](../client/src/embedConfig.ts#L47) |
| Origin 白名單 | [tenant.service.ts:39](../server/src/modules/tenant/tenant.service.ts#L39)（目前僅供 CORS 使用） |
| 管理介面 | [admin.schema.ts:10](../server/src/modules/admin/admin.schema.ts#L10)、[SettingsTab.tsx](../admin/src/pages/tabs/SettingsTab.tsx) |
| 現有測試 | `server/tests/auth-sso.test.ts`、`server/tests/security-regressions.test.ts` |
| 示範站台 | `presale/widge-tenant/`、`presale/sdk-custom-ui/`（皆持有 `TENANT_SSO_SECRET`） |

### 3.3 現行 Session 模型（本次新增盤點）

| 項目 | 現況 |
| --- | --- |
| access token | HS256 **self-contained** JWT，`aud=hyagent:user`，預設 **15 分鐘**（`JWT_ACCESS_EXPIRES_IN`） |
| refresh token | HS256 self-contained JWT，`aud=hyagent:refresh`，預設 **7 天**，含 `jti` + `family`，輪替並偵測重用 |
| 伺服器端狀態 | **無 Session 紀錄**。僅有 `securityClaims` 記錄 `refresh-used:` / `refresh-revoked:` 兩類 claim |
| 撤銷機制 | `credentialVersion`（租戶密鑰的 HMAC）寫進 token，每次請求由 `validateIdentity()` 重算比對 |
| 撤銷生效時間 | **即時**（每請求都重查租戶，無快取） |
| 是否帶 `kid` | 無此概念 |
| 長連線 | 無 SSE / WebSocket（已確認 `server/src` 無 `text/event-stream`、`WebSocket` 相關實作），§2.6 第 5 條目前不適用 |

---

## 4. 差異對照

標示 🆕 者為 2026-09-17 規格更新後才出現或性質改變的項目。

| 面向 | 現況 | 規格（2026-09-17） | 性質 |
| --- | --- | --- | --- |
| 演算法 | HS256 + 租戶 `ssoSecret` | RS256（≥2048）/ ES256（P-256）+ 租戶公鑰 | 破壞性 |
| 金鑰保管 | HyAgent 保存共享密鑰（AES 落地加密） | HyAgent 只存公鑰，**不持有任何客戶私鑰** | **安全性淨改善** |
| 金鑰識別 | 單一密鑰，無 `kid` | `kid` = RFC 7638 JWK Thumbprint | 資料模型變更 |
| 公鑰數量 | 1 把密鑰 | 🆕 **最多 2 把 `active`**，且恆保有至少 1 把；上限與「不得停用最後一把」須由**後端**強制 | 新增狀態機 |
| `iss` | `hyagent:handoff`（固定） | Tenant ID（每租戶不同） | 破壞性 |
| `aud` | `hyagent:sso` | `hyagent`（🆕 明文**不得**兼作版本標記） | 破壞性 |
| 租戶解析 | 靠 `x-api-key`（`pk_`） | 靠 `iss` + `kid` 查表 | 語意變更，見 §6.3 |
| 有效期 | ≤ 300s（`maxAge` 5m） | 建議 60s、上限 300s | 已相容，只需收緊建議值 |
| clock skew | 不放寬（已檢查 `iat > now`） | 🆕 **預設 15s**，逐租戶可設 0～30s，且 **≤ 有效期 ¼**；另須記錄偏移量並告警 | ⚠️ **由「已相容」翻轉為新增**，見 §6.5 |
| 防重放 | **無** | `jti` 一次性紀錄為**必要** | 新增 |
| Origin 檢查 | 僅 CORS 層（瀏覽器閘門，非瀏覽器請求可繞過） | 伺服器端逐租戶檢查（§8.6 步驟 21） | 新增 |
| Assertion 傳遞 | **iframe query string** | **明文禁止放入 URL**（§10.1） | ⚠️ 衝突 |
| Token provider | `data-user-token` 靜態 + `data-token-url` 端點 | **必須**為函式，禁止快取，10 秒逾時，指數退避重試 | 部分相容 |
| 大小上限 | 無 | 🆕 4096 bytes，且**必須為驗證流程的第一步**（步驟 0，先於解碼與驗章） | 新增（含順序要求） |
| 驗證步驟總數 | 不適用 | 🆕 **22 項（步驟 0–21）**（上版為 21 項） | 驗收基準更新 |
| 錯誤碼 | 通用 `AppError` | 16 種驗證碼 + 🆕 3 種管理端碼（`KEY_LIMIT_EXCEEDED` / `LAST_ACTIVE_KEY` / `INVALID_REQUEST`） | 新增 |
| 錯誤呈現 | 無規範 | 🆕 客戶**不得**將 `error` / `message` 直接顯示給終端使用者（§7.5） | 新增（文件與 SDK 契約） |
| **Session 儲存** | self-contained HS256 JWT（access 15m + refresh 7d） | 🆕 **不透明字串；必須為伺服器端有狀態儲存，不得為 self-contained JWT** | ⚠️ **破壞性**，見 §6.2 |
| **Session 帶 `kid`** | 無此概念 | 🆕 **必須**記錄建立時驗證通過的 `kid`，並支援以 `kid` 批次作廢；**必須自第一版即納入 schema** | 新增（不可延後） |
| Session 效期 | `JWT_ACCESS_EXPIRES_IN` 固定 15m | 🆕 `expiresIn` 預設 3600，逐租戶可設 300～28800 | 新增逐租戶設定 |
| Session 續期 | refresh token 輪替（7 天家族） | 🆕 到期前 60 秒由 SDK **重走 token provider**，不需 refresh token | SSO 路徑可**簡化** |
| Session 作廢（依 `sub`） | **無** | 🆕 §7.4 必要功能，僅後台 UI，60 秒內生效，冪等回 200 | 新增 |
| 撤銷傳播 | 每請求重查（db 模式走 DB；file 模式走記憶體 Map） | 🆕 公鑰與 Session 查詢快取 TTL **≤ 30s**；撤銷狀態**必須讀 primary** | 部分相容，見 §6.4 |
| 長連線授權重檢 | 無 SSE / WebSocket | 🆕 若採用，**必須**每 30 秒重檢或撤銷時主動中斷 | 目前不適用，設計時須遵守 |
| 管理介面 | 密鑰輸入框 | 🆕 公鑰清單 + Session 作廢 + **逐租戶設定總覽（標示偏離預設者）** | 新增 3 塊 UI |
| 協定版本 | 無 | 🆕 **明文不設協定版本**；破壞性變更以逐租戶設定收斂，通知期 ≥ 12 個月（安全性驅動得縮至 90 天） | 決策取代 |
| SDK 載入路徑 | `/widget.js`（根目錄、無版本） | 🆕 `https://{hyagent-host}/sdk/widget.js` —— 單一可變路徑、不含版本號，`Cache-Control` 的 `max-age` **≤ 5 分鐘**；**不強制 SRI** | 路徑搬移 + 快取設定 |

> `data-token-url` 的設計（面板首次開啟時才向宿主後端取票）在概念上已經等同規格 §6.5 的 token provider，方向正確；需要淘汰的是 `data-user-token` 靜態那條路徑 —— 規格 §6.5 專門用一整節說明為何靜態字串不可行。

---

## 5. 可直接複用的既有機制

這是本案成本低於「從零實作規格」的主要原因。

| 規格要求 | 現有基礎 | 落差 |
| --- | --- | --- |
| §8.5 `jti` 需**原子**寫入 | [security-claims.ts](../server/src/lib/security-claims.ts) 已是原子 claim（db 模式 `INSERT … ON CONFLICT DO NOTHING`；file 模式以 `wx` 旗標開檔） | **缺 TTL** —— jti 每 5 分鐘一筆會無限累積，file 模式是一個 jti 一個檔案。需補過期清理 |
| §2.6 撤銷須連帶作廢既有 Session | `ssoVersion` + `credentialVersion()` 已實作此語意 | 只需把 key 從「租戶密鑰」換成「kid」，語意幾乎一對一映射 |
| 🆕 §2.6 第 4 條：Session 驗證**不得**用 TTL > 30 秒的快取 | `requireAuth` **每次請求**都呼叫 `validateIdentity()`，完全無快取 | **已達標**。規格擔心的「把 Session 快取進行程記憶體」這個最佳化，本專案從未做過 |
| 🆕 §11.1：驗證**不得**因未知 claims 而失敗 | 現行 `ssoExchange` 只讀取它認得的 claims，不做白名單 | **已達標**，只需在測試中固定此行為 |
| 🆕 §2.6 第 5 條：長連線須定期重檢 | 專案無 SSE / WebSocket（已確認） | **目前不適用**；未來導入串流回應時須一併設計 |
| 新增 `publicKeys[]` 欄位 | 租戶穩定欄位之外皆存於 `config` jsonb（見 `server/prisma/schema.prisma`） | **不需要 DB migration** |
| 🆕 Session 紀錄含 `kid` | **無現成基礎** | 需新建 session store，且規格要求此欄位自第一版納入 schema |
| §8.6 Origin 白名單 | `tenantService.isOriginAllowed(tenant, origin)` 已寫好 | 目前只餵給動態 CORS（[app.ts:48](../server/src/app.ts#L48)），接到換發端點只是幾行 |
| 速率限制 | `ssoRateLimit` 已存在 | 需補 `Retry-After` |
| 🆕 §8 全部 **22** 項驗證規則（步驟 0–21） | 參考實作 `HyAgentSDK(js)/src/hyagent-verifier.mjs`（零相依）+ **53 項測試**，已含步驟 0 與逐租戶 `clockSkewSeconds` | **可直接移植當驗收基準**，含 skew 參數化與 0～30 的建構期範圍檢查 |
| 敏感欄位落地加密 | `sealTenant` / `unsealTenant` | 改用公鑰後**這層對 SSO 不再需要**（公鑰本就可公開），`llmConfig` 仍需保留 |

### 5.1 演算法本身的實作成本極低

`jwt.verify(token, publicKey, { algorithms: [該 kid 註冊的 alg] })` 一行就滿足規格 §8.2 的 algorithm confusion 防護（依**註冊值**驗章，不信任 `header.alg`）。

規格 §2.1 特別警告的 ES256 `dsaEncoding: "ieee-p1363"` 陷阱**只影響簽發端**（直接使用 `node:crypto` 時），`jsonwebtoken` 內部已處理 R‖S 格式。我們要交付給客戶的 SDK 若照參考實作走零相依 `node:crypto`，才需要注意這點。

### 5.2 規格更新後可以少做的事

- **SSO 路徑的 refresh token 機制可整套移除**：規格 §7.1 的續期是「到期前 60 秒重走 token provider」，不存在 refresh token。`family` 家族撤銷、reuse detection、`refresh-used:` / `refresh-revoked:` claim 在 SSO 路徑上都不再需要（帳密登入路徑保留）。
- **公鑰與 Session 管理不需對外 API**（§7.3、§7.4 定稿為僅後台 UI）：省下一組對外管理憑證的配發、保管與輪替設計。

### 5.3 可以刪掉的東西

無既有客戶意味著這些可以直接移除，不留相容層：

- `Tenant.ssoSecret`、`Tenant.ssoVersion` 欄位
- `sealTenant` / `unsealTenant` 中對 `ssoSecret` 的加解密分支
- `sdk/src/server.ts` 的 `signUserToken` / `verifyUserToken`
- `sdk/` 對 `jsonwebtoken` 的相依（改用 `node:crypto` 後可完全移除，套件變成零相依）
- admin 的 `ssoSecret` 輸入框與 `ssoConfigured` 旗標
- `presale/*/.env` 的 `TENANT_SSO_SECRET`
- 🆕 SSO 路徑的 refresh token 簽發與輪替（見 §5.2）

---

## 6. 風險與難點

依嚴重度排序。§6.2、§6.4、§6.5、§6.6 為本次規格更新後新增或升級的風險。

### 6.1 【高】Assertion 走 query string

當時的 `client/public/widget.js:120`（該檔已搬至 [`client/public/sdk/widget.js`](../client/public/sdk/widget.js)）把 token 以 `?userToken=` 附在 iframe URL 上，會殘留於瀏覽器歷史、`Referer` header 與伺服器存取日誌。規格 §10.1 明文禁止。

正確做法是規格 §6.6 的 `postMessage` 握手（`handshake` → `identity:request` → `identity:response`），雙向驗證 `event.origin` 與 `event.source`，且**不得**使用 `targetOrigin: "*"`。

涉及 `client/public/widget.js`、`client/src/App.tsx`、`client/src/embedConfig.ts` 與相關測試。**這是單一項目中工作量最大的一塊**，且與演算法改動正交 —— 可以由不同人並行進行。

### 6.2 🆕【高】Session 模型必須從 self-contained JWT 改為伺服器端有狀態

規格 §7.1 新增一條：Session **必須**為伺服器端有狀態儲存、**不得**為 self-contained JWT，並**必須**記錄建立時驗證通過的 `kid`。現行 access token 正是 self-contained HS256 JWT（[jwt.ts](../server/src/utils/jwt.ts)），直接牴觸。

要做的事：

| 項目 | 說明 |
| --- | --- |
| 新建 session store | `sessionToken` 為不透明隨機字串；紀錄至少 `tenantId` / `sub` / `kid` / `createdAt` / `expiresAt`；需以 `kid` 與 `sub` 兩個維度可批次作廢 |
| `kid` 欄位不可延後 | 規格明文「**必須自第一版即納入 schema，事後補建無法涵蓋既有 Session**」。這使它成為 Phase 1 的必辦項，不能排到後面 |
| `expiresIn` 逐租戶 | 預設 3600，範圍 300～28800（現行是全域固定 15 分鐘） |
| 續期改走 token provider | SSO 路徑移除 refresh token（§5.2），改由 SDK 到期前 60 秒重新取 Assertion |
| `requireAuth` 改造 | 由 `verifyAccessToken()` 改為查 session store；`validateIdentity()` 的租戶重查邏輯保留 —— 它正是 §2.6 第 4 條要的「無快取」 |

**風險控制**：現行的 `credentialVersion` + 每請求重查已提供**等效於規格要求的即時撤銷語意**，因此這次改造不是補安全漏洞，而是補**能力**（依 `kid` / `sub` 批次作廢）與**形式**（對 Widget 不透明）。既有安全性不會在改造中退化，前提是 session 查詢同樣不加快取。

現行的 access / refresh 雙 token 與 `family` reuse detection 在帳密登入路徑仍需保留，因此兩套模型會並存 —— 這是本項工作量的主要來源。

### 6.2.1 🆕 session store 設計（定稿）

決策 B、F 的定稿內容。**auth session store 不得照抄既有兩個 store 的 write-through 模式** —— 這是本項最容易踩的坑。

**讀取路徑**

| 模式 | 讀取路徑 | 合規性 | 原因 |
| --- | --- | --- | --- |
| **file** | 記憶體 Map | ✅ | 單一進程，**Map 本身即 primary**，不是快取，沒有複本可落後 |
| **db** | **每次查 DB** | ✅ | §2.6 第 2、4 條要求讀 primary 且快取 TTL ≤ 30 秒 |
| db（若照抄 `tenantStore` 的 write-through） | 記憶體 Map | ❌ | 多副本下他副本的撤銷永不傳播 —— 與 §6.4 是同一個坑 |

file 模式在這件事上**天生合規** —— 它的單副本假設讓 §2.6 的快取條款自動滿足。db 模式若擔心每請求查一次 DB 的成本，規格留了逃生門：得加 TTL **≤ 30 秒**的快取，但不得更長。

**file 模式的持久化**：沿用 `tenantStore` 的「記憶體 Map + 單一 JSON 快照檔」，但有四處必須偏離既有寫法：

| # | 規則 | 理由 |
| --- | --- | --- |
| a | **不得**使用 `securityClaims` 的「一個 key 一個檔」模式 | 該模式無 TTL、檔案數無限增長，§5 已列為現有缺口，不該再複製一份 |
| b | `sub` **不以明文落檔**，改存 `subHash`（HMAC） | §7.4 的作廢是等值比對，雜湊即足夠；`dataFile` 預設落在 `os.tmpdir()`，明文使用者識別碼不該躺在系統暫存目錄。db 模式一併採用，可降低 DB 外洩的暴露面。後台若需顯示原始 `sub`，改用既有 `encryptSecret` 加密而非雜湊 |
| c | 兩模式都要 TTL 清理 | file：讀取時 lazy 過濾 + 定期 sweep 後重寫快照；db：`expiresAt` 欄位 + 定期 `deleteMany` |
| d | boot 時 `DATA_BACKEND=file` 且 `NODE_ENV=production` 應 fail-fast | file 模式本就不支援多副本（`wx` 檔案鎖、記憶體 Map 皆為單副本假設），但目前沒有明講；auth session 加入後風險升高 |

**索引設計**（支援依 `kid` 與 `sub` 批次作廢）

| 用途 | file | db |
| --- | --- | --- |
| 主索引 | `Map<token, session>` | `@id token` |
| 依 `kid` 作廢（§2.6） | `Map<kid, Set<token>>`，開機重建 | `@@index([kid])` |
| 依 `sub` 作廢（§7.4） | `Map<tenantId:subHash, Set<token>>`，開機重建 | `@@index([tenantId, subHash])` |
| 過期清理 | lazy 過濾 + 定期 sweep | `@@index([expiresAt])` |

**命名**：資料表**不得**叫 `SessionRow` / `sessions` —— 已被**對話** session 佔用（`server/prisma/schema.prisma:39`，欄位為 `formId` / `data`）。用 `AuthSessionRow` / `auth_sessions`，避免兩種語意完全不同的 session 在程式碼裡混淆。

**連帶影響 jti store（決策 B 改判）**：session 既然進 DB 且需要一支 sweep 排程，jti 改放 DB（`security_claims` 加 `expires_at`）共用同一支 sweep 即可，**不需要 Redis**，少一個正式環境相依與一套維運。原先建議 Redis 是為了 `SET NX EX` 的 TTL 語意，但在已有 sweep 的前提下這個優勢消失。

**file 模式重啟登出不是問題**：規格 §7.1 的續期模型讓 SDK 收到 `401` 就重走 token provider，使用者若在客戶網站仍登入會自動重建 session —— 不像對話 session 會真的掉資料（`conversation.store.ts` 落檔的理由不適用於此）。file 模式落檔純粹是為了 `tsx watch` 頻繁重啟時的開發體驗。

### 6.3 【中】租戶解析的權威來源

現行由 `pk_` API Key 決定租戶（[resolve-tenant.ts](../server/src/middlewares/resolve-tenant.ts)），規格則由 `iss` 決定。兩者若並存而**未交叉檢查**，會開出跨租戶混淆的漏洞。

**無客戶的情況下建議直接做對**：換發端點一律以 `iss` 為租戶的權威來源，`pk_` 降級為外觀設定與 CORS 用途，不參與身分判定。這樣就完全不需要交叉檢查邏輯，也少一條攻擊面。

### 6.4 🆕【中】撤銷傳播：記憶體 Map 在多副本部署下等同無限 TTL 快取

規格 §2.6 新增的實作要求中，第 1、2 條最需要注意：公鑰與撤銷狀態的查詢**不得**使用 TTL > 30 秒的快取，且**必須**自 primary 讀取、不得讀可能有複寫延遲的 read replica。

現行 `tenantStore` 是「記憶體 Map + 持久化 write-through」：

| 路徑 | 現況 | 是否合規 |
| --- | --- | --- |
| `validateIdentity()`（db 模式） | 直接 `db.tenantRow.findUnique` | ✅ 每請求查 DB，無快取 |
| `validateIdentity()`（file 模式） | 讀記憶體 Map | ⚠️ 單副本沒問題，多副本下他副本的撤銷永不傳播 |
| `tenantService.resolve()` / `getTenant()` | 一律讀記憶體 Map（開機載入） | ⚠️ 同上 |

也就是說：**多副本部署下，在 A 副本撤銷公鑰，B 副本在重啟前都還會繼續接受該 `kid`** —— 這是無限 TTL，遠超規格的 30 秒上限。需要處理的是把換發端點的公鑰查詢改為 primary 直查（或加 ≤ 30 秒 TTL 且確認讀 primary 的快取），而不是沿用記憶體 Map。

規格同段第 5 條（長連線每 30 秒重檢授權）目前不適用 —— 專案無 SSE / WebSocket。但**串流回應是聊天產品的常見後續需求**，導入時須一併設計，否則撤銷前已建立的連線可繞過上述所有機制。

### 6.5 🆕【中】clock skew 由「零成本」翻轉為新功能

上版評估把 clock skew 列為「已相容，無需變動」—— 因為當時規格是「不放寬」，而現行實作也不放寬。規格 §10.4 改為**預設容忍 15 秒**後，這一項變成需要新建的功能：

| 要求 | 工作內容 |
| --- | --- |
| 逐租戶設定 | 後台可設 0～30 秒，且**不得**超過該租戶 Assertion 有效期的 ¼（以建議的 60 秒計，上限即 15 秒）。**不得**由請求參數傳入 |
| 驗證器套用 | 步驟 14（`iat <= now + skew`）與 15（`exp > now - skew`）；步驟 16 的 `exp - iat` **不套用** skew |
| 可觀測性（規範性） | 每次驗證記錄觀測到的偏移量 `now - iat`（僅數值，不記 claims 內容）；偏移絕對值超過容忍值**一半**時**必須**告警並於後台顯示；後台**應該**呈現各租戶近期偏移分佈 |

參考實作已提供 `clockSkewSeconds`（預設 15、上限 30，超範圍於建構時丟 `RangeError`），移植成本低；**成本集中在後台設定與偏移監測那一段**，這是純新增的產品功能。

### 6.6 🆕【中】§11.1 的「逐租戶設定收斂」帶來一塊後台功能

規格改為**不設協定版本**後，破壞性變更一律以逐租戶設定表達，並要求後台**必須**呈現各租戶現行設定值、標示偏離預設與尚未完成收斂者。目前已定義的逐租戶設定有三項（公鑰演算法、clock skew、`expiresIn`），都需要進到這個面板。

這一項容易被當成「以後再說」而漏掉，但規格把它列為規範性要求，理由也直白：沒有儀表板的期限只是把斷崖往後挪。

### 6.7 【中】公鑰管理是新功能，且新增了不變條件

admin 目前是單一密鑰輸入框，需改為公鑰清單：上傳 PEM / JWK → 後端計算 `kid` → 列表顯示狀態（`active` / `disabled` / `revoked`）→ 停用 / 撤銷。後端需新增 RFC 7638 `computeKid()`（參考實作 `hyagent-keygen.mjs` 有現成的 68 行版本）。

🆕 規格 §7.3 另要求由**後端**（不得僅在 UI 層）強制下列不變條件：

| 條件 | 行為 |
| --- | --- |
| `active` 已達 2 把時再上傳 | 拒絕，`KEY_LIMIT_EXCEEDED`（409） |
| **停用**最後一把 `active` | 拒絕，`LAST_ACTIVE_KEY`（409） |
| **撤銷**最後一把 `active` | 允許（安全優先於可用性），但**必須**二次確認 |
| 上傳的 `kid` 已存在於同一租戶 | 冪等，回傳既有 `kid` 與狀態，不新增一筆 |

撤銷 UI 另**必須**於執行前明示「會一併登出以該 `kid` 建立的所有 Session，包含未受影響的正常使用者」。

### 6.8 【低】規格已無未決事項

原附錄 B 的 10 項**已全數定稿，該附錄已自規格移除**（定稿值都已寫在各自的規範章節裡，留著只是重複來源、徒增互相矛盾的風險）。最後 2 項於本輪回饋後拍板：npm 套件名稱沿用 `@hyagent/sdk`、SDK 載入路徑採 `/sdk/widget.js`（單一可變路徑、不強制 SRI），規格 §1.4、§5.3、§6.1、§11.1 均已同步更新。其餘 8 項中，5 項與上版我方建議一致，2 項規格採了更嚴或相反的值（公鑰上限 3→2、clock skew 不容忍→容忍 15 秒），1 項（版本策略）改採完全不同的作法。對照見 §7.1。

### 6.9 【低】知識庫 ACL 的安全論述會變強

`docs/superpowers/specs/2026-08-25-knowledge-acl-design.md` 目前寫著「這套 ACL 的強度上限等於 `ssoSecret` 的保管強度」。改為非對稱後，這句話變成「等於客戶私鑰的保管強度」，而私鑰**從不離開客戶環境**、HyAgent 端也不再持有任何可偽造身分的秘密 —— 這是真實的安全改善，值得在該文件與對外說帖中同步更新。

---

## 7. 決策（已全數定稿）

### 7.1 規格原附錄 B：已定稿的 8 項

上版評估時規格附錄 B 有 10 項待確認，本版**已全數定稿**，該附錄亦已自規格移除。與上版我方建議的對照：

| # | 項目 | 規格定稿值 | 與上版我方建議 | 本專案動作 |
| --- | --- | --- | --- | --- |
| 3 | 每租戶公鑰數上限 | **2 把 `active`**（上版暫定 3） | 我方原採用 3 | **改為 2**，並由後端強制不變條件（§6.7） |
| 4 | 撤銷生效時間 / 是否連帶作廢 Session | 60 秒；**必須**連帶作廢，且新增 5 條實作要求 | 一致 | 現行 `credentialVersion` 已即時生效；缺的是依 `kid` 批次作廢與跨副本傳播（§6.2、§6.4） |
| 5 | Assertion 大小上限 | 4096 bytes，且**必須**為步驟 0 | 一致 | 採用，注意**順序本身即規範性要求** |
| 6 | HyAgent Session 有效期 | 預設 3600，租戶可設 300～28800 | 上版建議「維持現行 15 分鐘不動」 | ⚠️ **需改**：做成逐租戶設定（§6.2） |
| 7 | 公鑰管理 API 是否對外開放 | 僅後台 UI，不對外開放 | 一致 | 採用 |
| 8 | 錯誤碼是否收斂為 `INVALID_ASSERTION` | 保留細分代碼 | 一致 | 採用；另需落實 §7.5 的「不得直接顯示給終端使用者」 |
| 9 | 是否容忍 clock skew | **容忍，預設 15 秒**，逐租戶 0～30 秒（上版暫定不容忍） | 我方原採用「不容忍」 | ⚠️ **需改**：新增逐租戶設定與偏移監測（§6.5） |
| 10 | 破壞性變更並行期 | **改為不設協定版本**，以逐租戶設定收斂；通知期 ≥ 12 個月，安全性驅動得縮至 90 天 | 上版建議「暫緩」 | 決策作廢；改為實作 §11.1 的設定總覽面板（§6.6） |

**要點**：8 項中 5 項與我方建議一致，2 項規格採了與我方相反的值（#6、#9），1 項（#10）換了作法。需要重新拍板的只有 **#6 與 #9** —— 而兩者都已在 §6.2、§6.5 轉為工作項而非選項，規格用的是「**必須**」。

### 7.2 本輪定稿的 2 項（原附錄 B 最後剩餘項）

| # | 項目 | 規格原暫定值 | 定稿結果 |
| --- | --- | --- | --- |
| 1 | SDK 載入路徑 | `/sdk/v1/hyagent.js` | ✅ **定稿：`/sdk/widget.js`** —— 單一**可變**路徑，不含版本號，HyAgent 得就地更新以推送修補；`Cache-Control` 的 `max-age` 不得超過 5 分鐘。**不強制 SRI**（理由：託管被攻破時後端回應同樣可竄改，SRI 只保護單一檔案，卻換掉緊急修補能力）。不可變的精確版本路徑 `/sdk/{semver}/widget.js` + SRI 留待未來 minor 版本擴充 |
| 2 | npm 套件名稱 | `@hyweb/hyagent-sdk` | ✅ **定稿：`@hyagent/sdk`** —— 沿用現行套件名，避免多一次改名 |

> 兩項皆已寫入規格。**本專案的對應工作**：現行 widget.js 對外路徑為根目錄 `/widget.js`（見 `presale/widge-public/index.html`），需改為 `/sdk/widget.js`，並把該路徑的快取策略與 SPA 的 `/assets/*`（content-hash、immutable）分開設定。無既有客戶，改名成本為零。

### 7.3 本專案特有決策

全數定稿。**「依據」欄區分兩種性質**：規格強制者沒有選擇空間，不同意也得照做；本專案判斷者是我們在規格留白處選了一邊，日後有理由仍可推翻。

| 代號 | 決策 | 結論 | 依據 |
| --- | --- | --- | --- |
| A | `pk_` API Key 是否仍作為租戶身分來源？ | **否**。換發一律以 `iss` 為準，`pk_` 僅供外觀 / CORS（§6.3） | **規格強制** —— §8.4 步驟 10 要求 `iss` 等於 Tenant ID 且 `kid` 綁定該租戶，規格未賦予 API Key 任何身分角色 |
| B | jti store 放哪？ | **DB**（`security_claims` 加 `expires_at`），與 session store 共用清理排程，不引入 Redis | **本專案判斷** —— 規格 §8.5 只要求原子寫入與 TTL，不管存放位置。原建議 Redis，隨 F 一併改判（§6.2.1） |
| C | 內部 access / refresh token 是否改為不透明 `sessionToken`？ | **是**。翻轉上版「不需變動」的結論（§6.2） | **規格強制** —— §7.1 明文「必須為伺服器端有狀態儲存，不得為 self-contained JWT」 |
| E | 是否保留 HS256 相容層？ | **否**。直接拔除（§5.3） | **規格強制 + 本專案條件** —— §8.2 禁用 HMAC；且無既有客戶，相容層沒有服務對象 |
| F | session store 放哪？ | **DB 表 `auth_sessions`**。file 模式為記憶體 Map + 單一 JSON 快照，該 Map 即 primary；db 模式讀取路徑**不得**用記憶體 Map | **本專案判斷** —— 規格 §7.1、§2.6 只要求伺服器端有狀態、可依 `kid` / `sub` 批次作廢、快取 TTL ≤ 30 秒。完整設計見 §6.2.1 |
| G | 帳密登入路徑是否也改用 session store？ | **否**，維持現行 JWT。`requireAuth` 需同時支援兩種憑證形式 | **本專案判斷** —— 規格只規範 Widget 的 Session，未涵蓋此路徑 |
| H | clock skew 採規格預設的 15 秒，還是自行收緊為 0？ | **採 15 秒** | **規格預設** —— §10.4 已論證風險由 `jti` 承接；收緊到 0 會讓間歇性 `TOKEN_NOT_ACTIVE` 成為整合期最難診斷的客訴 |

> 原列於本表的 D（`postMessage` 改造是否同批進行）已移除 —— 那是人力與排程安排，不是技術決策，歸入 §9。

---

## 8. 工作量估算

🆕 標示者為本次規格更新新增或上修的項目。

| 模組 | 內容 | 人日 | 與上版 |
| --- | --- | --- | --- |
| 驗證器 | 移植規格 §8 全部 **22** 項檢查（步驟 0–21）+ §9 錯誤碼 + skew 參數 | 3–4 | 持平 |
| 租戶金鑰模型 | `publicKeys[]`、`computeKid()`、輪替、撤銷、store 讀寫，🆕 上限 2 把 / 至少 1 把 `active` / 冪等上傳的不變條件 | 3–4 | +1 |
| jti 防重放 | DB TTL store（`security_claims` 加 `expires_at`）+ 與 session 共用的清理排程 + 測試 | 1–2 | 持平 |
| 🆕 **Session 模型改造** | 不透明 `sessionToken`、伺服器端 session store（含 `kid`）、`expiresIn` 逐租戶、依 `kid` / `sub` 批次作廢、`requireAuth` 改造、SSO 路徑移除 refresh 輪替 | **4–6** | **新增** |
| 🆕 撤銷傳播 | 公鑰查詢改 primary 直查、快取 TTL ≤ 30 秒、多副本行為驗證 | **1–1.5** | **新增** |
| 🆕 Clock skew | 逐租戶設定（0～30 且 ≤ 有效期 ¼）+ 偏移記錄 / 告警 / 後台分佈 | **1.5–2** | **新增** |
| Origin 檢查與速率限制 | 接上既有 helper、補 `Retry-After` | 0.5 | 持平 |
| admin 公鑰管理 | 上傳 / 列表 / 停用 / 撤銷的 API 與 UI，🆕 撤銷前的影響告知與二次確認 | 2–3 | 持平 |
| 🆕 admin Session 作廢 | 依 `sub` 作廢的後端 + UI、冪等語意、稽核紀錄、操作順序說明 | **1–1.5** | **新增** |
| 🆕 admin 租戶設定總覽 | §11.1 可觀測性：各租戶現行設定值、標示偏離預設與未收斂者 | **1–1.5** | **新增** |
| 客戶端 SDK | `keygen` CLI + `issueAssertion()`，取代 `signUserToken`；🆕 `onError` 呈現義務的文件與範例 | 1–2 | 持平 |
| **`postMessage` 改造** | widget.js ↔ iframe 協定、移除 query token | **4–6** | 持平 |
| 拔除 HS256 路徑 | 刪欄位、刪 SDK 函式、清 admin UI | 0.5–1 | 持平 |
| 示範站與文件 | `presale/` 三站、`docs/HANDOFF-SSO.md` 改寫、`LOCAL-SETUP.md` 更新；🆕 widget.js 由 `/widget.js` 搬至 `/sdk/widget.js`（含三站 script src）與該路徑的快取設定 | 1–2 | 持平 |
| | **合計** | **約 25–37 人日** | 上版 15–22 |

不含：對外說帖、正式環境的 KMS 佈建。

**上修的 10–15 人日全部來自 §0 表的 #1～#5**，與「換演算法」無關 —— 它們是撤銷語意、時間語意與營運可觀測性的成本。

> **本表是動工前的估算，未與實績對照**——實際投入人日沒有逐項記錄。見 §9 末。

---

## 9. 建議實施順序

因為沒有既有客戶，切分的目的純粹是交付節奏，不是相容性。

| 階段 | 內容 | 產出 |
| --- | --- | --- |
| **Phase 0** | §7 定稿內容的簽核（非討論）。規格側與專案側皆已無未決事項 | 決策紀錄 |
| **Phase 1** | 後端核心：驗證器（22 項）、租戶公鑰模型與不變條件、jti 防重放、Origin 檢查，**同時拔除 HS256 路徑**；🆕 **session store 與其 `kid` 欄位須在此階段落地** | 換發端點改吃 Assertion，Session 有伺服器端紀錄 |
| **Phase 2** | 管理面（公鑰 UI / Session 作廢 / 租戶設定總覽）+ 客戶端 SDK（keygen、issueAssertion） | 可對外交付的整合包 |
| **Phase 3** | `postMessage` 改造，移除 query string token | 符合 §10.1 |
| **Phase 4** | 🆕 撤銷傳播驗證（多副本）與 clock skew 偏移監測上線 | 符合 §2.6、§10.4 的營運要求 |
| **Phase 5** | `presale/` 三站改用私鑰簽發、全套文件更新 | 可展示的端到端 demo |

🆕 **Phase 1 的範圍較上版擴大**：規格 §2.6 第 3 條明文「Session 紀錄的 `kid` 欄位**必須自第一版即納入 schema，事後補建無法涵蓋既有 Session**」。即使批次作廢的 UI 排到 Phase 2，**欄位本身不能延後**。

**Phase 3 與 Phase 1–2 沒有相依，建議開成獨立 workstream 並行**（原決策 D）。`postMessage` 改造只動 `client/`，與後端的演算法、金鑰、session 改造完全正交，兩邊不會互相卡住；人力若只有一位，則照階段順序走即可。

**簽核前即可開始的兩條線**（不相依於任何未完成事項）：

| 線 | 內容 | 為何可先開始 |
| --- | --- | --- |
| A | 驗證器移植：新建 `server/src/lib/assertion/`，22 項檢查 + `computeKid()` + 錯誤碼 | 純新增目錄，不碰既有程式碼，驗收基準（53 項測試）現成 |
| B | `postMessage` 改造（Phase 3） | 與演算法正交；且它本身就是現行實作的實質安全缺口，無論本案是否推進都該修 |

兩條線約 7–10 人日，佔總量三分之一。

**實際結果**（各階段的實際做法見 §11）：

| 規劃階段 | 結果 |
| --- | --- |
| 線 A、線 B | ✅ 完成（§11.1、§11.2） |
| Phase 0 簽核 | ✅ §7 決策全數定稿，施工中推翻了其中一項（`subEnc`，見 §11.4 末） |
| Phase 1 後端核心 + 拔除 HS256 | ✅ 完成（§11.3 三個 store、§11.4 接線切換） |
| Phase 2 管理面 + 客戶端 SDK | ✅ 完成（§11.4 公鑰 UI、§11.5 續期與 logout、`sdk/bin/keygen.mjs`） |
| Phase 3 `postMessage` | ✅ 完成——即線 B。如規劃所料與 Phase 1–2 正交，兩邊沒有互相卡住（§11.2） |
| Phase 4 撤銷傳播驗證 + skew 監測 | ⚠️ **部分**：skew 監測已上線；撤銷傳播的程式面已備齊，**多副本實測未做**（§11.6） |
| Phase 5 presale 三站 + 文件 | ✅ 完成（§11.4 三站改私鑰簽發、§11.5 文件校正） |

**實際投入人日未逐項記錄**，因此 §8 的 25–37 人日估算無法與實績對照——這是這份記錄的一個缺口，下次類案值得在動工時就順手記。

---

## 10. 驗收標準

> 以下 13 項為**動工前訂下的標準**，保留原貌。逐項的實際達成狀況見 §10.1。

1. 參考實作 `HyAgentSDK(js)/test/` 的 **53 項測試**（verifier 33 + assertion 12 + keygen 8）移植到 `server/tests/`，全數通過。
2. 規格附錄 A.3 列出的 **23 個**必要測試案例全數涵蓋，特別是：
   - `alg` 改為 `HS256` 並以公鑰當 HMAC 金鑰 → `INVALID_ALGORITHM`
   - header 含 `jku` / `jwk` / `x5u` / `x5c` → `INVALID_ALGORITHM`
   - 同一 `jti` 連送兩次 → 第二次 `TOKEN_REPLAYED`
   - Tenant A 的 `kid` 搭配 Tenant B 的 `iss` → `UNKNOWN_KID`
   - ES256 簽章以 DER 編碼 → `INVALID_SIGNATURE`
   - 🆕 `exp` 已過但在 15 秒容忍內 → 通過；超出容忍 → `TOKEN_EXPIRED`
   - 🆕 `iat` 在未來但在 15 秒容忍內 → 通過；超出容忍 → `TOKEN_NOT_ACTIVE`
   - 🆕 skew 設定超出 0～30 → 建構時 `RangeError`
   - 🆕 超過 4096 bytes 的輸入 → `ASSERTION_TOO_LARGE`，且**在解碼前**即返回（以「不合法 JSON 的超大輸入仍回 `ASSERTION_TOO_LARGE` 而非 `MALFORMED_TOKEN`」驗證順序）
3. 規格 §12.2「HyAgent 端」檢核清單 **18 項**全數打勾（上版為 9 項）。
4. 全 repo 搜尋不到 `ssoSecret`、`HS256`（`server/src/utils/jwt.ts` 的帳密登入 token 除外）。
5. 全 repo 搜尋不到把 Assertion 放進 URL 的路徑。
6. `presale/widge-tenant` 以私鑰簽發、端到端可跑通，且其 `.env` 不再含任何共享密鑰。
7. 🆕 Session 紀錄含 `kid`；撤銷某 `kid` 後，以該 `kid` 建立的 Session **於 60 秒內**在所有副本上失效（多副本環境實測）。
8. 🆕 依 `sub` 作廢 Session，對無有效 Session 的 `sub` 回 `200` 與 `revoked: 0`（**不得** 404，否則可被用來探測帳號是否在線）。
9. 🆕 後台可逐租戶設定 clock skew（0～30 且 ≤ 有效期 ¼）與 `expiresIn`（300～28800），並呈現各租戶現行值與偏離預設的標示。
10. 🆕 Assertion 含未知 claims 時驗證**仍通過**（§11.1 向前相容要求）。
11. 🆕 日誌與錯誤回應不含 Assertion 原文、金鑰內容、`sub` 與其他 claims 值。
12. 🆕 SDK 於 `/sdk/widget.js` 提供，該路徑 `Cache-Control` 的 `max-age` ≤ 300 秒；根目錄 `/widget.js` 不再對外服務。
13. 🆕 session 紀錄不含明文 `sub`（存 `subHash`），file 模式的快照檔亦然（§6.2.1 b）。

### 10.1 實際達成狀況（2026-09-20 覆核）

| # | 狀況 | 依據 |
| --- | --- | --- |
| 1 | ✅ **超出**：54 項（verifier 34 + issuer 12 + keygen 8）。多的 1 項是刻意新增的步驟 0 順序測試（§11.1 取捨表第 4 條） | `server/tests/assertion-{verifier,issuer,keygen}.test.ts` |
| 2 | ✅ 依 §11.1 記載已全數涵蓋。**本次覆核未逐項重新比對規格附錄 A.3 的 23 個案例** | §11.1 |
| 3 | ✅ 依 §11.4、§11.5 記載已完成。**本次覆核未逐項重新比對規格 §12.2 的 18 項** | §11.4、§11.5 |
| 4 | ✅ 實質達成，**但字面不成立**：`ssoSecret` 仍出現在 5 處**註解**（說明「改造前是什麼、為何移除」）、`HS256` 出現在驗證器（主動拒絕）、keygen CLI（列為不支援）與 `utils/jwt.ts`（帳密登入路徑，原就除外）。無任何一處是仍在運作的共享密鑰邏輯 | `grep -rn ssoSecret --include='*.ts'` |
| 5 | ✅ 實質達成。`client/public/sdk/widget.js` 仍有 `body.userToken`，那是**讀宿主 Identity Endpoint 回應**時相容四種欄位名，不是 URL 傳遞；`widget.postMessage.test.ts:123` 以 `expect(src).not.toContain('userToken')` 釘住 iframe URL | `client/src/widget.postMessage.test.ts` |
| 6 | ✅ `presale/` 已無 `TENANT_SSO_SECRET`；未設 `TENANT_PRIVATE_KEY` 時當場產一組並印出公鑰 | §11.4 |
| 7 | ⚠️ **部分達成**。單副本端到端已實測（撤銷公鑰 → `revokedSessions: 1`、原 Session 隨即 `401`），程式面 `getTenantFromPrimary()` + 每請求重查已備齊；**多副本環境實測未做** | §11.4、§11.6 |
| 8 | ✅ 回 `200` + `revoked: 0`，註解明寫「不得 404」的理由 | `admin.controller.ts:155` |
| 9 | ✅ 公鑰清單、逐租戶設定、偏離預設標示、偏移分佈、依 `sub` 作廢都在同一面板 | `admin/src/pages/tabs/AssertionKeysPanel.tsx` |
| 10 | ✅ 有專屬測試 | `assertion-exchange.test.ts:64` |
| 11 | ✅ 換發成功只記 `tenantId` / `kid`，失敗只記 `code` / `status`；偏移監測只記 `tenantId` / `offsetSeconds` / `toleranceSeconds`。驗證器本身完全不記 log | `auth.controller.ts:42-54`、`clock-skew-monitor.ts:54` |
| 12 | ✅ `location = /sdk/widget.js` 設 `max-age=300`；`location = /widget.js { return 404; }` | `client/nginx.conf.template:50-60` |
| 13 | ⚠️ **做法已改**。實際存 `subHash`（HMAC，作廢比對用）**與** `subEnc`（靜態加密，業務層要原文）。接線時發現 `requireAuth` 之後每支 API 都需要真實 `sub`（對話歸屬、表單、知識庫 ACL），只存雜湊的 Session 無法服務請求。正式環境未設 `DATA_ENCRYPTION_KEY` 直接**拒絕建立 Session**；dev 沿用 repo 既有慣例存明文。原委見 §11.4 末 | `auth-session.store.ts:88` |

**總結**：13 項中 11 項達成（其中 #4、#5 為實質達成、字面有註解與相容欄位殘留），#7 缺多副本實測（需環境，非程式工作），#13 的做法在施工中被自己推翻並留下紀錄。#2、#3 依 §11 記載為已完成，本次未回頭逐項重驗規格清單。

---

## 11. 實作記錄

> 各小節末的「驗收狀態」是**該階段完成當下**的快照，數字逐段成長（1209 → 1230 → 1238）屬正常，不是互相矛盾。
>
> **全案完成後的實測（2026-09-20）**：
>
> | workspace | 結果 |
> | --- | --- |
> | server | 1285 passed、3 skipped、**3 failed**，159 個 test suite |
> | client | 117 passed（14 檔） |
> | admin | 73 passed（10 檔） |
> | sdk | 33 passed（3 檔） |
>
> 那 3 項失敗是 `LocalFolderSource` 的權限測試（`batch-source`），**在本案動工前就是紅的**——Windows 的 `chmod` 不產生 POSIX 權限錯誤，與 SSO 改造無關。各階段驗收狀態描述的「既有的 3 項 `batch-source` 失敗」指的就是它們，至今仍然如此。

### 11.1 線 A：驗證器移植（已完成）

規格 §8 的 22 項檢查、§9 錯誤碼與 §2.4 `kid` 計算已移植為 TypeScript，**純新增目錄，未改動任何既有檔案**。

| 新增檔案 | 內容 |
| --- | --- |
| `server/src/lib/assertion/errors.ts` | §9 的 16 個驗證錯誤碼 + 3 個管理端錯誤碼、HTTP 狀態對照、`HyAgentTokenError`、§7.5 回應轉換 |
| `server/src/lib/assertion/jose.ts` | 演算法對照表（含 ES256 的 `dsaEncoding: ieee-p1363`）、禁用 header 參數、§8.1 結構檢查 |
| `server/src/lib/assertion/keygen.ts` | RFC 7638 `computeKid()`、`detectAlgorithm()`、金鑰對產生（測試與日後 CLI 用） |
| `server/src/lib/assertion/key-registry.ts` | `AssertionKeyRegistry` 介面 + 記憶體實作 |
| `server/src/lib/assertion/replay-store.ts` | `ReplayStore` 介面 + 記憶體實作 |
| `server/src/lib/assertion/verifier.ts` | §8.0–§8.6 步驟 0–21、§10.4 clock skew |
| `server/src/lib/assertion/index.ts` | 對外進入點 |
| `server/tests/helpers/assertion-signer.ts` | 測試用簽發器（跑在客戶端，Phase 2 移入 `sdk/`） |
| `server/tests/assertion-verifier.test.ts` | 34 項（移植 33 + 新增步驟 0 順序驗證） |
| `server/tests/assertion-issuer.test.ts` | 12 項 |
| `server/tests/assertion-keygen.test.ts` | 8 項 |

**驗收狀態**：54 項測試全過（`npx jest tests/assertion-*.test.ts`）；新增檔案 lint 與型別檢查皆無錯誤。

**刻意偏離參考實作之處**：

| # | 差異 | 理由 |
| --- | --- | --- |
| 1 | `KeyRegistry` 具體類別改為 `AssertionKeyRegistry` 介面 + `InMemoryKeyRegistry` | 正式實作要接租戶 store，且依 §2.6 第 1、2 條必須讀 primary、快取 TTL ≤ 30 秒，**不得**沿用 `tenantStore` 的 write-through 模式（§6.4）。介面化才換得掉 |
| 2 | `ReplayStore` 同樣介面化 | DB 實作（決策 B：`security_claims` 加 `expires_at`）屬 jti 工作項，此處先給記憶體版供測試 |
| 3 | `verifyAndConsume()` 不再重複 decode 一次 | 參考實作為取 `kid` 而二次解析；改為內部一次取得，行為完全相同 |
| 4 | 新增 1 項測試：超大且 JSON 不合法的輸入仍回 `ASSERTION_TOO_LARGE` | §8.0 的**順序**本身即規範性要求，需有測試釘住；否則實作順序寫錯會得到 `MALFORMED_TOKEN` 而無人察覺 |

### 11.2 線 B：`postMessage` 改造（已完成）

規格 §6.5（Token Provider 契約）與 §6.6（`postMessage` 協定）已落地，§10.1「Assertion 不得放入 URL」的硬衝突消除。**未動後端**——換發端點仍是原本的 `/api/auth/sso/exchange`，本條線只改「憑證怎麼從宿主頁走到面板」。

**協定**

```
iframe → host   handshake          面板就緒，回報自身 origin 與版本
iframe → host   identity:request   要求宿主頁呼叫 Token Provider（帶 requestId）
host   → iframe identity:response  回傳憑證或錯誤（帶同一個 requestId）
iframe → host   ui:close / ui:expand / event
host   → iframe ui:state
```

信封為 §6.6 的 `{ source: "hyagent", version: 1, type, requestId?, payload? }`。兩個方向的 `targetOrigin` 都是具體 origin（**不使用 `"*"`**），收訊端同時檢查 `event.origin` 與 `event.source`。

| 檔案 | 動作 |
| --- | --- |
| **新增** `client/src/hostBridge.ts` | 面板側協定：信封建構與驗證、`handshake()`、`requestIdentity()`（requestId 配對 + 逾時）、UI 訊息 |
| `client/public/widget.js` | 宿主側：移除 `?userToken=`；Token Provider（§5.2 的 `GET`、10 秒逾時、退避重試 1s/2s/4s、`cache: no-store`）；`identity:request` → `identity:response`；既有 UI 訊息改信封並收緊 origin |
| `client/src/embedConfig.ts` | 移除 `userToken`；新增 `hostOrigin`（`?host=`）與 `identityAvailable`（`?identity=1`） |
| `client/src/App.tsx` | SSO 改走 `hostBridge.requestIdentity()`；四處 `postMessage(…, '*')` 全數改為具體 origin |
| **新增** `client/src/hostBridge.test.ts` | 16 項 |
| **新增** `client/src/widget.postMessage.test.ts` | 18 項（取代原 `widget.tokenUrl.test.ts`） |
| `sdk/src/index.ts` | `loadWidget()` 不再注入 `data-user-token`；新增 `tokenUrl` 選項注入 `data-token-url` |
| `presale/widge-tenant/` | 改用 `data-token-url`，不再預先取票寫進 script 標籤；端點改名為規格 §5.2 的範例路徑 `GET /api/mybot/identity`，回 `{token, expiresIn}` 與 `Cache-Control: no-store` |
| `docs/HANDOFF-SSO.md`、`sdk/README.md`、`sdk/src/server.ts`、兩站 README 與 `widget-demo.html` | 交付方式改寫 |

**驗收狀態**：client 100 項測試全過（本條線新增 34 項，取代原 `widget.tokenUrl.test.ts` 的 6 項）、admin 61 項全過、sdk 12 項全過；型別檢查無誤，lint 無新增問題。

**設計取捨**

| # | 決定 | 理由 |
| --- | --- | --- |
| 1 | 宿主 origin 由 widget.js 以 `?host=` 明示，`document.referrer` 僅作退路 | `targetOrigin` 必須是具體 origin，而宿主頁若設 `Referrer-Policy: no-referrer`，referrer 會是空字串——那時只剩 `"*"` 可用，等於放棄 §6.6 的要求。URL 上放 origin 不違反 §10.1（那條禁的是 Assertion） |
| 2 | 另帶 `?identity=1` 表示宿主備有 Token Provider | 沒有 provider 的宿主頁若照送 `identity:request`，面板要白等一次逾時才落回登入頁 |
| 3 | `data-user-token` 直接移除而非保留相容 | §6.5 用一整節說明靜態字串為何不可行（過期、重放、被快取）。無既有客戶，相容層沒有服務對象。仍帶此屬性時 console 警告 |
| 4 | iframe 改為同步建立 | 身分不再需要先換票才能組出 panel URL，點開面板即刻載入——取票與面板渲染並行，改造前那段延遲一併消失 |
| 5 | 每次 `identity:request` 都重新取票，不快取、不共用結果 | §6.5 明文禁止快取。Assertion 是一次性兌換券，同一張送兩次第二次會被 `TOKEN_REPLAYED` 拒絕 |
| 6 | 對宿主頁轉發的 DOM CustomEvent 名稱與 detail 形狀維持 `oa-agent:*` 不變 | 那是對宿主頁的既有契約，與本次協定改版正交，沒有理由一起破壞 |
| 7 | admin 外觀預覽的 `oa-admin-preview` / `oa-widget-ready` 通道未改 | 那是 admin ↔ client 的內部預覽通道，不是宿主頁 ↔ 面板，不在 §6.6 範圍；訊息本身也不含任何憑證 |

**尚未做的部分**（依賴 Phase 1 的 session 模型，不屬本條線）：§6.5 呼叫時機②「Session 到期前 60 秒重走 token provider」與 §6.3 的 `refreshIdentity()` / `logout()`。`hostBridge.requestIdentity()` 已可重複呼叫，續期接上時不需要再改協定。

### 11.3 Phase 1 後端核心（已完成）

三個工作項已落地，**全部是純新增**：既有的 HS256 換發路徑一行未改，仍照常運作。這是刻意的施工順序——把新結構先蓋好、各自測到綠，最後才一次切換，任何中途停點都是可運作的狀態。

#### a. 租戶公鑰模型（規格 §2.5、§7.3）

| 檔案 | 內容 |
| --- | --- |
| **新增** `server/src/modules/tenant/tenant-keys.ts` | 公鑰解析（SPKI PEM / JWK）、`kid` 計算、§7.3 的四條不變條件、逐租戶設定的範圍與交叉驗證 |
| `server/src/modules/tenant/tenant.types.ts` | 新增 `TenantPublicKey`、`publicKeys[]`、`clockSkewSeconds`、`assertionLifetimeSeconds`、`sessionExpiresIn`；`ssoSecret` / `ssoVersion` 標記 `@deprecated` |
| `server/src/modules/tenant/tenant.store.ts` | `listPublicKeys` / `addPublicKey` / `setPublicKeyStatus`、設定讀寫、**`getTenantFromPrimary()`** |
| **新增** `server/tests/tenant-public-keys.test.ts` | 25 項 |

`getTenantFromPrimary()` 是 §2.6 第 1、2 條的落點：db 模式直接查 DB，不走 `tenantStore` 的記憶體 Map。那個 Map 在多副本部署下等同無限 TTL 快取（§6.4），遠超規格的 30 秒上限。

**公鑰不進 `sealTenant` 的加密範圍**——公鑰本就可公開，對它加密只會製造「以為受保護」的錯覺，並讓 `kid` 比對多付一次解密成本。

#### b. jti 防重放（規格 §8.5、決策 B）

| 檔案 | 內容 |
| --- | --- |
| `server/src/lib/security-claims.ts` | `claim(key, expiresAtSeconds?)` 加 TTL、`has()` 濾過期、`sweepExpired()` |
| **新增** `server/src/lib/assertion/claim-replay-store.ts` | `ReplayStore` 的正式實作，走 `security_claims` |
| **新增** `server/db/migrations/0015_security_claims_ttl.sql` | `expires_at` + partial index |
| **新增** `server/tests/security-claims-ttl.test.ts` | 9 項 |

`expires_at` 可為 NULL 是三態設計的關鍵：既有的 `refresh-used:` / `refresh-revoked:` 與送出防重**語意上不可過期**，清掉它們等於讓一張用過的 refresh token 重新可用。sweep 只碰有到期時間的列。

#### c. HyAgent Session store（規格 §7.1、§2.6、§7.4；§6.2.1 定稿）

| 檔案 | 內容 |
| --- | --- |
| **新增** `server/src/lib/auth-session.store.ts` | 不透明 `sessionToken`、`kid` / `subHash` 索引、TTL、依 token / kid / sub / tenant 作廢；file / db 雙後端 |
| **新增** `server/src/lib/expiry-sweeper.ts` | jti 與 session 共用的 5 分鐘回收排程（決策 B 的理由所在） |
| **新增** `server/db/migrations/0016_auth_sessions.sql` + `prisma` 的 `AuthSessionRow` | 表名 `auth_sessions`，三個索引 |
| `server/src/index.ts` | 開機掛上排程 |
| **新增** `server/tests/auth-session-store.test.ts` | 18 項 |

**驗收狀態**：server 1209 項測試，除 3 項**既有**的 `batch-source` 失敗（Windows 的 `chmod` 語意，改動前後皆然）外全過；本階段新增 55 項。型別檢查無誤，lint 無新增問題。

#### 施工中發現並修掉的兩個問題

| # | 問題 | 說明 |
| --- | --- | --- |
| 1 | 誤貼**私鑰**會靜默成功 | Node 的 `createPublicKey()` 接受私鑰並回傳其對應公鑰，因此若不主動辨識，這個貼錯不會有任何跡象：`kid` 正確、驗章正常、租戶用得好好的——而我們持有了一把絕不該持有的私鑰（規格 §2.2）。已於解析前以 PEM 標頭與 JWK 的 `d` 參數擋下，錯誤訊息明講「此金鑰對請視為已洩漏」 |
| 2 | 未設 `DATA_ENCRYPTION_KEY` 時 `subEnc` 會存成明文 | `encryptSecret()` 在無金鑰時原樣回傳明文（那是它給其他欄位的 dev 便利），照收就等於把使用者識別碼明文寫進 `os.tmpdir()`——正是 §6.2.1 b 要避開的事。改為**加密不起來就不存**，後台此時只顯示雜湊 |

#### 本專案新增的一個欄位：`assertionLifetimeSeconds`

規格 §4.3 寫的是「clock skew 不得超過**該 Tenant 有效期**的 ¼」。但 Assertion 的 `exp - iat` 由客戶的 Identity Endpoint 決定，HyAgent 事前無從得知——沒有一個可比對的基準，這條規則在後端就無從執行，只會變成寫在文件裡沒人擋的建議。

因此新增一個逐租戶欄位記錄「客戶告知的簽發有效期」（預設 60、範圍 30～300，即 §4.3 的建議值與上限），skew 以它為基準驗證 ¼ 規則。預設值下 skew 上限即 15 秒，與規格預設一致；租戶若確實簽發 120 秒的 Assertion，才用得到 30 秒的上限。

### 11.4 Phase 1 切換（已完成）

驗證器與三個 store 接線，**HS256 路徑同時拔除**。這一步刻意一次做完——拆開會讓系統處於半套狀態。

#### 換發端點

| 檔案 | 內容 |
| --- | --- |
| **新增** `server/src/modules/auth/assertion-exchange.ts` | 步驟 0 → 以 `iss` 取租戶 → 驗章（含防重放）→ 記錄偏移 → Origin 檢查 → 建 Session |
| **新增** `server/src/modules/auth/clock-skew-monitor.ts` | §10.4 的偏移記錄、超過容忍值一半告警、後台分佈 |
| `auth.controller.ts` / `auth.schema.ts` / `auth.routes.ts` | body `userToken` → `assertion`；回 `201 { sessionToken, expiresIn, user }`；錯誤走 §7.5 格式；新增 `POST /api/auth/logout` |
| `require-auth.ts` | `hyas_` 開頭查 session store，其餘走帳密登入 JWT（決策 G）。Session 路徑每請求重查公鑰狀態 |
| `credential-version.ts` | 移除 `credentialVersion()`；`via=sso` 的舊 JWT 一律拒絕 |
| `auth.service.ts` | 移除 `ssoExchange` 與 refresh 的 SSO 分支（§5.2：SSO 不需要 refresh token） |
| `verifier.ts` | 新增 `peekIssuer()`（步驟 0 + 取 iss）與 `verifyAndConsumeWithKey()`（Session 需要 kid） |
| **新增** `server/tests/assertion-exchange.test.ts` | 16 項（換發邏輯） |
| **新增** `server/tests/auth-exchange-endpoint.test.ts` | 9 項（HTTP 契約：狀態碼、§7.5 錯誤格式、logout、撤銷即時生效） |

**租戶由 `iss` 決定**（決策 A）：`pk_` API Key 不再參與身分判定，降級為外觀與 CORS。
`peekIssuer()` 讀的是**未驗章**的 payload，只用來挑公鑰——驗章後的步驟 10 會再確認 `iss` 相符，
偽造 `iss` 只會讓攻擊者被拿去跟他無法偽造簽章的那組公鑰比對。

**Origin 檢查排在驗章之後**（照規格的步驟 21 編號）。副作用是來源不合法的請求也會消耗掉該 `jti`——
那反而是好的：一張被側錄的 Assertion 拿去他站兌換，會在當場報廢而不是留著再用一次。

##### 來源檢查不能接在換發請求的 `Origin` header 上（實測後修正）

第一版我把 §8.6 步驟 21 接在換發請求的 `Origin` header，實機一跑就 403：換發由**面板 iframe**
發出，那個 header 恆為 HyAgent 自己的網域，永遠不會是客戶站台。照那樣接，等於要求每個租戶把
HyAgent 的網域加進白名單——對所有租戶都一樣，這道檢查完全失去鑑別力。

規格 §5.1 其實列了三個訊號：iframe 的 `document.referrer`、`postMessage` origin、API 請求的
`Origin` header。在 iframe 架構下**只有第三個是退化的**，而我恰好只接了那一個。

改為依呼叫端選擇可信訊號：

| 呼叫端 | `Origin` header | 採用的判定依據 |
| --- | --- | --- |
| Widget 面板（iframe，跑在 HyAgent 網域） | 恆為 HyAgent 自己 | 面板回報的 `document.referrer` |
| headless SDK（跑在客戶頁面） | 客戶站台，瀏覽器設定 | `Origin` header 本身 |

規則：`Origin` 不是第一方 → 它就是答案，且 body 的 `embedOrigin` 一律忽略（否則 evil.com
只要在 body 裡寫上受害者網域就繞過去了）；`Origin` 是第一方 → 請求來自我們自己的面板，
改採面板回報的 referrer。兩邊都拿不到 → **fail closed**。

配套：widget.js 在它建立的 iframe 上明確指定 `referrerpolicy="origin"`。元素層級優先於
宿主頁的全域 `Referrer-Policy`，所以宿主頁就算設了 `no-referrer`，正常路徑仍讀得到來源；
而攻擊者自行嵌入面板並抑制 referrer 時讀不到，正好被 fail closed 擋下。

**`?host=` 不可用於此判定**——那是宿主頁自己填進 iframe URL 的字串，誰都能寫成別人的網域。
它只留作 postMessage 的 `targetOrigin`（填錯的後果是訊息送不到，不是放行錯的人）。

#### 管理面（後端 + 基本 UI）

| 檔案 | 內容 |
| --- | --- |
| `admin.schema.ts` / `admin.controller.ts` / `admin.routes.ts` | 公鑰 CRUD、逐租戶設定、依 `sub` 作廢 Session |
| **新增** `admin/src/pages/tabs/AssertionKeysPanel.tsx` | 公鑰清單與上傳、停用 / 撤銷（含 §2.6 的二次確認文案）、設定值與偏離預設標示、偏移分佈、依 `sub` 作廢 |
| `admin/src/pages/tabs/SettingsTab.tsx` | 移除 SSO 共享密鑰輸入框 |

#### 拔除 HS256

| 位置 | 動作 |
| --- | --- |
| `tenant.types.ts` / `tenant.store.ts` | 移除 `ssoSecret` / `ssoVersion`、`sealTenant` 的 SSO 分支、`createTenant` 的第三個參數 |
| `sdk/src/server.ts` | 移除 `signUserToken` / `verifyUserToken`，改為 **新增** `sdk/src/assertion.ts`（`issueAssertion` / `generateKeyPair` / `computeKid`，零相依）；`jsonwebtoken` 相依一併移除 |
| `sdk/src/index.ts` | `userToken` → `assertion`；改存不透明 `sessionToken`，Session 路徑不做 refresh |
| `client/src/api.ts` | `sessionToken` 存 **sessionStorage**（§7.1 明訂不得用 localStorage），與帳密 JWT 二擇一 |
| `presale/widge-tenant`、`sdk-custom-ui`、`webhook-receiver` | 改以私鑰簽發；未設 `TENANT_PRIVATE_KEY` 時當場產一組並把公鑰印在 console |
| 文件 | `HANDOFF-SSO.md` 改寫、`INTEGRATION.md` / `LOCAL-SETUP.md` / `README.md` / `DEPLOY.zeabur.md` / `sdk/README.md` / 三站 README 與 `.env.example` |

**驗收狀態**：server 1230 項（除 3 項既有的 `batch-source` 失敗外全過）、client 100 項、admin 61 項、sdk 18 項全過；四個 workspace 型別檢查無誤，lint 無新增問題。

**端到端實測**（獨立資料目錄、server 3999 + demo 4000，六個環節逐一驗過）：

| # | 步驟 | 結果 |
| --- | --- | --- |
| 1 | 後台建租戶 | `activeKeyCount: 0`（尚無公鑰＝無法登入，面板看得出來） |
| 2 | 登記公鑰 | `kid` 由後端算出，`status: active` |
| 3 | `GET /api/mybot/identity` | ES256 Assertion，`iss` 為 Tenant ID、`aud` 為 `hyagent`、帶 `jti` |
| 4 | `POST /api/auth/sso/exchange` | `201` + 不透明 `hyas_…`、`expiresIn: 3600`、`user` |
| 5 | 同一張再送一次 | `401 TOKEN_REPLAYED` |
| 6 | 後台撤銷該公鑰 | `revokedSessions: 1`，原 Session 隨即 `401` |

**瀏覽器路徑已實測**（Playwright 驅動 Edge，跑 4000 宿主站 → 5173 面板 → 3000 後端的真實三段）：

| 檢查項 | 結果 |
| --- | --- |
| iframe URL | `?embed=1&key=…&host=…&identity=1`，**無任何憑證** |
| iframe `referrerpolicy` | `origin` |
| 面板讀到的 `document.referrer` | `http://localhost:4000/` |
| 換發請求 | 帶 `embedOrigin`，回 `201` |
| 面板狀態 | **無登入表單**（自動登入成立） |
| 憑證存放 | `sessionStorage` 的 `oa-session-token`（規格 §7.1 要求不得用 localStorage） |

兩個觀察到但非缺陷的現象：

1. **dev 下換發會跑兩次**——React `StrictMode` 在開發模式重跑 effect，production build 只會一次。
   代價是多燒一張 Assertion、多建一個 Session。沒有加防護，因為加了會同時遮蔽「正式環境真的重複呼叫」。
2. `/api/leave/balances` 回 `403`——既有行為（假別餘額僅供內部帳號），與本案無關，面板已妥善處理。

#### 示範站的一個真缺陷

Identity Endpoint 的簽發失敗（最常見：忘了設 `TENANT_ID`）**未被捕捉**，
而 demo 是單一 `http` server，未捕捉的例外會直接讓整個行程結束——
表現成「點一下小幫手，示範網站就掛了」，真正的原因埋在 console 最底下。
已改為回 `500` 並印出原因；`sdk-custom-ui` 同樣處理。

#### 規格側的一項調整：Tenant ID 格式

規格 §5.1 原本規定 Tenant ID 為 `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`（可讀值，範例為 `hyoa`），
而本專案 `createTenant()` 產生的是 `randomBytes(8).toString('hex')`——首字為數字的機率 10/16，
**約 62.5% 的產出不符該規則**（以 10000 次模擬驗證）。現有租戶剛好都以字母開頭才沒撞到。

**決議：改規格，不改程式**（本專案判斷）。規格 §5.1 已改為 `^[0-9a-f]{16}$`，並補上三件事：

- 識別碼由 HyAgent 配發，客戶不得自行指定——避免搶名稱，也避免 Tenant ID 洩漏客戶組織名稱。
- 明確要求視為**不透明識別碼**；要給人看的名稱用後台的顯示名稱（可隨時改，與識別碼無關）。
- `default` 列為保留值：它是內部向後相容用的租戶，不符格式也不配發給客戶——
  不寫清楚的話，規格會被系統自己的資料打臉。

連帶改掉一處會出錯的建議：原 §4.2.3 建議自訂 claims「以 Tenant ID 為前綴」。
Tenant ID 變成 16 位 hex 後，當前綴既不可讀，每個 claim 還多付 17 bytes，很快逼近
§4.2.4 的 4096 bytes 上限。已改為「用貴方系統自己的簡短代號」。

規格內 14 處 `hyoa` 範例值一併更新為一致的 hex；其中 3 處刻意保留——
`hyoa_deptId`（現在正好是「客戶自己的短代號」的範例）與 §11.2 講 HYOA 既有 `aud: hyoa-ai`
遷移的兩處，主題不同。參考實作沒有 Tenant ID 格式驗證，不需同步。

#### 施工中發現的一個真缺陷

`validate` 中介層會用 zod 的解析結果**整個取代** `req.params`，而 zod 預設剝掉未宣告的鍵。
公鑰狀態變更的路由是 `/tenants/:id/assertion-keys/:kid`，卻沿用了只宣告 `id` 的
`tenantParamSchema` —— `req.params.kid` 因此是 `undefined`，撤銷打在一個不存在的 kid 上，
回 400 而不是真的撤銷。**UI 上看起來像是「操作失敗」，但真正的風險是反過來的情境**：
若哪天錯誤被吞掉，管理員會以為已經撤銷，而那把外洩的金鑰還在服役。
已補 `tenantKeyParamSchema`，並由端點測試釘住「撤銷後既有 Session 立刻失效」。

#### 施工中改掉的一個自己的決定

上一階段我把 `subEnc` 設計成「加密不起來就不存」，理由是不讓使用者識別碼明文落在 `os.tmpdir()`。
接線時才看清楚**那個欄位是承載業務身分的**——`requireAuth` 之後的每一支 API 都要真實的 `sub`
（對話歸屬、表單、知識庫 ACL），省略它會讓 Session 根本無法服務請求。

改為：沿用 repo 既有慣例（`encryptSecret`，未設金鑰時原樣存明文，與 `llmConfig` 金鑰相同），
並在**建立 Session 當下**檢查 `NODE_ENV=production` 且未設 `DATA_ENCRYPTION_KEY` 就直接拒絕。
dev 保持方便，正式環境不可能靜默地把使用者清單寫進暫存目錄。

### 11.5 Phase 2 收尾（已完成）

上一輪列的五項待辦，做掉三項；剩下兩項的狀態見 §11.6。

#### Session 續期（規格 §6.5 呼叫時機②、§6.3）

SSO 路徑沒有 refresh token，續期就是**重走一次 token provider**。協定面上一輪已備妥
（`hostBridge.requestIdentity()` 本來就可重複呼叫、widget.js 的 `identity:request` 監聽是常駐的），
這一輪接的是「什麼時候重走」與「換完之後誰負責記住到期時刻」。

| 位置 | 動作 |
| --- | --- |
| `client/src/api.ts` | 記住 `expiresIn` 算出的到期時刻（跟著 token 存 sessionStorage，面板重整後仍知道何時該續）；到期前 60 秒的定時器；請求前的補網判斷；401 重取一次；`setIdentityProvider()` |
| `client/src/App.tsx` | 嵌入且宿主備有 token provider 時，把 `hostBridge.requestIdentity` 註冊給 api 層 |
| `sdk/src/index.ts` | `assertion` 由 `string` 放寬為 `string \| AssertionProvider`；到期前 60 秒與 401 自動重走 provider；新增 `refreshIdentity()` / `logout()`；`loadWidget()` 預設路徑改 `/sdk/widget.js` |

**面板掛定時器，SDK 不掛。** 這不是疏漏，是兩邊的執行環境不同：

- 面板是長駐 iframe，使用者可能開著不動一小時後才打字。定時器讓續期發生在打字之前，
  不會讓第一則訊息多等一次換發往返。
- SDK 也跑在 Node 裡，一個長駐 timer 會讓呼叫端的行程關不掉；瀏覽器端則是閒置分頁每小時
  白燒一張 Assertion、多建一個 Session。改在「需要 Session 的那個請求之前」判斷，時機一樣準。

**面板的定時器不是唯一防線**，請求前另有一次判斷。理由是定時器本身不可靠：背景分頁的
`setTimeout` 會被瀏覽器節流到分鐘級，筆電闔上更是整段不跑——醒來時定時器還沒燒到，
Session 卻早就過期了。兩者都在，才涵蓋得住「分頁被晾在背景一整天」這個最常見的情況。

**401 也是續期時機。** 撤銷 `kid`、依 `sub` 作廢、file 模式重啟都會讓 Session 提早失效；
使用者若在宿主網站仍登入，重取一張就接回去了，不必先把人丟回登入頁。
`sessionToken !== sentSession` 的比對讓並發請求不會各自換一張——Assertion 是一次性的，
一口氣換兩張的話第二張必定 `TOKEN_REPLAYED`。

#### 施工中發現的一個真缺陷：登出沒有真的登出

`client/src/api.ts` 的 `logout()` 註解寫著「純前端清 token；JWT 無狀態」——那句話在
Session 改為**伺服器端有狀態**之後就不成立了，但程式沒跟著改。實際行為是：
使用者按下登出，瀏覽器這一側清乾淨，**後端那張 Session 仍然有效直到自然過期**（預設一小時）。
共用電腦上這正是登出要防的情境。已改為先清本地、再帶原 token 打 `POST /api/auth/logout`。

一併處理的細節：那支請求帶 `keepalive: true`。登出常緊接著 `location.reload()`（錯誤畫面的
「重試」就是這樣寫的），少了它請求會在導覽時被瀏覽器當場取消，等於沒打。

SDK 的 `logout()` 是同一件事的 headless 版本，行為一致。

#### `/sdk/widget.js` 路徑搬移（規格 §7.2）

`client/public/widget.js` → `client/public/sdk/widget.js`（Vite 原樣複製 `public/`，
對外即 `/sdk/widget.js`），nginx 的 `location = /widget.js` 隨之改為 `= /sdk/widget.js`。
server 不需要新增靜態路由——widget.js 一直都由 client 服務提供，不是 server。

**舊路徑不保留，但要明確回 404。** 規格 §7.2 定的是「單一可變路徑」，留一條別名等於長期
維護兩個入口；且如 §7.2 所述無既有客戶，改名成本為零。repo 內所有載入點（demo 頁、
三個 presale 站、SDK 的 `loadWidget()` 預設值、示範站的啟動腳本探測、五份文件）已一併更新。

不寫 404 的話 `/widget.js` 會掉進 SPA fallback 拿到 `index.html`——**回 200，內容是 HTML**。
宿主頁把它當 JS 執行，console 只會出現一句 `Unexpected token '<'`，完全看不出是路徑改了。
已實測 dev server 的行為確實如此，故 nginx 補了一條 `location = /widget.js { return 404; }`。

快取策略由 `no-cache` 改為 `public, max-age=300`，**這是一個要說清楚的取捨**：

| | `no-cache`（原） | `max-age=300`（現） |
| --- | --- | --- |
| 修補傳播 | 立即（每次都 revalidate） | 最多延後 5 分鐘 |
| 宿主頁每次導覽 | 一次阻擋式條件請求（304） | 5 分鐘內直接命中快取 |

規格把上限訂在 300 秒，本身就是這個取捨的答案：widget 是宿主站**每一頁**都會載的入口檔，
省下的往返是真的；而 5 分鐘是一個仍然可控的修補視窗。若日後認為修補速度更重要，
改回 `max-age=0, must-revalidate` 即可，同樣合規。

#### `file` + `production` 的 boot fail-fast（§6.2.1 d）

擋的不是 file 模式本身——單副本 + 持久磁碟是合法部署，`docs/LOCAL-SETUP.md` 也一直這樣寫。
擋的是**沒人察覺的多副本**：file 模式的記憶體 Map 就是 primary、落檔靠 `wx` 當鎖、
`kid` / `subHash` 索引開機才重建，三者都只在單副本成立，而跑兩個副本不會有任何錯誤訊息。

因此做成「要用就得明示」而不是硬擋：`NODE_ENV=production` + `DATA_BACKEND=file` 時 boot 失敗，
除非設 `ALLOW_FILE_BACKEND_IN_PRODUCTION=true`。

這個旗標**刻意不用** `z.coerce.boolean()`——它把任何非空字串都判成 `true`，包括 `'false'`。
repo 裡既有的 `KNOWLEDGE_RERANK` 就踩在這個陷阱上（預設 true，設 `false` 沒有效果），
但那頂多是多跑一次重排；安全開關踩到的話，是整條守門形同虛設。改用列舉 + transform，
只認 `true` / `false` / `1` / `0`，打錯字直接 fail-fast。

`Dockerfile.server` 內建 `NODE_ENV=production`，因此這條規則對每個容器部署都生效；
`DEPLOY.zeabur.md` 的環境變數表已補上 `DATA_BACKEND` 與這個旗標兩列。

**驗收狀態**：server 1238 項通過（仍是既有的 3 項 `batch-source` 失敗，與本輪無關）、
client 112 項、sdk 24 項全過；client / sdk 型別檢查無誤，異動檔案 lint 無新增問題。
新增測試 3 支共 21 項：`server/tests/env-file-backend-production.test.ts`（6）、
`client/src/api.session.test.ts`（8）、`sdk/src/session.test.ts` 續期段（7）。

#### repo 內對外文件的一次校正

上一輪只改了直接相關的幾份（`HANDOFF-SSO.md`、`LOCAL-SETUP.md`、`INTEGRATION.md` 等），
其餘仍在描述共享密鑰時代的模型。這次逐份掃過並改完：

| 文件 | 原本的問題 |
| --- | --- |
| `SECURITY-FIXES.md` | 部署第 2 步要整合方以 **HS256** 簽、`iss=hyagent:handoff`。這是**唯一有實害**的一份：它從 `HANDOFF-SSO.md` 連出去，照著做會簽出一張必被拒絕的票。已劃掉舊要求、寫出現行契約，並於頂部標明本文是那次修正的紀錄、SSO 段落已被取代 |
| `ARCHITECTURE.md` | 兩處指向 `HANDOFF-SSO §4` 的「五項缺口」——該章節已不存在，五項也已隨非對稱改造完成 |
| `SYSTEM_ANALYSIS.md` | §5.5 仍把 Tenant Binding 列為 P0 缺口（`require-auth.ts` 早已實作並回 401）；換發流程圖回傳「Access/Refresh Token」（現為不透明 `sessionToken`、無 refresh）；敏感資料、威脅表、缺口表同步 |
| `PRODUCT_SPEC.md` | AUTH-04「每租戶可設定 SSO Secret」→ 登記 Assertion 公鑰 |
| `README.md` / `INTEGRATION.md` | `ssoSecret` 靜態加密、後台「SSO 密鑰」欄位、widget 的 `user-token` 屬性 |
| 知識庫 ACL 設計 | §6.9 要求的論述更新（見下） |
| `presale/sdk-custom-ui/README.md` | 流程圖的 SDK 選項仍寫 `userToken` |

`sdk-custom-ui` 另改掉一個**行為**問題（不只是文字）：它把取到的 Assertion 以**字串**傳給 SDK，
而那是一個會一直開著的 landing page——Session 到期（預設一小時）或被後台撤銷之後就沒有下一張票，
使用者只能重整頁面。已改為傳 token provider 函式，續期與 401 後的重取都交給 SDK。
它是給整合方照抄的參考實作，照抄的那一份就該是正式環境行為正確的那一版。
（`webhook-receiver/trigger.mjs` 維持一次性字串：那是跑完就結束的腳本，活不過一個 Session。）

另修掉一處與本案無關但同樣過時的敘述：`SECURITY-FIXES.md` 寫「安全 claim 不會自動清除」，
但 Assertion 的 `jti` 自 Phase 1 起已有 TTL 並由 `expiry-sweeper.ts` 每 5 分鐘回收——
原句會讓維運誤以為整張表只增不減。

**§6.9 的論述更新已落地**：`2026-08-25-knowledge-acl-design.md` 原寫「這套 ACL 的強度上限
等於 `ssoSecret` 的保管強度」，現改為「等於整合方私鑰的保管強度」，並點明風險面收斂的理由——
共享密鑰時代雙方都持有可簽出任何身分的秘密，我方的保管疏失同樣會塌；現在我方只有公鑰。

`docs/superpowers/` 下帶日期的計畫／設計紀錄（含當時的程式碼片段）**刻意不改寫**——
那是當時的紀錄，改了等於竄改歷史。只在主題確實已失效的兩份（2026-06-16 管理後台
design + plan）頂部加一行「後續變更」註記指向現行契約。

### 11.6 尚未做的部分

（2026-09-20 覆核，兩項仍然成立。）

| 項目 | 說明 |
| --- | --- |
| 撤銷傳播的多副本實測 | Phase 4。程式面已備齊（`getTenantFromPrimary()` + 每請求重查），缺的是多副本環境的實測數據——這一項需要環境，不是程式工作 |
| 對外說帖（repo 外） | 簡報、一頁式、官網文案等業務素材。**repo 內的對外文件已全數校正**（見 §11.5），這裡剩下的是不在版控裡、需由產品／業務決定對象與口吻的部分 |

---

## 附錄：受影響檔案清單

> **這是規劃階段預估的清單**，「動作」欄寫的是當時打算怎麼改。實際落地的檔案與內容以 §11 各階段的表格為準——兩邊有出入的地方，§11 是對的。
>
> 已知的三處出入：
>
> | 規劃時寫的 | 實際 |
> | --- | --- |
> | `server/src/lib/clock-skew-metrics.ts` | `server/src/modules/auth/clock-skew-monitor.ts` |
> | `client/public/widget.js`（原地改） | 檔案搬至 `client/public/sdk/widget.js`，對外路徑 `/sdk/widget.js` |
> | 未列 | 另新增 `server/src/modules/tenant/tenant-keys.ts`、`server/src/lib/expiry-sweeper.ts`、`client/src/hostBridge.ts`、`sdk/src/assertion.ts`、`sdk/bin/keygen.mjs` |

🆕 標示者為本次規格更新新增。

### 後端

| 檔案 | 動作 |
| --- | --- |
| `server/src/modules/auth/auth.service.ts` | 改寫 `ssoExchange`，接新驗證器，改為建立 session 紀錄 |
| `server/src/modules/auth/credential-version.ts` | 撤銷 key 由租戶密鑰改為 `kid` |
| `server/src/modules/auth/auth.schema.ts` | `userToken` → `assertion` |
| `server/src/utils/jwt.ts` | 🆕 SSO 路徑不再簽發 access / refresh JWT；帳密登入路徑保留 |
| `server/src/middlewares/require-auth.ts` | 🆕 改為查 session store（不透明 token），並相容帳密登入的 JWT |
| `server/src/modules/tenant/tenant.types.ts` | 移除 `ssoSecret` / `ssoVersion`，新增 `publicKeys[]`，🆕 新增 `clockSkewSeconds`、`sessionExpiresIn` |
| `server/src/modules/tenant/tenant.store.ts` | `sealTenant` / `unsealTenant` 移除 SSO 分支；公鑰 CRUD；🆕 公鑰查詢改 primary 直查 |
| `server/src/modules/tenant/tenant.service.ts` | `isOriginAllowed` 接到換發端點 |
| `server/src/modules/admin/admin.schema.ts`、`admin.controller.ts` | 公鑰管理端點；🆕 Session 作廢端點；🆕 租戶設定端點 |
| `server/src/lib/security-claims.ts` | 🆕 加 `expires_at` 與清理排程（決策 B 定稿：jti 改放 DB，不引入 Redis） |
| `server/src/modules/docs/openapi.ts` | 端點與錯誤碼定義（含 3 個管理端錯誤碼） |
| **新增** `server/src/lib/assertion/` | 驗證器、`computeKid`、錯誤碼（移植自參考實作） |
| 🆕 **新增** `server/src/lib/auth-session.store.ts` | 不透明 `sessionToken`、`kid` / `subHash` 索引、TTL、批次作廢；file / db 雙後端，**db 模式讀取路徑不得用記憶體 Map**（§6.2.1） |
| 🆕 **新增** `server/src/modules/auth/clock-skew-monitor.ts` | 偏移量記錄與告警門檻（容忍值的一半）。**規劃時暫名 `lib/clock-skew-metrics.ts`，實作落在 `modules/auth/`** |
| 🆕 `server/prisma/schema.prisma` | 新增 `AuthSessionRow` / `auth_sessions`（含 `kid`，**須自第一版納入**）。**不得**沿用 `SessionRow` / `sessions` —— 已被對話 session 佔用 |

### 前端 / SDK

| 檔案 | 動作 |
| --- | --- |
| `client/public/sdk/widget.js` | 移除 query token，改 `postMessage`；🆕 對外路徑由 `/widget.js` 搬至 `/sdk/widget.js`（檔案一併搬進 `public/sdk/`） |
| `client/src/embedConfig.ts` | 移除 `userToken` 參數 |
| `client/src/App.tsx` | 改由 `postMessage` 取得 Assertion |
| `client/src/api.ts` | 換發介面調整；🆕 改用不透明 `sessionToken`，移除 refresh 流程 |
| `sdk/src/server.ts` | `signUserToken` → `issueAssertion`；移除 `jsonwebtoken` 相依 |
| `sdk/src/index.ts` | `userToken: string` → token provider 函式；🆕 到期前 60 秒重走 provider 的續期邏輯 |
| **新增** `sdk/bin/keygen` | 金鑰對產生 CLI |
| `admin/src/pages/tabs/SettingsTab.tsx` | 密鑰輸入框 → 公鑰清單管理（含撤銷影響告知與二次確認） |
| 🆕 **新增** admin Session 作廢頁 | 依 `sub` 作廢 Session |
| 🆕 **新增** admin 租戶設定總覽 | clock skew / `expiresIn` / 演算法的現行值與偏離預設標示（§11.1） |
| 🆕 部署 / 反向代理設定 | `/sdk/widget.js` 的 `Cache-Control` 設為 `max-age` ≤ 300；與 SPA `/assets/*`（content-hash、immutable）分開規則 |

### 測試 / 示範 / 文件

| 檔案 | 動作 |
| --- | --- |
| `server/tests/auth-sso.test.ts` | 全面改寫 |
| `server/tests/security-regressions.test.ts` | 補 algorithm confusion、replay、origin 案例；🆕 補 clock skew 邊界與步驟 0 順序案例 |
| 🆕 **新增** `server/tests/session-revocation.test.ts` | 依 `kid` / `sub` 批次作廢、冪等回應、60 秒生效 |
| `client/src/widget.tokenUrl.test.ts` | 改為 `postMessage` 協定測試 |
| `sdk/src/server.test.ts`、`refresh.test.ts` | 隨 SDK 介面調整；🆕 `refresh.test.ts` 在 SSO 路徑上改為 token provider 續期測試 |
| `presale/widge-tenant/`、`presale/sdk-custom-ui/`、`presale/widge-public/` | 改用私鑰簽發；🆕 script src 改為 `/sdk/widget.js` |
| `docs/HANDOFF-SSO.md` | 全面改寫為 Identity Assertion 契約 |
| `docs/LOCAL-SETUP.md` | 第六節（建租戶 / 設密鑰）改為上傳公鑰流程 |
| `docs/ARCHITECTURE.md`、`docs/SYSTEM_ANALYSIS.md`、`docs/PRODUCT_SPEC.md` | 更新 SSO 與 Session 模型描述 |
| `docs/superpowers/specs/2026-08-25-knowledge-acl-design.md` | 更新 ACL 強度論述（§6.9） |
| `INTEGRATION.md`、`README.md` | 更新整合說明；🆕 載明 `onError` 不得直接顯示給終端使用者 |
