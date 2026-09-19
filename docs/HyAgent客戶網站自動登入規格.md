# HyAgent SDK 規格書

| 項目 | 內容 |
| --- | --- |
| 文件名稱 | HyAgent SDK 規格書（含 HyAgent Identity Assertion Protocol v1） |
| 版本 | v1.0 |
| 狀態 | 定稿 —— 規範性內容已全數實作於本 repo 並由測試涵蓋 |
| 適用對象 | 導入 HyAgent Chatbot Widget 的客戶網站開發團隊、HyAgent 後端開發團隊 |
| 實作 | 本 monorepo：客戶端 `sdk/`、Widget `client/public/sdk/widget.js`、HyAgent 後端 `server/src/`。章節內以 **▶ 實作** 標示對應程式，逐章對照見 §1.6 |

本文件中 **必須（MUST）**、**不得（MUST NOT）**、**應該（SHOULD）**、**建議（RECOMMENDED）**、**可以（MAY）** 依 RFC 2119 語意解讀。標示為「規範性」的章節為實作相容性的判定依據；標示為「參考性」的章節僅供理解與示範。

> **交付客戶端工程師時請改給** [HyAgent客戶端整合手冊.md](HyAgent客戶端整合手冊.md)：同一套協定，只保留整合方要動手做的部分（產金鑰、開 Identity Endpoint、掛 `<script>`、排錯、檢核清單）。本文件為完整規範，兩者若有出入以本文件為準。

---

## 1. 總覽

### 1.1 問題定義

HyAgent Widget 以 iframe 嵌入在**客戶自有網域**的網頁中。受瀏覽器同源政策限制，Widget **無法**讀取宿主網站的 Cookie、LocalStorage 或登入 Session，因此無法自行得知「目前使用者是誰」。

反過來說，也**不能**讓宿主網頁直接把使用者身分當成參數傳進來：

```js
// ❌ 錯誤：前端 JavaScript 可被使用者任意修改，等同無認證
OAAgent.setUser({ userId: "123", email: "user@example.com" });
```

正確做法是由**客戶網站的 Backend** 用私鑰簽發一個短效、帶簽章的身分聲明（Identity Assertion），前端只負責轉交，HyAgent 後端以客戶事先註冊的公鑰驗章。

### 1.2 信任邊界

```mermaid
flowchart TB
    subgraph customer["客戶網域 shop-a.com"]
        direction LR
        host["Host Page<br/>+ HyAgent SDK"]
        backend["Customer Backend<br/>驗證自家 Session<br/>私鑰簽發 Assertion"]
        host -- "① 同源請求" --> backend
        backend -- "② Assertion" --> host
    end

    subgraph hyagent["HyAgent 網域"]
        direction LR
        widget["Widget iframe"]
        api["HyAgent Backend<br/>以註冊公鑰驗章<br/>jti 防重放"]
        widget -- "④ POST /api/auth/sso/exchange" --> api
        api -- "⑤ HyAgent Session" --> widget
    end

    host -- "③ postMessage" --> widget

    classDef secret fill:#fff4e5,stroke:#d9822b,stroke-width:2px
    class backend secret
```

橘框的 Customer Backend 是**唯一持有私鑰**的元件，私鑰永不離開客戶網域。

**信任來源只有一個**：客戶 Backend 持有的私鑰。宿主網頁、Widget iframe、瀏覽器全部視為不可信的傳輸通道，只能轉交 Assertion，不能變更其內容（任何變更都會導致驗章失敗）。

### 1.3 與 SSO 的分工

Identity Assertion 與 SSO 是不同層次的機制：

- **SSO 解決**：「使用者如何登入客戶網站？」
- **Identity Assertion 解決**：「客戶網站如何安全地告訴 HyAgent，目前這個使用者是誰？」

```mermaid
flowchart LR
    entra["Microsoft Entra ID"] --> login
    okta["Okta"] --> login
    google["Google Workspace"] --> login
    ad["Active Directory"] --> login
    custom["自建帳號系統"] --> login

    login["客戶網站登入"] --> session["客戶網站 Session"]
    session --> assertion["HyAgent<br/>Identity Assertion"]
    assertion --> hysession["HyAgent Session"]

    classDef layer fill:#eef4ff,stroke:#3b6fd4,stroke-width:2px
    class assertion,hysession layer
```

藍框以上由客戶的 SSO 決定，藍框以下是本規格的範圍 —— 兩者只透過 Assertion 交界。

因此 HyAgent **不需要知道客戶使用哪一種 SSO**，客戶也不需為了 HyAgent 更動既有登入流程。這個抽象層讓 Widget 的實作技術（React、iframe、API、Node.js）日後如何替換，都不影響客戶端的 Authentication Contract。

### 1.4 名詞定義（規範性）

| 名詞 | 定義 |
| --- | --- |
| Tenant | 一個客戶（或客戶的一個站台）。以 Tenant ID 唯一識別。 |
| Tenant ID | Tenant 的識別碼，由 HyAgent 配發的不透明字串，例如 `a3f19c2d84b7e061`。格式見 §5.1。 |
| `{hyagent-host}` | HyAgent 服務的對外主機名稱。本規格一律以 `https://{hyagent-host}` 表示其 Base URL，實際值由 HyAgent 於導入時提供並登載於後台。**變更部署環境而更換此位址不視為破壞性變更**，但仍適用 §11.1 收斂程序的通知期。 |
| Host Page | 嵌入 HyAgent Widget 的客戶網頁。 |
| Customer Backend | 客戶網站的後端服務，是唯一持有私鑰、可簽發 Assertion 的元件。 |
| Identity Assertion | 由 Customer Backend 簽發、宣告目前使用者身分的短效 JWT。本文簡稱 Assertion。 |
| Identity Endpoint | Customer Backend 上供自家前端取得 Assertion 的 HTTP 端點。 |
| HyAgent Session | Assertion 驗證通過後由 HyAgent 後端核發、供 Widget 後續呼叫使用的憑證。 |
| kid | Key ID，公鑰的識別碼，計算方式見 §2.4。 |
| jti | JWT ID，Assertion 的唯一識別碼，用於防重放。 |

### 1.5 整合流程總覽（參考性）

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者
    participant H as Host Page
    participant B as Customer Backend
    participant W as HyAgent Widget
    participant S as HyAgent Backend

    U->>H: 開啟頁面
    Note over H: 載入 widget.js<br/>帶 data-key 與 data-token-url
    W->>H: postMessage identity:request
    H->>B: GET /api/mybot/identity（同源帶 cookie）
    Note over B: 驗證自家 Session<br/>私鑰簽發 Assertion，有效期 60 秒
    B-->>H: { token, expiresIn: 60 }
    H->>W: postMessage identity:response
    W->>S: POST /api/auth/sso/exchange
    Note over S: 依 iss 找租戶 → 查 kid 對應公鑰 → 驗章<br/>claims 檢查 → jti 防重放 → Origin 白名單
    S-->>W: sessionToken，有效期 3600 秒
    W-->>U: 顯示「Hi, 羅玉瑩」
```

### 1.6 實作對照（參考性）

本規格的規範性規則全數實作於本 repo，章節內以 **▶ 實作** 標出對應程式與測試。三個信任邊界的程式分別落在：

| 信任邊界 | 程式位置 | 誰執行 |
| --- | --- | --- |
| 產生金鑰、簽發 Assertion | `sdk/bin/keygen.mjs`、`sdk/src/assertion.ts` | **客戶後端**（唯一持有私鑰） |
| 轉交 Assertion | `client/public/sdk/widget.js`、`sdk/src/index.ts` | 瀏覽器（不可信通道） |
| 驗證 Assertion、發 Session、管理公鑰 | `server/src/lib/assertion/`、`server/src/modules/auth/`、`server/src/modules/tenant/` | **HyAgent 後端** |

**先跑這個**：`presale/widge-tenant/` 是一支模擬客戶網站的服務（自家登入 → Identity Endpoint → 嵌入 Widget）。照它的 README 跑一遍，就走完「產生金鑰 → 簽發 → 轉交 → 驗證 → 建立 Session」的完整信任鏈，比讀規格快。

#### 依角色查

| 你的角色與任務 | 該看哪一支 | 對應章節 |
| --- | --- | --- |
| 想先看懂整個流程 | `presale/widge-tenant/`（可執行 demo） | §1.5 |
| 客戶端：產生金鑰對、金鑰輪替 | `sdk/bin/keygen.mjs` | §2、§3、§5.1 |
| 客戶後端：實作 Identity Endpoint | `presale/widge-tenant/server.mjs` → `sdk/src/assertion.ts` | §4、§5.2 |
| 客戶前端：掛上 Widget | `presale/widge-tenant/index.html`（widget）、`presale/sdk-custom-ui/`（自建 UI） | §5.3、§6 |
| HyAgent 後端：驗證 Assertion 並發 Session | `server/src/modules/auth/assertion-exchange.ts` → `server/src/lib/assertion/verifier.ts` | §7.1、§8 |
| HyAgent 後台：上傳／撤銷公鑰、作廢 Session | `admin/src/pages/tabs/AssertionKeysPanel.tsx` → `server/src/modules/admin/admin.controller.ts` | §7.3、§7.4 |
| 整合卡住，要查為何被拒 | `server/src/lib/assertion/errors.ts` | §9 |

#### 依檔案查

| 檔案 | 跑在哪個信任邊界 | 何時參考 |
| --- | --- | --- |
| `sdk/bin/keygen.mjs` | 客戶端 | CLI：產生金鑰對、核對 `kid`。零相依單檔，可直接交付給客戶（§3） |
| `sdk/src/assertion.ts` | **客戶後端**（持有私鑰） | 簽發 Assertion；claims、有效期、`jti` 的產生方式 |
| `sdk/src/index.ts` | 客戶前端 | headless REST 客戶端 `createOAAgent()`，含 Session 自動續期 |
| `client/public/sdk/widget.js` | 客戶前端 | Widget 本體：`data-*` 設定、Token Provider、postMessage 宿主側 |
| `client/src/hostBridge.ts` | HyAgent 面板（iframe） | postMessage 協定的面板側 |
| `server/src/lib/assertion/verifier.ts` | **HyAgent 後端** | §8 步驟 0–21 的驗證規則 |
| `server/src/lib/assertion/keygen.ts` | HyAgent 後端 | `kid` 計算（客戶上傳公鑰時算出） |
| `server/src/lib/assertion/jose.ts` | HyAgent 後端 | JOSE 基礎工具；要新增支援演算法時改這裡 |
| `server/src/lib/assertion/errors.ts` | 兩端 | 錯誤碼、HTTP 狀態對照、§7.5 回應格式 |
| `server/src/lib/assertion/claim-replay-store.ts` | HyAgent 後端 | §8.5 一次性 `jti` 紀錄 |
| `server/src/modules/auth/assertion-exchange.ts` | HyAgent 後端 | 換發流程的接線：租戶解析、Origin 檢查、建立 Session |
| `server/src/modules/tenant/tenant-keys.ts` | HyAgent 後端 | §2.5、§7.3 公鑰不變條件；§4.3、§7.1、§10.4 逐租戶設定 |
| `server/src/lib/auth-session.store.ts` | HyAgent 後端 | Session 儲存，依 `kid` / `sub` 批次作廢 |

#### 測試在哪

| 測試 | 涵蓋 | 案例數 |
| --- | --- | --- |
| `server/tests/assertion-verifier.test.ts` | **§8 全部 22 項檢查**，安全性回歸基準 | 34 |
| `server/tests/assertion-keygen.test.ts` | §2.4 `kid`（含 RFC 7638 官方測試向量） | 8 |
| `server/tests/assertion-issuer.test.ts` | §4 簽發契約 | 12 |
| `server/tests/assertion-exchange.test.ts` | §5.3、§7.1、§8 換發流程接線 | 21 |
| `server/tests/auth-exchange-endpoint.test.ts` | §7.1、§7.5、§9 HTTP 契約 | 12 |
| `server/tests/tenant-public-keys.test.ts` | §2.5、§7.3 公鑰不變條件與逐租戶設定 | 25 |
| `server/tests/auth-session-store.test.ts` | §2.6、§7.1、§7.4 Session 與批次作廢 | 21 |
| `client/src/hostBridge.test.ts`、`client/src/widget.postMessage.test.ts` | §6.6 postMessage 協定（面板側、宿主側） | 19 + 19 |
| `sdk/src/keygen-cli.test.ts` | §2.4、§3 keygen CLI 與三份 `computeKid()` 的一致性 | 9 |
| `sdk/src/server.test.ts`、`sdk/src/session.test.ts` | §4 簽發、§6.5 Session 續期與登出 | 16 + 8 |

執行方式見附錄 A.1。

#### 本版相對前一版草稿的修訂

前一版以獨立的參考實作 `HyAgentSDK(js)/` 表述，本版改為對照實際產品程式。規範性規則未變，下列三處**表述**有更新：

| 項目 | 前一版草稿 | 本版（實作） |
| --- | --- | --- |
| 換發端點 | `POST /v1/sessions` | `POST /api/auth/sso/exchange`（§7.1）。`/api/v1/*` 仍可用，僅為向後相容 |
| Widget 初始化 | `HyAgent.init({ tenant, token })` | `<script>` 的 `data-*` 屬性 + `window.OAAgent`；程式化整合用 `@hyagent/sdk` 的 `createOAAgent()`（§6.2） |
| 成功回應外層 | 直接回傳資料物件 | 包在 `{ "data": { … } }` 內（本系統所有 API 一致）；錯誤回應仍為 §7.5 的扁平格式 |

---

## 2. 金鑰對規格（規範性）

> **▶ 實作**：`sdk/bin/keygen.mjs`（客戶端 CLI）、`sdk/src/assertion.ts`（客戶端函式）、
> `server/src/lib/assertion/keygen.ts`（HyAgent 端 `kid` 計算）。
> 測試：`server/tests/assertion-keygen.test.ts`、`sdk/src/keygen-cli.test.ts`

### 2.1 演算法

| 演算法 | 金鑰型別 | 強度要求 | 支援度 |
| --- | --- | --- | --- |
| `RS256` | RSA | modulus **必須** ≥ 2048 bits；**建議** 2048 或 3072 | **必要**，所有 Tenant 皆支援 |
| `ES256` | EC，曲線 `P-256`（secp256r1 / prime256v1） | 固定 256 bits | **建議**，新導入優先採用 |

- Tenant **必須**在註冊公鑰時一併宣告該公鑰使用的演算法，HyAgent 驗證時以**註冊值**為準，**不得**信任 JWT header 中的 `alg`（見 §8.2 algorithm confusion 防護）。
- **不得**使用 `none`、任何 HMAC 家族（`HS256` 等對稱演算法），或 RSA modulus < 2048 的金鑰。
- RSA 金鑰的公開指數（public exponent）**必須**為 65537（`AQAB`）。
- `ES256` 的簽章**必須**為 JWS 規定的 R‖S 原始格式（各 32 bytes，共 64 bytes），**不得**使用 DER 編碼。Node.js 須指定 `dsaEncoding: "ieee-p1363"` —— 這是最常見的實作陷阱。

> **為何建議優先採用 ES256**：相同安全強度下金鑰與簽章更小，Assertion 長度約為 RS256 的六成（實測 444 vs. 700 bytes），簽章運算也更快。

### 2.2 金鑰對的產生與保管

| 要求 | 內容 |
| --- | --- |
| 產生位置 | **必須**在客戶自有的可信環境產生（開發機、CI Secret 管理、HSM/KMS）。HyAgent **不會**、也**不得**代客戶產生或保管私鑰。 |
| 亂數來源 | **必須**使用作業系統的 CSPRNG（Node.js `crypto.generateKeyPairSync` 已符合）。 |
| 私鑰保管 | **必須**只存在於 Customer Backend。**不得**放入前端程式碼、版本控制、日誌、錯誤回報，或任何瀏覽器可觸及之處。 |
| 檔案權限 | 以檔案形式保存時**必須**限制為擁有者可讀（`0600`）。**建議**改用 KMS / Vault / Secret 管理服務。 |
| 加密保護 | 私鑰檔**建議**加上 passphrase（PKCS#8 加密）或由 KMS 託管。 |
| 公鑰 | 可公開，**得**放入版控與文件。 |

### 2.3 金鑰編碼格式

| 用途 | 格式 |
| --- | --- |
| 公鑰上傳 HyAgent | **X.509 SubjectPublicKeyInfo（SPKI）**，PEM 編碼，以 `-----BEGIN PUBLIC KEY-----` 開頭 |
| 公鑰替代格式 | **得**改以 JWK（RFC 7517）上傳；HyAgent 兩者皆接受 |
| 私鑰保存 | **PKCS#8**，PEM 編碼，`-----BEGIN PRIVATE KEY-----`（或加密後的 `-----BEGIN ENCRYPTED PRIVATE KEY-----`） |

PEM 換行符**應該**使用 LF；上傳時前後空白會被忽略。

### 2.4 `kid`（Key ID）計算（規範性）

`kid` **必須**為該公鑰依 **RFC 7638 JWK Thumbprint** 計算所得的 SHA-256 雜湊，以 Base64URL（無 padding）編碼。

Canonical JWK 的欄位順序固定，且**不含**其他欄位：

- RSA：`{"e":"<e>","kty":"RSA","n":"<n>"}`
- EC P-256：`{"crv":"P-256","kty":"EC","x":"<x>","y":"<y>"}`

```text
kid = BASE64URL( SHA-256( UTF8( canonical_jwk_json ) ) )
```

採用 Thumbprint 的好處：`kid` 由公鑰本身決定，客戶端與 HyAgent 各自計算必然一致，不需額外協調；金鑰輪替時新舊 `kid` 也天然不同。

範例（`npm run keygen` 的實際輸出，見 §3.1）：

```text
alg = RS256   kid = zBpPAlhIDV2E3GyQS4tQi9f-8bNo9nf64RZ5IYrcIXM
alg = ES256   kid = JIyMfVT7Az-6tEPXT8S10ZIdKL7K_nhi9WEqsiqdYI8
```

`kid` 的計算全專案有三份實作（客戶端 CLI、客戶端 SDK、HyAgent 後端），三份**必須**永遠一致
——不一致的症狀是客戶手上的 `kid` 與後台顯示的對不起來，而兩邊都說不出哪裡錯。
因此 `sdk/src/keygen-cli.test.ts` 會實際執行 CLI 並與 SDK 交叉比對，
且三份實作都以 RFC 7638 §3.1 的官方測試向量釘住。

### 2.5 金鑰輪替（Key Rotation）

- 一個 Tenant **得**同時註冊**最多 2 把**有效（`active`）公鑰，以支援零停機輪替。常態為 1 把，第 2 把僅在輪替期間存在。
- 一個 Tenant **必須**恆保有至少 1 把 `active` 公鑰；停用最後一把 `active` 公鑰的請求**必須**被拒絕（§7.3）。
- `active` 公鑰已達 2 把時再上傳新公鑰**必須**被拒絕；`disabled` 與 `revoked` 的公鑰不計入上限。
- Assertion 的 JWT header **必須**帶 `kid`，HyAgent 據此直接定位公鑰，不做嘗試性驗章。
- **建議**每 **12 個月**輪替一次，並在下列情形立即輪替：人員異動、私鑰疑似外洩、保管環境變更。

> **為何上限訂為 2**：2 是零停機輪替的下限——新舊公鑰並存，Customer Backend 才能滾動更新而不中斷，新金鑰若有問題也能立即切回舊私鑰。上限訂為 2 可維持「平常只有一把」的單純心智模型，避免輪替時誤停用錯誤的金鑰。

建議輪替步驟：

```text
1. 產生新金鑰對（kid = B）
2. 上傳公鑰 B → Tenant 同時有 A、B 兩把有效公鑰
3. Customer Backend 切換為以私鑰 B 簽發
4. 觀察期 ≥ 24 小時，確認無 UNKNOWN_KID / INVALID_SIGNATURE 錯誤
5. 於 HyAgent 後台停用公鑰 A
6. 銷毀私鑰 A
```

輪替期間 Tenant 會達到 2 把上限，**必須**完成步驟 5（停用公鑰 A）後才能開始下一輪輪替。若輪替期間發生私鑰外洩而已無名額，**必須**先撤銷外洩的 `kid`（§2.6）釋出名額，再上傳新公鑰。

### 2.6 金鑰撤銷（Revocation）

> **撤銷的是公鑰，不是私鑰。** 私鑰一旦外流即無法收回，攻擊者手上的複本無從銷毀。唯一有效的止血動作，是讓 HyAgent 停止信任對應的公鑰，使那把外洩私鑰失去效力。

私鑰外洩時：

1. 立即於 HyAgent 後台**撤銷**該 `kid` 對應的**公鑰**（狀態改為 `revoked`，見 §7.3）。撤銷**必須**於 **60 秒**內在所有驗證節點全面生效。
2. 以該 `kid` 建立、仍在有效期內的 HyAgent Session **必須**一併作廢，同樣於 60 秒內生效。
3. 以已撤銷 `kid` 簽發的 Assertion 一律回傳 `KEY_REVOKED`。

由於 Assertion 生命週期極短（≤ 60 秒），撤銷公鑰即可在一分鐘內阻斷外洩私鑰的所有利用，不需額外的 CRL 機制。

**「生效」的定義**：指 HyAgent **伺服器端不再接受**該公鑰簽發的 Assertion、亦不再接受該 `kid` 建立的 Session；**不是**指使用者畫面於 60 秒內登出。使用者當下若無操作，Widget 可能仍維持已登入外觀，直到下一次請求收到 `401` 才退出登入。此差異不影響安全性——攻擊者同樣無法完成任何一次請求。

**撤銷順序**：情況允許時（已知外洩但尚未被利用），**應該**先上傳新公鑰並將 Customer Backend 切換為新私鑰簽發，再撤銷外洩金鑰——被登出的使用者可立即以新金鑰重新登入。若外洩正在被利用，**必須**立即撤銷，並接受該 Tenant 在新公鑰上線前無法建立 Session。

**副作用**：撤銷會一併登出以該 `kid` 建立的**所有** Session，包含未受影響的正常使用者——系統無從分辨哪些 Session 由攻擊者建立。後台操作介面**必須**於執行前明示此影響。

HyAgent 端實作要求（規範性）：

| # | 要求 |
| --- | --- |
| 1 | 公鑰與其撤銷狀態的查詢**不得**使用 TTL 超過 **30 秒**的快取。Assertion 驗證僅發生於建立 Session 時（§7.1 續期規則下每位使用者每小時一次），QPS 極低，**建議**直接查詢後端儲存、不設快取。 |
| 2 | 撤銷狀態**必須**自 primary 讀取，**不得**讀取可能有複寫延遲的 read replica。 |
| 3 | Session 紀錄**必須**保存建立當下驗證通過的 `kid`，並支援以 `kid` 批次作廢；此欄位**必須**自第一版即納入 schema，事後補建無法涵蓋既有 Session。 |
| 4 | Session 驗證**不得**使用 TTL 超過 **30 秒**的快取。與公鑰不同，`sessionToken` 在**每次 API 呼叫**時都會被驗證，QPS 高出數個量級，將 Session 快取於行程記憶體以省去儲存層往返是常見最佳化——但該快取的 TTL 即為撤銷延遲的下限，超過 60 秒即無法滿足第 2 點。 |
| 5 | 對話層若採用 WebSocket / SSE 等長連線，**不得**僅於建立連線時檢查授權；**必須**至少每 **30 秒**重新檢查 Session 有效性，或於撤銷時主動中斷既有連線。否則撤銷前已建立的連線可繞過上述所有機制。 |

---

## 3. 金鑰對產生（客戶端）

> **▶ 實作**：`sdk/bin/keygen.mjs`（CLI）、`sdk/src/assertion.ts` 的 `generateKeyPair()`（函式）
>
> 何時用：導入第一天，以及每次金鑰輪替（§2.5）時。

金鑰對**必須**在客戶自有的可信環境產生（§2.2）。HyAgent 提供工具，但**不執行**這個動作
——「HyAgent 沒有能力偽造任何一位使用者的身分」這句話就是靠這一點成立的。

### 3.1 keygen CLI（建議）

於本 repo 根目錄：

```powershell
npm run keygen -- ES256 ./keys
```

交付給客戶時是同一支程式的單檔複本（見 §3.2），執行方式為：

```bash
node hyagent-keygen.mjs ES256 ./keys
```

輸出：

```text
{
  "alg": "ES256",
  "kid": "JIyMfVT7Az-6tEPXT8S10ZIdKL7K_nhi9WEqsiqdYI8"
}
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9t/FL/XOckBtK/rX1uOWHPbruTi8
QedC5HKYzO0vo42SSt5zm8YDbhKItNfI4GOy7kNgX9gBH603o1MYzjLUjQ==
-----END PUBLIC KEY-----

已寫入：
  <輸出目錄>\hyagent-JIyMfVT7Az…YI8.public.pem    ← 上傳 HyAgent 後台
  <輸出目錄>\hyagent-JIyMfVT7Az…YI8.private.pem   ← 自行保管，絕不外流
```

| 項目 | 說明 |
| --- | --- |
| 參數 | `[RS256\|ES256] [輸出目錄]`。演算法預設 `ES256`（§2.1 建議），輸出目錄預設 `./keys` |
| `--modulus <bits>` | RS256 的 modulus 長度，預設 2048；低於 2048 直接拒絕（§2.1） |
| `--kid <PEM 檔>` | 只計算既有金鑰的 `kid` 與演算法，不產生新金鑰。以 OpenSSL 產生時、或要與後台核對時用（§3.4） |
| 檔名 | 內含 `kid`。輪替期間會有兩把金鑰並存（§2.5），檔名認得出誰是誰才不會停用錯的那把 |
| 檔案權限 | 私鑰以 `0600` 建立（§2.2）。Windows 無 POSIX 權限位元，CLI 會提示改以 NTFS ACL 限制 |
| 需求 | Node.js 18 以上。**無任何相依套件**，不需 `npm install` |

### 3.2 客戶如何取得這支工具（交付方式）

| 方式 | 適用情境 | 取得方式 |
| --- | --- | --- |
| **單檔複本（預設）** | 一般客戶；含無外網的內網主機 | HyAgent 於導入時提供 `hyagent-keygen.mjs` 一個檔案，複製到任何裝有 Node.js 18+ 的機器即可執行 |
| 已裝有 `@hyagent/sdk` 的客戶 | 客戶後端本來就用 SDK 簽發 Assertion | 套件已註冊 `bin`，可 `npx hyagent-keygen ES256 ./keys`；或在程式中呼叫 `generateKeyPair()`（§3.3） |
| 既有工具鏈 | 客戶有自己的 PKI / HSM 流程 | 以 OpenSSL 或 KMS 產生，再用 `--kid` 核對指紋（§3.4） |

> `@hyagent/sdk` 目前隨導入交付，**尚未發佈至公開 npm registry**。日後若發佈，第二列即成為
> `npx @hyagent/sdk hyagent-keygen …` 的一行指令，CLI 本身不需要改——這也是把它放進 `sdk/bin/`
> 而非另開工具 repo 的理由。

單檔複本是預設方式，理由是**交付對象是客戶的維運人員，而這支程式一年只跑一兩次**（導入 +
輪替）。任何 `npm install`、建置步驟或 TypeScript 載入器都是一道可能卡住的關卡，卻沒有人會
為它維護一套工具鏈。因此 `sdk/bin/keygen.mjs` 刻意不 import 任何模組，只用 `node:crypto`。

代價是 `computeKid()` 在本 repo 有三份實作（CLI、`sdk/src/assertion.ts`、
`server/src/lib/assertion/keygen.ts`）。這個代價由測試承擔，見 §2.4。

**HyAgent 不提供、也不得提供的方式**：

| 方式 | 為何不做 |
| --- | --- |
| 後台網頁上按一個鈕產生金鑰 | 即使以 WebCrypto 在瀏覽器本機產生、私鑰不上傳，那段 JS 仍由 HyAgent 送出。「HyAgent 無法偽造客戶身分」就退化成「客戶每次都得審查我們送的 JS」，§1.2 的信任邊界形同虛設 |
| 由 HyAgent 代客戶產生後把私鑰寄給客戶 | §2.2 明文禁止。私鑰只要經過我方環境一次，就無法再宣稱我方不具備偽造能力 |

### 3.3 以程式產生（`@hyagent/sdk/server`）

客戶後端若已使用 SDK，可直接呼叫：

```ts
import { generateKeyPair } from '@hyagent/sdk/server';

const { alg, kid, publicKeyPem, privateKeyPem } = generateKeyPair('ES256');
// publicKeyPem → 交給 HyAgent 登記；privateKeyPem → 留在貴方環境（§2.2）
```

| 函式 | 用途 |
| --- | --- |
| `generateKeyPair(alg, { modulusLength })` | 產生符合 §2 的金鑰對，回傳 `alg` / `kid` / `publicKeyPem` / `privateKeyPem` |
| `computeKid(key)` | 依 RFC 7638 算出 `kid`（§2.4）。傳公鑰或私鑰結果相同 |
| `detectAlgorithm(key)` | 由金鑰型別推得 `RS256` / `ES256` |

`@hyagent/sdk` 目前隨導入交付（monorepo workspace，進入點為 `.ts`，需 Node 22.6 以上的
型別剝離）。**keygen 不受此限**——它是獨立的 `.mjs`，Node 18 即可執行。

### 3.4 以 OpenSSL 產生（對照）

若客戶偏好既有工具鏈：

```bash
# RS256
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem

# ES256
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

OpenSSL 不會計算 `kid`。以下列任一方式取得，三者**必須**得到相同結果：

```bash
node hyagent-keygen.mjs --kid public.pem     # CLI
```

或以 §3.3 的 `computeKid()`，或以 HyAgent 後台上傳後顯示的值為準。

### 3.5 其他語言

`kid` 與金鑰格式皆為標準規格，非 Node.js 環境**得**改用對應套件：Java 用 Nimbus JOSE+JWT 的 `JWK.computeThumbprint()`，Python 用 `authlib` / `python-jose` 的 `thumbprint()`，.NET 用 `Microsoft.IdentityModel.Tokens` 的 `ComputeJwkThumbprint()`。

---

## 4. HyAgent Identity Assertion Protocol v1（規範性）

> **▶ 實作**：簽發 `sdk/src/assertion.ts`（客戶後端）、驗證 `server/src/lib/assertion/verifier.ts`（HyAgent 後端）。
> 測試：`server/tests/assertion-issuer.test.ts`、`sdk/src/server.test.ts`
>
> 何時參考：要確認 claims 內容、有效期或 `jti` 產生方式時。

本協定定義 Customer Backend 與 HyAgent 之間的 Authentication Contract。只要雙方遵守本章，Widget 的實作技術（React、iframe、API、Node.js）如何更換都不影響整合。

### 4.1 JWT Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "zBpPAlhIDV2E3GyQS4tQi9f-8bNo9nf64RZ5IYrcIXM"
}
```

| 欄位 | 必要性 | 規則 |
| --- | --- | --- |
| `alg` | 必要 | `RS256` 或 `ES256`，**必須**與該 `kid` 註冊時宣告的演算法一致 |
| `typ` | 必要 | 固定 `JWT` |
| `kid` | 必要 | §2.4 定義的 JWK Thumbprint |

Header **不得**包含 `jku`、`jwk`、`x5u`、`x5c` 等指向外部金鑰的欄位；HyAgent 一律忽略並直接拒絕（`INVALID_ALGORITHM`）。

### 4.2 Claims

#### 4.2.1 核心 claims（必要）

| Claim | 型別 | 規則 |
| --- | --- | --- |
| `iss` | string | 簽發者，**必須**等於 Tenant ID（例如 `a3f19c2d84b7e061`）。HyAgent 換發時即以它決定租戶（§7.1） |
| `sub` | string | 使用者在該 Tenant 內的唯一識別碼。**必須**穩定且**不得**重複配發給不同人。長度 1–255 |
| `aud` | string | 固定 `hyagent`，**所有 Tenant 相同**。理由見下方說明 |
| `iat` | number | 簽發時間（UTC Unix 秒）。**不得**晚於 HyAgent 收到時的時間 |
| `exp` | number | 到期時間（UTC Unix 秒）。**必須** > `iat` |
| `jti` | string | 唯一識別碼，**建議** UUIDv4 或 128 bits 以上亂數的 Base64URL。長度 8–128 |

**`iss`、`aud`、`sub` 的分工（RFC 7519 標準語意）**

這三個 claim 各自回答一個不同的問題，**客戶識別由 `iss` 承擔，`aud` 不放客戶識別**：

| Claim | 回答什麼問題 | 值 |
| --- | --- | --- |
| `iss` | **誰簽發的？** | 客戶 → Tenant ID，例如 `a3f19c2d84b7e061`（每個客戶不同） |
| `aud` | **要給誰用的？** | 接收方 → `hyagent`（所有客戶相同） |
| `sub` | **在講誰？** | 終端使用者 → 該 Tenant 內的使用者 ID |

所以一張 Assertion 讀起來就是：「`a3f19c2d84b7e061` 這個客戶告訴 `hyagent`，目前的使用者是 `507`」。

**既然 `aud` 對所有 Tenant 都是同一個固定值，為什麼還要有它？**

它擋的是**跨服務重放**。客戶很可能拿同一把金鑰對，同時簽發 token 給自家 API、其他廠商與 HyAgent —— 這些 token 的簽章全都有效，光靠驗章無法分辨。`aud` 讓 HyAgent 能拒絕「這張不是開給我的」，這正是 §8.4 步驟 11 檢查 `aud` 的理由。

同理，Tenant **不得**把 `aud` 當成自己的識別欄位使用；跨 Tenant 冒用是由 `iss` 加上 `kid` 查表擋下的（§8.2 步驟 6、§10.6）。

由於所有環境共用 `aud = hyagent`，測試與正式環境的隔離**必須**改由不同的 Tenant ID 與金鑰對達成，不可依賴 `aud`。

> `sub` **不建議**直接使用 email —— email 會變更且可能被重新配發給他人。**建議**使用內部不可變的使用者 ID，需要 email 時另放在 §4.2.2 的 `email`。

#### 4.2.2 標準身分 claims（選填）

| Claim | 型別 | 說明 |
| --- | --- | --- |
| `name` | string | 顯示名稱，Widget 用於稱呼使用者 |
| `email` | string | 電子郵件 |
| `picture` | string | 頭像 URL，**必須**為 `https://` |
| `roles` | string[] | 角色清單，供 HyAgent 端授權或知識庫範圍控制 |
| `locale` | string | BCP 47 語言標籤，例如 `zh-TW` |

#### 4.2.3 Tenant 自訂 claims（選填）

Tenant 得加入自訂 claims 以承載組織資訊。為避免與未來的標準 claims 衝突：

- 自訂 claims **應該**集中在 `hyagent:profile` 物件下，或
- 以貴方系統的簡短代號為前綴，例如 `hyoa_deptId`。

  > 前綴請用**自己取的短代號**，不要用 Tenant ID——它是 16 位十六進位字串，
  > 當前綴既不可讀，每個 claim 還要多付 17 bytes，很快就會逼近 §4.2.4 的 4096 bytes 上限。

HyAgent 對自訂 claims **只做型別與大小驗證，不做語意解讀**，並原樣提供給該 Tenant 的 Agent 設定使用。

**既有 SSO 欄位的落點**：企業入口既有 SSO token 常帶的組織欄位（`deptId`、`deptName`、`companyId`、`companyName`、`jobPost`、`jobPostName` 等）皆屬本類別，遷移時直接置於 `hyagent:profile` 之下即可（§4.4 範例），不需為它們新增標準 claims。

#### 4.2.4 大小限制

Assertion 序列化後（compact serialization 的完整字串，含兩個 `.`）**不得**超過 **4096 bytes**。超過者回傳 `ASSERTION_TOO_LARGE`（HTTP 413）。

此上限**必須**在任何解碼與驗章之前檢查（§8.0 步驟 0）。訂定理由如下：

| 理由 | 說明 |
| --- | --- |
| **驗章前的 DoS 防線** | §8.1 的 Base64URL 解碼與 `JSON.parse`、§8.3 的 RSA / ECDSA 驗章，成本都與輸入長度成正比，而且**未持有任何金鑰的攻擊者即可觸發**。長度是唯一不必信任內容就能判斷的屬性，因此是唯一能置於信任邊界之外的檢查 |
| **傳輸層本來就有硬性上限** | Assertion 走 `Authorization: Bearer`（§7.1）。nginx `large_client_header_buffers` 預設 8 KB、Apache `LimitRequestFieldSize` 預設 8190 bytes、多數 CDN 與負載平衡器為 8–16 KB。超限的請求會在抵達應用程式前被 431 / 502 擋掉，客戶端只看到無從診斷的錯誤。4096 訂在最低的那條線之下，並保留餘裕給其他 header |
| **限制自訂 claims 擴散** | §4.2.3 的自訂 claims 由 HyAgent 原樣傳遞給 Agent 設定使用，不做語意解讀。大小上限是這個「原樣放行」政策的配套煞車，避免整份組織資料被夾帶進每一次請求、每一筆日誌與 Session 狀態 |
| **讓問題在簽發端就暴露** | 限制寫入契約後，Tenant 能在簽發時自行檢查（參考實作的 `MAX_ASSERTION_BYTES`），而非上線後才在 proxy 層踩到 |

**為何訂在 4096**：上界由傳輸層決定——取上表最低的 8190 bytes，再留約一半餘裕給 `Authorization: Bearer ` 前綴與其餘 header；下界由實際用量決定。以 `sdk/src/assertion.ts` 的 `issueAssertion()` 實測各金鑰強度與 claims 負載（`Buffer.byteLength` 量測完整 JWT 字串，單位 bytes）：

| 金鑰 | 僅核心 claims | §4.4 完整範例 | 重度使用 ※ |
| --- | --- | --- | --- |
| ES256（P-256） | 372 | 634 | 1962 |
| RS256（2048） | 628 | 890 | 2218 |
| RS256（3072） | 798 | 1060 | 2388 |
| RS256（4096） | 969 | 1231 | 2559 |

※ 10 個 `roles` + 20 個中文自訂欄位 + `picture` + `locale`，已遠超一般 Tenant 的預期用量。

常態情境（§4.4 範例）僅佔上限的 15 ～ 30%；最壞情況（RSA-4096 金鑰搭配重度 claims）為 2559 bytes，仍在 63%。即使以 RSA-4096 這個最不利的固定成本計算，4096 仍留給 payload 約 2400 bytes 以上的 JSON 空間。

因此 **4096 對所有合規組合都有充裕餘裕，同時穩穩落在傳輸層底線之下**。Tenant 若逼近此上限，正確做法是精簡 claims、把大量組織資料改由 Agent 端以 `sub` 查詢，而非要求放寬上限——Assertion 是兌換券，不是資料傳輸通道（§4.3）。

### 4.3 生命週期

| 項目 | 值 |
| --- | --- |
| 建議有效期 | **60 秒**（`exp - iat = 60`） |
| 最大有效期 | **300 秒**；超過即視為不合契約（`INVALID_CLAIMS`） |
| Clock skew 容忍 | 預設 **15 秒**，HyAgent 後台可逐 Tenant 設為 **0 ～ 30 秒**，且**不得**超過該 Tenant 有效期的 ¼（§10.4）。雙方仍**必須**以 NTP 校時 |
| 用途 | **一次性**。成功兌換 HyAgent Session 後即作廢 |

Assertion 是**兌換券**不是 Session：它的唯一用途是換取 HyAgent Session，之後的所有呼叫都使用 HyAgent Session。

### 4.4 完整範例

Header / Payload（RS256，企業內部入口情境）：

```json
{ "alg": "RS256", "typ": "JWT", "kid": "zBpPAlhIDV2E3GyQS4tQi9f-8bNo9nf64RZ5IYrcIXM" }
```

```json
{
  "iss": "a3f19c2d84b7e061",
  "sub": "507",
  "aud": "hyagent",
  "iat": 1789112203,
  "exp": 1789112263,
  "jti": "7e83e67e-9e2d-49fb-980f-bb4b9ef0c0ac",
  "name": "羅玉瑩",
  "email": "yuying@example.com",
  "roles": ["staff"],
  "hyagent:profile": {
    "companyId": 1,
    "companyName": "凌網",
    "deptId": 10,
    "deptName": "財務部",
    "jobPost": "M10",
    "jobPostName": "協理"
  }
}
```

### 4.5 簽發（實作）

> **▶ 實作**：`sdk/src/assertion.ts`

客戶後端以 `@hyagent/sdk/server` 簽發，不需自行實作 JWS：

```ts
import { issueAssertion } from '@hyagent/sdk/server';

const assertion = issueAssertion({
  privateKey: process.env.HYAGENT_PRIVATE_KEY!, // PKCS#8 PEM，建議來自 KMS / Vault
  tenant: 'a3f19c2d84b7e061',                   // → iss
  subject: user.id,                             // → sub
  profile: { name: user.displayName, email: user.email, roles: user.roles },
});
```

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `privateKey` | 必要 | PKCS#8 PEM、Buffer 或 `KeyObject`。**只在客戶後端載入** |
| `tenant` | 必要 | 成為 `iss`（§8.4 步驟 10 要求它等於 Tenant ID） |
| `subject` | 必要 | 成為 `sub` |
| `alg` / `kid` | 由私鑰推得 | 省略時自動偵測演算法並計算 RFC 7638 Thumbprint |
| `profile` | `{}` | 自訂 claims，原樣帶過（§4.2.3）。含 `iss`/`sub`/`aud`/`iat`/`exp`/`jti` 任一者直接拒絕簽發 |
| `lifetimeSeconds` | 60 | 上限 300（§4.3） |
| `audience` | `hyagent` | §4.2.1 固定值 |

實作上有三點與規格直接對應，自行實作時特別容易漏：

| 規則 | 實作做法 |
| --- | --- |
| §8.5 每張都要能被擋重放 | **每次呼叫都產生新的 `jti`**（`randomUUID()`）。這也是 §6.5 要求 token provider「每次回傳當下新簽發的字串」的原因：快取重用會被 `TOKEN_REPLAYED` 拒絕 |
| §2.1 ES256 簽章格式 | Node 預設輸出 DER，**必須**指定 `dsaEncoding: 'ieee-p1363'` 才是 JWS 要求的 R‖S 串接。這是最常見的實作陷阱，`jsonwebtoken` 之類的套件不一定控制得到——SDK 因此直接用 `node:crypto` |
| §4.2.4 大小上限 | 簽發端就檢查並丟 `RangeError`，比等到上線後在 proxy 層踩到容易定位 |

若需綁定同一組金鑰與 Tenant 重複簽發，改用 `AssertionIssuer`：

```ts
const issuer = new AssertionIssuer({ privateKey, tenant: 'a3f19c2d84b7e061' });
const assertion = issuer.issue(user.id, { name: user.displayName });
```

實測長度（`sdk/bin/keygen.mjs` 產生的金鑰 + `issueAssertion()`，僅核心 claims）：

```text
ES256  372 bytes
RS256  628 bytes（modulus 2048）
```

加上 `name`、`email`、`roles` 與 §4.4 的自訂 claims 後分別約為 634 / 890 bytes，距 §4.2.4 的 4096 bytes 上限仍有充裕空間（完整量測見 §4.2.4）。

---

## 5. 客戶網站整合規格

### 5.1 Step 1：註冊 Tenant 並上傳公鑰

> **▶ 實作**：金鑰產生 `sdk/bin/keygen.mjs`（§3.1）；公鑰上傳與狀態管理
> `admin/src/pages/tabs/AssertionKeysPanel.tsx` → `server/src/modules/tenant/tenant-keys.ts`

1. 於 HyAgent 網站註冊 Tenant，取得 Tenant ID。
2. 依 §3 產生金鑰對。
3. 將**公鑰**上傳 HyAgent 網站；**私鑰**留在客戶自家環境保管。
4. 登記允許嵌入 Widget 的來源網域（Allowed Origins）。
5. （選填）設定 HyAgent Session 有效期，預設 3600 秒，範圍 300 ～ 28800 秒（§7.1）。

**Tenant ID 格式**：HyAgent 於註冊時產生的 **16 位小寫十六進位字串**，`^[0-9a-f]{16}$`，
全系統唯一，註冊後不可變更（實作：`server/src/modules/tenant/tenant.store.ts` 的
`randomBytes(8).toString('hex')`）。

客戶**不得**自行指定：識別碼由 HyAgent 統一配發，避免客戶之間搶名稱，也避免 Tenant ID
洩漏客戶的組織名稱（它會出現在 Assertion 的 `iss` 與錯誤訊息裡）。

視之為**不透明識別碼**——不要從中推導任何語意，也不要假設它的長度或字元集在未來不變；
需要顯示給人看的名稱請用後台的 Tenant 顯示名稱，那是可隨時修改的標籤，與此識別碼無關。

> **保留值**：`default` 為 HyAgent 內部向後相容用的租戶識別碼，不符上述格式，也**不會**
> 配發給客戶。客戶端不應收到、也不應送出這個值。

註冊完成後客戶持有：

```text
Tenant ID       : a3f19c2d84b7e061
Algorithm       : RS256
Key ID (kid)    : zBpPAlhIDV2E3GyQS4tQi9f-8bNo9nf64RZ5IYrcIXM
Allowed Origins : https://oa.hyweb.com.tw
Session 有效期  : 3600 秒（預設，可調 300～28800）
Public Key      : （已上傳 HyAgent）
Private Key     : （自行保管，絕不外流）
```

**Allowed Origins** 為 Widget 的嵌入白名單：HyAgent 會檢查 iframe 的 `document.referrer` / `postMessage` origin 與 API 請求的 `Origin` header，非白名單來源一律拒絕（`ORIGIN_NOT_ALLOWED`）。此機制可防止 Assertion 被側錄後在他站重放。

比對依據依呼叫端而不同（實作：`assertion-exchange.ts` 的 `resolveEmbedOrigin()`）：

| 呼叫端 | 依據 | 要登記的網域 |
| --- | --- | --- |
| Widget（iframe） | 面板讀到的 `document.referrer`，即**嵌入 Widget 的頁面** | 放 `<script>` 的那些頁面網域 |
| headless SDK | 瀏覽器設定的 `Origin`，即**跑 SDK 的頁面** | 同上 |

兩者都由瀏覽器設定，嵌入方無法偽造。**不需要**、也不應該把 HyAgent 自己的網域加進白名單
——那對所有 Tenant 都一樣，加了等於讓這道檢查失效。

### 5.2 Step 2：Customer Backend 的 Identity Endpoint

> **▶ 實作**：`presale/widge-tenant/server.mjs`（可執行的 `node:http` 版本，與下方 Express 版邏輯相同）

客戶**必須**在自家後端開一個端點供前端取得 Assertion，而不是在伺服器端渲染頁面時就把 Assertion 嵌進 HTML —— 理由見 §6.5「為什麼 `token` 是『函式 + 後端端點』」。此端點用哪種語言或框架實作不影響契約。

```text
GET /api/mybot/identity
```

| 項目 | 規範 |
| --- | --- |
| 認證 | **必須**以客戶網站**自家的登入 Session**（Cookie / Bearer）判定使用者身分。**不得**接受由前端傳入的 user id 等身分參數 |
| 未登入 | 回傳 `401`，且**不得**簽發 Assertion |
| 成功回應 | `200`，`Content-Type: application/json` |
| 快取 | **必須**帶 `Cache-Control: no-store`（避免 Assertion 被 CDN / 瀏覽器快取） |
| CSRF | 為 `GET` 且不改變狀態，但**應該**要求 `Sec-Fetch-Site: same-origin` 或自訂 header，避免被他站以簡單請求取走 |
| 速率限制 | **建議**以使用者為單位限制，例如 60 次/分鐘 |

成功回應格式：

```json
{
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Indy...",
  "expiresIn": 60
}
```

Express 實作範例：

```js
import express from "express";
import { readFileSync } from "node:fs";
import { issueAssertion } from "@hyagent/sdk/server";

const app = express();

// 私鑰只在後端載入一次；來源建議為 KMS / Vault / 環境變數，而非 repo 內檔案。
const PRIVATE_KEY = readFileSync(process.env.HYAGENT_PRIVATE_KEY_PATH, "utf8");
const TENANT = process.env.HYAGENT_TENANT;

app.get("/api/mybot/identity", (req, res) => {
  // ① 身分一律取自自家 Session，絕不取自 query / body / header。
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  }

  // ② 以私鑰簽發 60 秒短效 Assertion。
  //    alg 與 kid 省略時由私鑰推得，不必自行維護（見 §4.5）。
  const token = issueAssertion({
    privateKey: PRIVATE_KEY,
    tenant: TENANT,
    subject: user.id,
    lifetimeSeconds: 60,
    profile: {
      name: user.displayName,
      email: user.email,
      roles: user.roles,
      "hyagent:profile": {
        companyId: user.companyId,
        companyName: user.companyName,
        deptId: user.deptId,
        deptName: user.deptName,
      },
    },
  });

  // ③ 絕不可被快取。
  res.set("Cache-Control", "no-store");
  res.json({ token, expiresIn: 60 });
});
```

### 5.3 Step 3：前端掛上 Widget

> **▶ 實作**：`client/public/sdk/widget.js`；可執行範例 `presale/widge-tenant/index.html`（widget）、
> `presale/sdk-custom-ui/`（自建 UI）

一行 `<script>`，宿主頁**不需要寫任何 JavaScript**：

```html
<script src="https://{hyagent-host}/sdk/widget.js"
        data-key="pk_…"
        data-token-url="/api/mybot/identity"
        async></script>
```

| 屬性 | 必要 | 說明 |
| --- | --- | --- |
| `src` | ✅ | 固定 `https://{hyagent-host}/sdk/widget.js`（`{hyagent-host}` 見 §1.4）。面板 iframe 的來源由它推得，**不可**自行複製到客戶網域託管 |
| `data-key` | 建議 | 租戶公開金鑰 `pk_…`。決定外觀設定與 CORS；**不參與身分判定**（租戶由 Assertion 的 `iss` 決定，見 §7.1） |
| `data-token-url` | 登入模式必要 | 客戶自家的 Identity Endpoint（§5.2）。省略則面板以匿名模式運作，使用者自行登入 |

其餘外觀類屬性（`data-title`、`data-theme`、`data-position`、`data-launcher` 等）見 §6.2。

此路徑**不含版本號**且**可變**——HyAgent 得就地更新以推送修補，客戶頁面不需變更（§6.1、§11.1）。

**為什麼是 `data-token-url` 而不是直接給一段 token**：Assertion 只有 60 秒有效且為一次性
兌換券，寫死在標籤上的那張，到使用者真的點開面板時多半已失效或已用過。完整理由見 §6.5。

自建 UI（不使用內建 Widget）時改用 headless SDK：

```ts
import { createOAAgent } from '@hyagent/sdk';

const oa = createOAAgent({
  key: 'pk_…',
  // token provider：傳函式而非字串，SDK 會在 Session 到期前 60 秒與收到 401 時自動再取一張
  assertion: () =>
    fetch('/api/mybot/identity', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.token ?? null),
});
```

### 5.4 Step 4：HyAgent 驗證並建立 Session

HyAgent 後端依 §8 逐項驗證後建立 HyAgent Session，Widget 即可顯示已登入狀態。此步驟對客戶端透明，由 SDK 自動完成。

---

## 6. Widget SDK API 規格（規範性）

### 6.1 載入

> **▶ 實作**：`client/public/sdk/widget.js`、`sdk/src/index.ts`

| 方式 | 用法 | 掛在哪 |
| --- | --- | --- |
| Script tag（建議） | `<script src="https://{hyagent-host}/sdk/widget.js" data-key="pk_…" data-token-url="/api/mybot/identity" async></script>` | `window.OAAgent` |
| npm | `import { createOAAgent } from '@hyagent/sdk'` | 呼叫端自行持有回傳的 client |

`@hyagent/sdk` 隨導入交付（monorepo workspace，進入點為 `.ts`，需 Node 22.6 以上的型別剝離）；
自建 UI 或需要程式化控制時才需要它，單純掛 Widget 只要一行 `<script>`。

SDK 以**單一可變路徑**發佈：HyAgent **得**就地更新該檔案以推送安全修補與相容性修正，客戶頁面不需變更。路徑中**不含版本號**——本規格不設協定版本（§11.1），SDK 的 JS API 亦以向後相容為原則（規則見 §11.1「SDK 檔案版本」）。

本版**不強制** SRI（Subresource Integrity）。SRI 防護的是 HyAgent 託管環境或 CDN 遭入侵後檔案被替換；但在該情境下後端 API 回應同樣可被竄改，SRI 只保護單一檔案、保護不了整條資料流，而強制 SRI 會使可變路徑無法就地更新，等於放棄緊急修補能力。權衡後本版採可變路徑優先。

> **未來擴充**：若後續有客戶因 CSP 或合規要求必須釘選，**得**於新的 minor 版本增設不可變的精確版本路徑（形式為 `/sdk/{semver}/widget.js`）並公佈其 SRI 雜湊值，與可變路徑並存；屆時該精確版本路徑**不得**就地改寫。本版不提供此路徑。

### 6.2 設定項

Widget 的設定全部走 `<script>` 標籤的 `data-*` 屬性，宿主頁不需要呼叫任何初始化函式。

| 屬性 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `data-key` | string | — | 租戶公開金鑰 `pk_…`。決定外觀設定與 CORS；**不參與身分判定**（§7.1） |
| `data-token-url` | string | — | Identity Endpoint（Token Provider，§6.5）。省略則以匿名模式運作 |
| `data-api` | string | 與 `src` 同網域 | API 來源。前後端分開部署時**必須**指定 server 的對外網址 |
| `data-title` | string | 租戶後台的 AI 名稱，皆未設則 `OA 小幫手` | 浮動按鈕文案 |
| `data-form` | string | — | 預選表單類型 |
| `data-locale` | string | 面板預設語系 | 介面語言，例如 `zh-Hant` |
| `data-theme` | `light` \| `dark` | 租戶後台設定 | 外觀主題 |
| `data-position` | `br` \| `bl` \| `tr` \| `tl` | `br` | 浮動按鈕位置（相容舊值 `right` / `left`） |
| `data-size` | 40 \| 44 \| 48 \| 52 \| 56 | 56 | 啟動按鈕尺寸（px）。其他值視為未設 |
| `data-offset-x` / `data-offset-y` | number | 20 | 距邊距（px，0 ～ 200）。調高可避開頁面既有的 go-to-top 按鈕 |
| `data-launcher` | `none` | — | 不顯示內建浮動按鈕，改由宿主自家按鈕呼叫 `OAAgent.open()` |

宿主未指定的外觀項目由該租戶的後台設定決定；**同一頁重複載入只會初始化一次**。

`data-user-token`（靜態憑證）**已移除**：仍帶著它時 Widget 會忽略並於 console 警告，理由見 §6.5。

程式化整合（自建 UI、React / Vue 應用）改用 `@hyagent/sdk` 的 `createOAAgent(options)`：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `key` | string | 同 `data-key` |
| `assertion` | `string \| () => string \| null \| Promise<…>` | Token Provider。**建議傳函式**；字串形式只能換一次 Session，到期後無法續期 |
| `tokenUrl` | string | 交給內建 Widget 用（`loadWidget()` 時轉成 `data-token-url`） |
| `apiBase` | string | API 來源網域；省略則同源 |
| `widgetSrc` | string | `loadWidget()` 注入的 `widget.js` 位址；省略則為 `${apiBase}/sdk/widget.js` |

### 6.3 方法

**內建 Widget（`window.OAAgent`）**，載入 `widget.js` 後可用：

| 方法 | 說明 |
| --- | --- |
| `open()` / `close()` / `toggle()` | 開關對話視窗 |
| `expand()` / `collapse()` | 放大／還原（放大後面板置中並蓋上背景遮罩） |
| `onEvent(fn)` | 事件回呼，可在 `widget.js` 載入**前**先指定，載入後會保留 |

**headless SDK（`createOAAgent()` 的回傳值）**：

| 方法 | 說明 |
| --- | --- |
| `authenticate()` | 以 Token Provider 換發 Session（不回報成敗） |
| `refreshIdentity()` | 同上但回傳 `boolean`。使用者於宿主網站**切換帳號**後**必須**呼叫。SDK 另會在到期前 60 秒與收到 `401` 時自動呼叫 |
| `logout()` | 通知後端作廢 Session（§7.2）並清除本地憑證。使用者登出宿主網站時**必須**呼叫 |
| `conversations` / `forms` | 對話與表單的 REST 操作 |
| `on(event, handler)` | 訂閱 Widget 事件，回傳取消訂閱函式 |
| `open()` / `close()` / `toggle()` | 轉呼叫 `window.OAAgent` 的同名方法 |
| `loadWidget()` | 動態注入 `widget.js`，並帶上本 SDK 的 `key` / `tokenUrl` |

> Session 續期與作廢是**伺服器端有狀態**的（§7.1）：只清除瀏覽器那一份，等於留一張仍可用的
> 票在後端直到自然過期，因此登出**必須**經 `logout()`。

### 6.4 事件

Widget 以 DOM `CustomEvent` 發出，事件名前綴 `oa-agent:`；同一則事件也會送進 `OAAgent.onEvent`。

| 事件 | 觸發時機 | detail |
| --- | --- | --- |
| `oa-agent:submitted` | 表單送出成功（由面板轉發） | `{ submission }` |
| `oa-agent:close` | 使用者於面板內關閉對話視窗 | — |
| `oa-agent:expand` | 面板放大／還原 | `{ expanded }` |

```js
window.addEventListener('oa-agent:submitted', (e) => {
  console.log(e.detail.submission); // 例如關閉自家彈窗、導向申請紀錄頁
});
```

headless SDK 以 `oa.on('submitted' | 'close', handler)` 訂閱同一組事件。
`on('open')` 的型別存在，但目前**沒有事件來源**——需要偵測開啟時，請以宿主自己呼叫
`OAAgent.open()` 的時點為準。

### 6.5 Token Provider 契約（規範性）

> **▶ 實作**：宿主側 `client/public/sdk/widget.js` 的 `callTokenProvider()`；
> headless 側 `sdk/src/index.ts` 的 `nextAssertion()` / `exchangeIdentity()`

Widget 需要身分時，會以下列方式向 `data-token-url` 取一張憑證：

```text
GET <data-token-url>
credentials: include        ← 帶 cookie，由宿主自己的登入狀態決定發給誰
accept: application/json
cache: no-store             ← 端點若被快取，拿回來的會是同一張已用過的票
```

| 規則 | 內容 |
| --- | --- |
| 呼叫時機 | ① 面板需要身分時（開啟面板後的第一次 `identity:request`）；② Session 到期前 **60 秒**；③ 收到 `401` 需重新換發時；④ headless SDK 呼叫 `refreshIdentity()` 時 |
| 回傳值 | **必須**回傳**當下新簽發**的 Assertion。回應形狀接受 `{"token":…}`（規格格式），並相容 `{"assertion":…}`、`{"userToken":…}` 與包在 `{"data":{…}}` 內的形式 |
| 禁止快取 | 客戶端**不得**快取 Assertion 重複回傳。Assertion 為一次性，重複使用會被 `TOKEN_REPLAYED` 拒絕 |
| 逾時 | 單次請求等待上限 **10 秒** |
| 失敗重試 | 僅 `5xx` 與網路錯誤重試，指數退避 1s / 2s / 4s（連同首次共 4 次嘗試）。`401` / `403` 視為「使用者未登入宿主網站」，**不重試** |
| 全數失敗 | **不會**擋住面板：console 留下警告，面板照常開啟，使用者改為自行登入 |
| 儲存 | **不得**將 Assertion 寫入 `localStorage`、`sessionStorage` 或 Cookie；僅保留在記憶體中直到換得 Session |
| 單一飛行 | 同時湧入的請求共用一次換發，避免一口氣燒掉好幾張一次性憑證 |

> 續期會**再打一次** Identity Endpoint，因此它必須能被重複呼叫。建議的速率限制
> （60 次/分鐘/使用者，§5.2）對這個頻率綽綽有餘：一小時的 Session 正常只會續期一次。

#### 為什麼 `token` 是「函式 + 後端端點」，而不是直接給一個字串？

整合時最自然的想法，是在伺服器端渲染頁面時就把 Assertion 嵌進去：

```html
<!-- ❌ 只有第一次能用；本實作已移除 data-user-token，帶了只會收到 console 警告 -->
<script src="https://{hyagent-host}/sdk/widget.js"
        data-user-token="eyJhbGciOiJSUzI1NiIs..."></script>
```

這種寫法在頁面剛載入時可以運作，但會在三種情況下壞掉：

| 情況 | 結果 |
| --- | --- |
| 使用者把分頁開著，直到 HyAgent Session 需要換發 | SDK 回頭呼叫 provider，拿到的仍是同一張早已過期的 Assertion → `TOKEN_EXPIRED`，Widget 掉回匿名模式 |
| 使用者按上一頁，或頁面由 bfcache 還原 | 同一張 Assertion 被再次送出 → `TOKEN_REPLAYED` |
| 頁面被瀏覽器或 CDN 快取 | 內嵌的 Assertion 一併被快取，等同機敏資料外洩（違反 §10.1） |

根本原因是 **Assertion 的有效期只有 60 秒，而且是一次性的兌換券**（§4.3、§8.5）。靜態字串只能代表「頁面渲染當下」那一瞬間的身分，無法滿足上表「呼叫時機」欄列出的後三種換發需求。

因此契約要求身分來源是一個**每次被取用都能拿到當下新簽發 Assertion** 的端點（`data-token-url`），
headless SDK 則對應成一個函式（`assertion: () => …`）。而要讓前端能重複取得新 Assertion，簽發動作就必須放在後端端點 —— 私鑰不能下放到瀏覽器（§2.2），前端唯一的合法途徑就是去問自己的後端。這也是 §5.2 要求客戶開一個 Identity Endpoint 的理由。

端點**必須**架在宿主自己的後端（Next.js route handler、Vercel Function、既有 API 皆可）。
純靜態站台（完全沒有後端）無法安全地完成這件事，只能讓使用者在面板內自行登入。
端點架在別的網域也可以（`data-token-url` 收絕對網址），但那時要自行設好帶 credentials 的 CORS。

順帶的好處是，這個設計對客戶的後端技術完全中立：端點用 Node、Java Servlet、PHP、.NET 或任何語言實作都不影響契約，前端的寫法也完全相同。

### 6.6 `postMessage` 協定（規範性）

Host Page 與 Widget iframe 之間的訊息格式：

```ts
interface HyAgentMessage {
  source: "hyagent";      // 訊息識別，非本值一律忽略
  version: 1;
  type: string;           // 例如 "identity:request"、"identity:response"
  requestId?: string;     // 請求/回應配對
  payload?: unknown;
}
```

雙向**必須**驗證 origin：

- Host Page → iframe：`postMessage(message, HYAGENT_ORIGIN)`，**不得**使用 `"*"`。
- iframe → Host Page：`postMessage(message, hostOrigin)`，`hostOrigin` 取自初始化握手時登記的值。
- 接收端**必須**同時檢查 `event.origin` 與 `event.source`，並確認 `message.source === "hyagent"`。

主要訊息型別：

| type | 方向 | 說明 |
| --- | --- | --- |
| `handshake` | iframe → host | iframe 就緒，回報自身 origin 與協定版本 |
| `identity:request` | iframe → host | 要求 Host Page 呼叫 Token Provider |
| `identity:response` | host → iframe | 回傳 Assertion，或 `{ error: { code } }`（`NO_TOKEN_PROVIDER` / `TOKEN_PROVIDER_FAILED`） |
| `ui:close` | iframe → host | 面板內按下關閉 |
| `ui:expand` | iframe → host | 面板內按下放大／還原 |
| `ui:state` | host → iframe | 回報目前是否放大、以及視窗寬度能不能放大 |
| `event` | iframe → host | 轉發 §6.4 的事件（`payload.name` / `payload.detail`） |

`identity:request` 與 `identity:response` 以 `requestId` 配對；面板等待回應的上限為 **55 秒**
——必須大於宿主側 Token Provider 的最壞重試預算（10 秒逾時 + 1s/2s/4s 退避），否則面板會在
宿主頁仍在重試時就自行放棄。

**憑證只走 postMessage，不進 URL**：query string 會殘留於瀏覽器歷史、`Referer` header 與
伺服器存取日誌這三個不受控的地方（§10.1）。宿主頁不需要為此寫任何程式碼——`widget.js` 已包辦。

### 6.7 Content Security Policy

客戶網站若設有 CSP，**必須**放行：

```text
script-src  https://{hyagent-host}
frame-src   https://{hyagent-host}
connect-src https://{hyagent-host}
img-src     https://{hyagent-host} data:
```

---

## 7. HyAgent 後端 API 規格（規範性）

Base URL：`https://{hyagent-host}`。所有端點**必須**經 TLS 1.2 以上，並帶 `Strict-Transport-Security`。

### 7.1 建立 Session

> **▶ 實作**：`server/src/modules/auth/auth.routes.ts` → `auth.controller.ts` → `assertion-exchange.ts`；
> 測試 `server/tests/auth-exchange-endpoint.test.ts`、`assertion-exchange.test.ts`

```http
POST /api/auth/sso/exchange
Content-Type: application/json
Origin: https://oa.hyweb.com.tw
```

```json
{ "assertion": "<Identity Assertion>", "embedOrigin": "https://oa.hyweb.com.tw" }
```

成功（`201`）：

```json
{
  "data": {
    "sessionToken": "hyas_01J8F3K7Q2...",
    "expiresIn": 3600,
    "user": { "sub": "507", "name": "羅玉瑩" }
  }
}
```

| 項目 | 規範 |
| --- | --- |
| Tenant 來源 | **Assertion 的 `iss`**。`x-api-key`（`pk_…`）只影響外觀設定與 CORS，**不參與身分判定**——兩者並存而未交叉檢查，等於開出跨租戶混淆的漏洞 |
| `assertion` | 置於 JSON body。**不得**放入 URL query string（§10.1） |
| `embedOrigin` | Widget 面板專用：面板自 `document.referrer` 讀到的嵌入者 origin。`Origin` header 屬第三方站台時**必須**以 header 為準，此欄位一律忽略（否則他站只要在 body 裡填上受害者網域即可繞過 §8.6） |
| `sessionToken` | 不透明字串，Widget **不得**解析其內容 |
| `expiresIn` | Session 有效秒數。預設 **3600**，Tenant **得**於註冊時設定為 **300 ～ 28800** 之間的值。**應該**設為不長於客戶自家 session 的有效期，理由見 §10.5 |
| 儲存 | SDK 僅保存在 HyAgent 網域的記憶體 / `sessionStorage`，不與 Host Page 共享 |
| 續期 | **沒有 refresh token**：到期前 60 秒重走 Token Provider 換一張新的 Assertion，再換新 Session |
| 作廢 | Session **必須**為伺服器端有狀態儲存（**不得**為 self-contained JWT），並記錄建立時驗證通過的 `kid`，以支援 §2.6 的批次作廢 |
| 儲存內容 | 實作另將 `sessionToken` 以 sha256、`sub` 以 HMAC + 靜態加密落地（`server/src/lib/auth-session.store.ts`）：資料庫或快照外洩不等於一批可直接使用的有效 Session |

> `/api/v1/sso/exchange` 等 `/api/v1/*` 路徑仍可用（伺服器內部改寫為 `/api/*`），僅為向後相容，新整合請用無 `/v1` 的路徑。

### 7.2 結束 Session

> **▶ 實作**：`server/src/modules/auth/auth.controller.ts` 的 `logout()`

```http
POST /api/auth/logout
Authorization: Bearer <sessionToken>
```

回傳 `204`，對應 SDK 的 `logout()`（§6.3）。Session 是伺服器端有狀態的，只清瀏覽器那一份
等於留一張仍可用的票在後端直到自然過期，因此登出**必須**呼叫本端點。

以帳密登入的 JWT 打這支是 no-op，同樣回 `204`。

### 7.3 公鑰管理

> **▶ 實作**：`admin/src/pages/tabs/AssertionKeysPanel.tsx`（後台 UI）→
> `server/src/modules/admin/admin.routes.ts` / `admin.controller.ts` →
> `server/src/modules/tenant/tenant-keys.ts`（不變條件）；測試 `server/tests/tenant-public-keys.test.ts`

公鑰管理**僅**經 **HyAgent 後台 UI** 操作，**不對外開放 API**。公鑰的上傳、查詢與停用 / 撤銷一律在後台進行，HyAgent **不得**對外提供等效端點。

> **理由**：公鑰是 Tenant 的信任根，但管理動作屬低頻操作——只在導入、§2.5 輪替與 §2.6 撤銷時發生。對外開放等於為了省下少數幾次操作，換來一組必須長期保管與輪替的管理憑證，攻擊面（憑證外洩即可置換信任根）遠大於效益。後台介面另可在撤銷等破壞性操作前強制二次確認（§2.6），這是 API 給不了的。

下表為後台介面背後的內部語意，**僅供理解狀態機與不變條件，非對外契約，不保證穩定**：

| 操作 | 內部端點 | 說明 |
| --- | --- | --- |
| 上傳公鑰 | `POST /api/admin/tenants/{tenant}/assertion-keys` | body 含 `publicKey`（SPKI PEM 或 JWK）與選填 `label`。`alg` 與 `kid` **一律由後端算出**，不接受呼叫端指定 |
| 列出公鑰 | `GET /api/admin/tenants/{tenant}/assertion-keys` | 公鑰與狀態（`active` / `disabled` / `revoked`）、逐租戶設定、近期時鐘偏移統計（§10.4） |
| 變更狀態 | `PATCH /api/admin/tenants/{tenant}/assertion-keys/{kid}` | body `{ status }`。撤銷會**連帶作廢**以該 `kid` 建立的所有 Session，回應帶 `revokedSessions` 筆數 |
| 逐租戶設定 | `PATCH /api/admin/tenants/{tenant}/assertion-settings` | `clockSkewSeconds`、`assertionLifetimeSeconds`、`sessionExpiresIn`（§4.3、§7.1、§10.4） |

後台操作**必須**以 HyAgent 管理者帳號認證，**不得**使用 Identity Assertion 或 `sessionToken`。

上傳時若誤貼**私鑰**，後端**必須**直接拒絕並明示處置方式。Node 的 `createPublicKey()` 接受私鑰
並回傳其對應公鑰，不主動辨識的話這個貼錯會**完全靜默地成功**：`kid` 正確、驗章正常，沒有任何
跡象顯示客戶剛把私鑰交了出來（實作：`tenant-keys.ts` 的 `rejectPrivateKey()`）。

§2.5 的下列不變條件**必須**由後端強制執行，**不得**僅在 UI 層檢查：

| 條件 | 行為 |
| --- | --- |
| `active` 公鑰已達 2 把時再上傳 | 拒絕，回傳 `KEY_LIMIT_EXCEEDED`（409） |
| **停用**（`disabled`）最後一把 `active` 公鑰 | 拒絕，回傳 `LAST_ACTIVE_KEY`（409）；**應該**先上傳新公鑰再停用舊的 |
| **撤銷**（`revoked`）最後一把 `active` 公鑰 | **允許**（安全優先於可用性），但**必須**要求二次確認；此後該 Tenant 在上傳新公鑰前無法建立 Session |
| 上傳的公鑰其 `kid` 已存在於同一 Tenant | 視為冪等，回傳既有 `kid` 與狀態，不新增一筆，**也不改變其現有狀態**（否則重新上傳一把已撤銷的公鑰就成了繞過撤銷的後門） |
| 已撤銷（`revoked`）的公鑰要求改回可用 | 拒絕：撤銷不可逆，請重新產生並上傳一把新的 |

`disabled` 與 `revoked` 的公鑰不計入 2 把上限，但**應該**保留紀錄供稽核（`kid`、狀態、變更時間、操作者）。

### 7.4 Session 管理（管理端）

> **▶ 實作**：`admin.controller.ts` 的 `revokeSessionsBySub()` → `server/src/lib/auth-session.store.ts`；
> 測試 `server/tests/auth-session-store.test.ts`

同 §7.3，Session 作廢**僅**經 **HyAgent 後台 UI** 操作，**不對外開放 API**。

作廢該 Tenant 下指定 `sub` 的所有有效 Session。用於帳號停權、離職等**由伺服器端發起**的身分變更——這類變更 Host Page 無從察覺，無法靠 `logout()` / `refreshIdentity()`（§6.3）處理。

下列為後台介面背後的內部語意，**非對外契約**：

```http
POST /api/admin/tenants/{tenant}/sessions/revoke
Content-Type: application/json

{ "sub": "507" }
```

成功結果：`{ "data": { "revoked": 3 } }`

| 規範 | 內容 |
| --- | --- |
| 認證 | **必須**以 HyAgent 管理者帳號認證，**不得**使用 Identity Assertion 或 `sessionToken` |
| `sub` 參數 | **必要**（由 schema 驗證，缺漏即 400）；**不得**將「省略 `sub`」解讀為作廢全 Tenant，避免誤操作造成全站登出。需作廢整個 Tenant 時**應該**改以 §2.6 的金鑰撤銷處理 |
| 生效時間 | **必須**於 **60 秒**內生效；實作要求同 §2.6 第 4、5 條（快取 TTL 與長連線） |
| 冪等 | 該 `sub` 無任何有效 Session 時仍回傳 `200` 與 `revoked: 0`，**不得**回傳 `404`——否則本操作可被用來探測帳號是否存在或是否在線 |
| 稽核 | **必須**記錄操作者、時間、`tenant` 與作廢筆數。日誌**不得**留下 `sub` 等 claims 值（§10.3） |

**使用順序（重要）**：本操作只作廢**既有** Session，**不會**阻止重新登入。若使用者在客戶網站仍為登入狀態，SDK 會在下次請求收到 `401` 後重走 token provider（§6.5），取得新 Assertion 並立即建立新 Session，等同沒有作廢。因此**必須**依下列順序操作：

```text
1. 先在自家系統停權或登出該使用者 → Identity Endpoint 不再為其簽發 Assertion
2. 再由 HyAgent 後台作廢該 sub 的既有 Session
```

順序顛倒則第 2 步無效。

**空窗期（因僅後台 UI 而存在，Tenant 必須知悉）**

由於第 2 步需人工執行，停權生效到 Session 失效之間存在空窗。但空窗**有明確上界**：§7.1 的續期機制為「到期前 60 秒由 SDK 重走 token provider」，使用者在客戶系統被停權後 Identity Endpoint 即不再簽發 Assertion，續期必然失敗，既有 Session 至遲於自然到期時失效。

```text
空窗期 ≤ expiresIn（預設 3600 秒，Tenant 可設 300 ～ 28800 秒）
  ├ 後台已作廢        → 空窗期 ≈ 0（60 秒內生效）
  └ 尚無人操作後台    → 空窗期至多到該 Session 自然到期
```

因此 Tenant **應該**依自身的停權即時性要求設定 `expiresIn`（§7.1），並把「至 HyAgent 後台作廢 Session」納入離職 / 停權的標準作業流程。

> 未來若有自動化需求（例如 HR 系統於停權當下即時連動），得於新的 minor 版本增設對外 API；屆時**必須**配發獨立管理憑證，並依 §11.1 的相容性規範發佈。

### 7.5 錯誤回應格式

> **▶ 實作**：`server/src/lib/assertion/errors.ts` 的 `toErrorResponse()`

**換發端點（§7.1）的錯誤**一律使用下列扁平格式：

```json
{
  "error": "TOKEN_EXPIRED",
  "message": "Identity Assertion 已過期",
  "requestId": "req_01J8F3K7Q2ABCDEF"
}
```

> 本系統其餘 API 的錯誤為 `{ "error": { "code", "message" } }`（巢狀）。換發端點刻意不同：
> §9 的細分代碼是整合期唯一的診斷依據，客戶端程式要以 `error` 直接分流。
> `requestId` 取自請求的 `x-request-id`。

| 欄位 | 受眾 | 用途 |
| --- | --- | --- |
| `error` | 整合者的**程式** | 唯一可用於邏輯判斷的欄位 |
| `message` | 整合者的**人** | 該代碼的固定說明文字，供除錯與日誌。**不得**由程式解析，措辭得隨版本調整 |
| `requestId` | 整合者與 HyAgent 支援 | 回報問題時的對照依據 |

回應**不得**洩漏 Assertion 內容、金鑰資訊、claims 值或內部堆疊（§9）。

**Host Page 的義務（規範性）**

這三個欄位**都不是寫給終端使用者看的**。客戶**不得**將 `error` / `message` 直接呈現於使用者介面；**必須**改為顯示通用訊息（例如「智能助理暫時無法使用」），並把 `error` 與 `requestId` 寫入自家日誌或錯誤回報系統。

> **理由**：這些代碼描述的是**客戶後端與 HyAgent 之間的整合問題**，終端使用者既看不懂也無從處置——`INVALID_SIGNATURE` 對使用者不具任何可行動的意義，只會轉成無效客訴。直接顯示還會讓內部細節流進截圖、工單與客服紀錄。細分代碼的價值在整合者的日誌裡，不在使用者的畫面上。

---

## 8. Assertion 驗證規則（規範性）

> **▶ 實作**：`server/src/lib/assertion/verifier.ts`，安全性回歸測試 `server/tests/assertion-verifier.test.ts`
>
> 該檔的進入點與本章的對應：
>
> | 方法 | 涵蓋範圍 | 用途 |
> | --- | --- | --- |
> | `decode()` | 無 | 只解析，**結果不可用於任何安全判斷**（§8.3） |
> | `verify()` | §8.0–§8.4（步驟 0–18） | 同步、無副作用，方便單元測試 |
> | `verifyAndConsume()` | 再加上 §8.5（步驟 19–20） | 一般呼叫端用這個 |
> | `verifyAndConsumeWithKey()` | 同上，另回傳驗章所用的 `kid` | **正式流程用這個**——Session 紀錄必須帶 `kid`（§2.6），而它在 header 不在 claims |
> | `peekIssuer()` | 步驟 0 + 取出未驗章的 `iss` | 只用於決定拿哪個 Tenant 的公鑰驗章 |
> | `isOriginAllowed()` | §8.6（步驟 21） | 由換發流程在驗章後呼叫 |

HyAgent 後端收到 Assertion 時**必須**依序執行下列檢查，任一步失敗即中止並回傳對應錯誤碼。

### 8.0 大小上限

0. Assertion 序列化後的位元組數 ≤ 4096（§4.2.4）→ 否則 `ASSERTION_TOO_LARGE`。

此檢查**必須**在任何解碼與驗章之前執行——順序本身即為規範性要求。它是流程中唯一不需信任輸入內容即可完成的檢查，作用是讓未持金鑰的攻擊者無法用超大輸入逼出解碼與非對稱驗章的成本；完整理由見 §4.2.4。

### 8.1 結構檢查

1. 為字串，且以 `.` 分為恰好 3 段，每段非空 → 否則 `MALFORMED_TOKEN`。
2. 每段僅含 Base64URL 字元 `[A-Za-z0-9_-]` → 否則 `MALFORMED_TOKEN`。
3. header 與 payload 解碼後為 JSON object（非陣列、非 null）→ 否則 `MALFORMED_TOKEN`。

### 8.2 演算法與金鑰

4. `typ === "JWT"` 且 `alg ∈ {RS256, ES256}` → 否則 `INVALID_ALGORITHM`。
5. header 含 `jku` / `jwk` / `x5u` / `x5c` → `INVALID_ALGORITHM`。
6. 以 `iss`（Tenant）+ `kid` 查出註冊公鑰 → 查無 `UNKNOWN_KID`；已撤銷 `KEY_REVOKED`。
7. **以註冊時宣告的演算法驗章**，`header.alg` 與之不符即 `INVALID_ALGORITHM`。

> **algorithm confusion 防護**：驗證器**不得**依 `header.alg` 動態選擇演算法。否則攻擊者可將 `alg` 改為 `HS256`，用公開的 RSA 公鑰當 HMAC 金鑰偽造簽章。實作 `server/src/lib/assertion/verifier.ts` 即以「該 `kid` 註冊時宣告的演算法」驗章，`header.alg` 與之不符即直接拒絕；對應測試為 `assertion-verifier.test.ts` 的「algorithm confusion」一案。

### 8.3 簽章

8. 驗證 `BASE64URL(header) + "." + BASE64URL(payload)` 的簽章 → 失敗 `INVALID_SIGNATURE`。
9. `ES256` 簽章長度**必須**為 64 bytes（R‖S）→ 否則 `INVALID_SIGNATURE`。

**簽章驗證通過前，payload 內容一律不可信任**，包含不得寫入日誌或用於查詢。

### 8.4 Claims

10. `iss` 為非空字串且等於請求的 Tenant → 否則 `INVALID_ISSUER`。
11. `aud` 等於 `hyagent` → 否則 `INVALID_AUDIENCE`。
12. `sub` 為長度 1–255 的非空字串 → 否則 `INVALID_CLAIMS`。
13. `iat`、`exp` 為非負安全整數 → 否則 `INVALID_CLAIMS`。
14. `iat <= now + skew` → 否則 `TOKEN_NOT_ACTIVE`。
15. `exp > now - skew`（邊界值即視為過期）→ 否則 `TOKEN_EXPIRED`。

> 步驟 14、15 的 `skew` 為該 Tenant 的時鐘偏移容忍（§10.4），預設 15 秒。步驟 16 的 `exp - iat` 是 token 自身的一致性檢查，**不套用** `skew`。
16. `exp > iat` 且 `exp - iat <= 300` → 否則 `INVALID_CLAIMS`。
17. `jti` 為長度 8–128 的非空字串 → 否則 `INVALID_CLAIMS`。
18. 選填 claims 若存在，型別**必須**正確（`roles` 為字串陣列、`picture` 為 `https://` URL 等）→ 否則 `INVALID_CLAIMS`。

### 8.5 重放防護

19. 以 `(tenant, kid, jti)` 為鍵查詢一次性紀錄；已存在 → `TOKEN_REPLAYED`。
20. 寫入該鍵，保存至 `exp`（因 `exp - iat <= 300`，紀錄最多保存 5 分鐘）。

`jti` 紀錄**必須**使用具原子性的儲存，避免並行請求同時通過。

> **實作**：`server/src/lib/assertion/claim-replay-store.ts`，寫進 `security_claims` 並帶
> `expires_at`，原子性來自 DB 的 `INSERT … ON CONFLICT`（file 模式為 `wx` 開檔），
> 清理與 Session 共用同一支排程。未採 Redis：`SET NX EX` 的 TTL 語意是它的主要優勢，
> 而在已經需要一支清理排程的前提下該優勢消失，少一個正式環境相依則是實在的。

> 簽章驗證本身**無法**阻止重放：攻擊者取得有效 Assertion 後可在有效期內重複使用。因此一次性 `jti` 紀錄為**必要**機制。

### 8.6 來源檢查

21. 請求的 `Origin` 在該 Tenant 的 Allowed Origins 內 → 否則 `ORIGIN_NOT_ALLOWED`。

### 8.7 實作對照

| 檔案 | 涵蓋步驟 | 說明 |
| --- | --- | --- |
| `server/src/lib/assertion/verifier.ts` | **0–20** | 驗證規則本體。步驟 0 由 `peekIssuer()` 在任何解碼前執行 |
| `server/src/modules/auth/assertion-exchange.ts` | 21 + 接線 | 依 `iss` 自 **primary** 取租戶（§2.6 第 1、2 條）、逐租戶 skew、Origin 白名單、建立帶 `kid` 的 Session |
| `server/src/lib/assertion/claim-replay-store.ts` | 19–20 | 一次性 `jti` 紀錄。鍵為 `(tenant, kid, jti)`，保存至 `exp` |
| `server/src/modules/tenant/tenant-keys.ts` | 6–7 的資料面 | 公鑰狀態機與 2 把上限（§2.5、§7.3） |

> 步驟 21 排在驗章之後是照規格的步驟編號。副作用是來源不合法的請求也會消耗掉該 `jti`——
> 那反而是好的：一張被側錄的 Assertion 拿去他站兌換，會在當場報廢而不是留著再用一次。

---

## 9. 錯誤碼（規範性）

> **▶ 實作**：`server/src/lib/assertion/errors.ts`（錯誤碼、HTTP 狀態對照、§7.5 回應格式）
>
> 診斷順序：① 回應的 `error` 代碼對照下表；② `kid` 是否與後台一致（`node hyagent-keygen.mjs --kid <public.pem>`，§3.4）；
> ③ 仍無法定位時，附上 `requestId` 與時間回報 HyAgent——伺服器端日誌留有代碼與租戶，但**不留** Assertion 原文與 claims 值（§10.3）。

| 錯誤碼 | HTTP | 意義 | 客戶端處置 |
| --- | --- | --- | --- |
| `MALFORMED_TOKEN` | 401 | JWT 結構或編碼錯誤 | 檢查簽發程式 |
| `INVALID_ALGORITHM` | 401 | `alg` / `typ` 不符或含禁用 header 欄位 | 檢查簽發程式 |
| `UNKNOWN_KID` | 401 | 查無此 `kid` | 確認公鑰已上傳且 `kid` 正確 |
| `KEY_REVOKED` | 401 | 公鑰已撤銷 | 改用有效金鑰 |
| `INVALID_SIGNATURE` | 401 | 驗章失敗 | 確認私鑰與已上傳公鑰配對 |
| `INVALID_ISSUER` | 401 | `iss` 與 Tenant 不符 | 檢查 `iss` 設定 |
| `INVALID_AUDIENCE` | 401 | `aud` 不符 | 應為 `hyagent` |
| `INVALID_CLAIMS` | 401 | claims 型別、必要性或有效期不符契約 | 對照 §4.2 |
| `TOKEN_NOT_ACTIVE` | 401 | `iat` 在未來 | **校時（NTP）** |
| `TOKEN_EXPIRED` | 401 | 已過期 | 重新簽發；若頻繁發生請校時 |
| `TOKEN_REPLAYED` | 401 | `jti` 重複使用 | 每次簽發新 Assertion，勿快取 |
| `ASSERTION_TOO_LARGE` | 413 | 超過大小上限 | 減少自訂 claims |
| `TENANT_NOT_FOUND` | 404 | Tenant 不存在 | 檢查 Tenant ID |
| `TENANT_DISABLED` | 403 | Tenant 已停用 | 聯絡 HyAgent |
| `ORIGIN_NOT_ALLOWED` | 403 | 來源網域不在白名單 | 於後台登記網域 |
| `RATE_LIMITED` | 429 | 超過速率限制 | 依 `Retry-After` 退避 |

Widget 端另有兩個本地代碼（不對應 HTTP，出現在 `identity:response` 的 `error.code`，見 §6.6）：
`NO_TOKEN_PROVIDER`（未設 `data-token-url`）、`TOKEN_PROVIDER_FAILED`（含逾時與重試用盡）。
兩者都不會擋住面板，使用者改為自行登入。

管理端操作（§7.3、§7.4）另有：`KEY_LIMIT_EXCEEDED`（409，已達 2 把上限）、`LAST_ACTIVE_KEY`（409，不得停用最後一把有效公鑰）、`INVALID_REQUEST`（400，參數缺漏或格式錯誤）。

**安全考量（定稿：正式環境保留細分代碼）**

「驗證失敗一律收斂為單一錯誤碼」的慣例源自登入端點——那裡**必須**讓攻擊者無從分辨「帳號不存在」與「密碼錯誤」，否則可枚舉帳號。**本協定不存在這個風險**：HyAgent 不驗證 `sub` 是否真實存在，而是信任 Tenant 簽發的任何 `sub`，因此沒有「查無此人」這個回答可被探測。未持私鑰的攻擊者能觸發的只有 `MALFORMED_TOKEN`、`INVALID_SIGNATURE` 與 `UNKNOWN_KID`；而 `kid` 是公鑰的 Thumbprint（§2.4）、`tenant` 就寫在 Host Page 的 `init()` 設定裡，兩者本就非機密。

反之，這是跨「客戶後端 × 瀏覽器 × HyAgent」的多方密碼學協定，「不能用」可能出自十餘種原因。收斂成單一 `INVALID_ASSERTION` 等於拿掉整合期唯一的診斷依據，而整合期正是錯誤最密集的時候。殘餘的探測價值由速率限制（`RATE_LIMITED`）與 Origin 白名單（§8.6）承接。

保留細分代碼的前提是**嚴守洩漏邊界**：

| 項目 | 規範 |
| --- | --- |
| HTTP 狀態 | §8 步驟 1–20 的驗證失敗一律 `401`；大小（413）、Tenant 狀態（404 / 403）、Origin（403）與速率（429）依上表 |
| 得回傳 | `error` 代碼、該代碼的固定說明文字、`requestId` |
| **不得**回傳 | Assertion 原文或其任一段、金鑰內容、`sub` 與其他 claims 值、內部堆疊、檔案路徑、主機名稱 |
| 呈現 | 客戶**不得**將代碼直接顯示給終端使用者，見 §7.5 |

---

## 10. 安全要求（規範性）

### 10.1 傳輸

- 所有通訊**必須**使用 HTTPS（TLS 1.2+）。
- Identity Endpoint 與換發端點（§7.1）**必須**回應 `Cache-Control: no-store`。
- Assertion **不得**放入 URL query string（會殘留於瀏覽器歷史、Referer、伺服器日誌）。

### 10.2 金鑰

- 私鑰**不得**進入前端、版控、日誌或錯誤回報。
- 上線前**應該**以 secret 掃描工具（如 gitleaks）檢查 repo。
- HyAgent 端**不得**保存任何客戶私鑰。

### 10.3 日誌與 PII

- **不得**完整記錄 Assertion。需要稽核時只記錄 `tenant`、`kid`、`jti`、`sub` 與驗證結果。
- Assertion 內的個資**應該**遵循最小必要原則：Widget 不需要的欄位就不要放。

### 10.4 時間

- 雙方**必須**以 NTP 校時。時鐘偏移是 `TOKEN_EXPIRED` / `TOKEN_NOT_ACTIVE` 最常見的成因。
- 本規格**容忍** clock skew，預設 **15 秒**，套用於 §8.4 步驟 14（`iat`）與 15（`exp`）兩個方向。

**設定方式**

| 項目 | 規範 |
| --- | --- |
| 設定位置 | **僅** HyAgent 後台，逐 Tenant 設定（同 §7.3 的管理原則）。客戶端**不得**自行決定，亦**不得**由請求參數傳入 |
| 預設值 | **15 秒** |
| 範圍 | **0 ～ 30 秒** |
| 比例上限 | **不得**超過該 Tenant Assertion 有效期的 **¼**。以建議的 60 秒有效期計，上限即為 15 秒 |

**為何從「不放寬」改為容忍 15 秒**

| 考量 | 說明 |
| --- | --- |
| 0 秒在企業環境不可行 | 未加入網域的 Windows Server，w32time 預設輪詢間隔為 **7 天**，期間靠本機晶振自走；VM 暫停、遷移或快照還原還會造成時鐘跳躍。要求所有 Tenant 都維持亞秒級校時並不務實，而失敗模式是**間歇性**的 `TOKEN_NOT_ACTIVE` / `TOKEN_EXPIRED`，最難診斷 |
| 風險由 `jti` 承接 | 拒絕 skew 的標準理由是「放寬等於延長重放窗口」。但 §8.5 的一次性 `jti` 紀錄使被側錄的 Assertion **根本無法再用**，與是否仍在有效期內無關。skew 放寬的不是重放窗口，只是「合法簽發、尚未兌換」的 Assertion 的接受窗 |
| 窗口仍受控 | 以建議的 60 秒有效期加 ±15 秒計，實際接受窗為 90 秒，為名目值的 1.5 倍。比例上限（¼）確保有效期不致因 skew 而形同虛設 |
| 維持對稱 | `iat` 方向（客戶時鐘快）與 `exp` 方向（客戶時鐘慢）源自同一個偏移，分開設定只增加設定面複雜度而不增加安全性，故以單一參數對稱套用 |

**可觀測性（規範性）**

容忍 skew 會讓時鐘持續漂移的 Tenant **在超過容忍前毫無徵兆**，故 HyAgent **必須**：

- 於每次驗證記錄觀測到的偏移量 `now - iat`（僅記錄數值，不記錄 claims 內容，見 §10.3）。
- 偏移量絕對值超過該 Tenant 容忍值的**一半**時，**必須**產生告警並於後台顯示。
- 後台**應該**呈現各 Tenant 近期的偏移分佈，供客戶自行校時。

否則容忍 skew 只是把斷崖往後挪，而非消除它。

### 10.5 身分一致性

- `sub` **必須**穩定且不可重複配發。使用者離職後其 `sub` **不得**再配給新人，否則會繼承對話紀錄。
- 使用者於宿主網站登出或切換帳號時，Host Page **必須**呼叫 `logout()` 或 `refreshIdentity()`，否則 Widget 會維持前一位使用者的 Session 直到過期。
- 承上，HyAgent Session 有效期（§7.1 `expiresIn`）**應該**設為**不長於客戶自家 session 的有效期**，否則會出現「客戶網站已登出、Widget 仍為登入狀態」的窗口。共用終端（如公用電腦）**應該**再往下調。
- 帳號停權、離職等**由伺服器端發起**的身分變更，Host Page 無從察覺，**必須**依 §7.4 的順序處理（先於自家系統停權，再至 HyAgent 後台作廢該 `sub` 的 Session），不可僅依賴前端呼叫 `refreshIdentity()`。後台作廢前存在至多一個 `expiresIn` 的空窗期，見 §7.4。

### 10.6 威脅對照

| 威脅 | 防護機制 |
| --- | --- |
| 前端偽造身分 | 身分僅來自後端私鑰簽章，前端無法產生有效簽章 |
| Assertion 側錄後重放 | ≤ 60 秒有效期 + `jti` 一次性紀錄 + Origin 白名單 |
| Algorithm confusion | 依註冊演算法驗章，不信任 `header.alg`；禁用對稱演算法 |
| 外部金鑰注入 | 禁用 `jku` / `jwk` / `x5u` / `x5c` |
| 私鑰外洩 | 撤銷 `kid`（60 秒內生效）+ 作廢既有 Session |
| Widget 被嵌到他站 | Allowed Origins 檢查 + `postMessage` origin 驗證 |
| 跨 Tenant 冒用 | `iss` 必須等於 Tenant，且 `kid` 綁定該 Tenant |
| Assertion 洩漏於日誌 | 禁止完整記錄 + 禁止置於 URL |

---

## 11. 相容性與變更管理

### 11.1 變更策略

- 本規格**不設**協定版本號。`aud` 固定為 `hyagent`，其用途僅為擋下跨服務重放（§4.2），**不得**兼作版本標記。
- SDK 載入路徑（`/sdk/widget.js`）**不含版本號**，為單一可變路徑；它切開的是客戶頁面載入的 JS 程式碼，與協定無關，規則見下方「SDK 檔案版本」。
- 破壞性變更**不以**發佈新協定版本處理，改以逐 Tenant 設定收斂。
- 客戶端**必須**忽略無法辨識的 claims 與事件；HyAgent **不得**因 Assertion 含有未知 claims 而拒絕驗證。

> **為何不設協定版本**
>
> 協定版本的價值在於「一次對全體宣告新合約」，但簽發端位於客戶機房，HyAgent 無從要求全體 Tenant 在同一時點完成部署。客戶自身的部署甚至不是原子的——滾動更新期間，同一 Tenant 會同時送出新舊格式的 Assertion，因此相容性的粒度**必須**是逐請求，而非逐 Tenant。既然全體同步切換本就辦不到，協定版本能提供的只剩維護兩套驗證路徑的成本，以及一個無法執行的停止支援日期。
>
> 且協定版本只切得開協定邊界。`jti` 紀錄（§8.5）、Session（§7.1）、公鑰註冊（§7.3）與逐 Tenant 設定皆為共用狀態，不會因為協定有兩個版本而變成兩份。
>
> 反之，本協定可預見的破壞性變更幾乎都是**收緊既有驗證規則**（禁用某演算法、提高金鑰強度下限、將選填 claim 改為必要）。這類變更以逐 Tenant 設定表達是自然的，收斂進度也看得見、可個別推動——這正是協定版本表達得最差的部分。

**變更分類**

| 變更類型 | 處理方式 |
| --- | --- |
| 新增選填 claims、新增選填 `init` 參數、新增事件 | 直接發佈，不需通知 |
| 收緊既有驗證規則 | 逐 Tenant 設定，依下方「收斂程序」推動 |
| SDK JS API 的移除或語意變更 | **應避免**。確有必要時依「收斂程序」預告後於生效日一次切換（可變路徑無舊版可退） |
| 既有 claim 的語意變更 | **不得**為之。**必須**改以新增另一個 claim 表達 |
| Assertion 格式整體更換（非 JWS） | 本規格未涵蓋。**必須**另開端點，**不得**於既有端點上切換 |

**以 Tenant 設定承載規則收緊（規範性）**

凡屬「收緊既有驗證規則」的變更，**必須**以 HyAgent 後台的逐 Tenant 設定表達，**不得**以全域切換一次套用至所有 Tenant。現行的逐 Tenant 設定與其硬性邊界：

| 設定 | 章節 | 可設定範圍 | 硬性邊界 |
| --- | --- | --- | --- |
| 公鑰演算法（隨公鑰註冊宣告） | §2.1、§7.3 | `RS256` / `ES256` | **不得**放寬至 `none`、HMAC 或 RSA modulus < 2048 |
| Clock skew 容忍 | §10.4 | 0 ～ 30 秒 | **不得**超過 30 秒，且 ≤ 該 Tenant Assertion 有效期的 ¼ |
| Session `expiresIn` | §7.1 | 300 ～ 28800 秒 | **不得**超過 28800 秒 |

新增逐 Tenant 設定時，**必須**同時定義其硬性邊界，且該邊界本身**不得**逐 Tenant 調整。

> **理由**：無邊界的逐 Tenant 設定會使「彈性」退化為「永遠有 Tenant 停在最不安全的值」。§10.4 的「0 ～ 30 秒且 ≤ 有效期 ¼」即為正確形態：給彈性，但彈性有天花板。

**收斂程序（規範性）**

| 步驟 | 規範 |
| --- | --- |
| 1. 調整預設值 | 新 Tenant 自即日起套用收緊後的預設值 |
| 2. 書面通知 | **必須**通知受影響的既有 Tenant，載明新值、影響範圍與**確定的生效日期**（日期，而非「N 個月後」） |
| 3. 通知期 | 通知日至生效日**不少於 12 個月**。**安全性驅動**的收緊**得**縮短至 **90 天**；已遭利用的重大漏洞**得**再縮短，並逐一通知 |
| 4. 提前生效 | 受影響 Tenant 皆已完成調整時，**得**提前套用 |

> **為何以「通知期」而非「並行期」計算**：並行期自新規則發佈起算，但 Tenant 未必知悉發佈，可能在所剩無幾時才發現。通知期自 HyAgent 發出通知起算，起算點雙方一致且可舉證；通知內容載明確定日期，亦可避免「至少 N 個月」被一方讀成下限、另一方讀成到期日。

**可觀測性（規範性）**

HyAgent 後台**必須**呈現各 Tenant 的現行設定值，並標示偏離預設值、尚未完成收斂者。

> 否則生效日到期時無從判斷能否套用，期限只會一再延後——同 §10.4，沒有儀表板的期限只是把斷崖往後挪。

**SDK 檔案版本**

- SDK 以**單一可變路徑** `/sdk/widget.js` 發佈，HyAgent **得**就地更新；客戶頁面不需變更即可取得修補。本版不提供不可變的精確版本路徑（§6.1）。
- 因此 SDK 的 JS API 變更**必須**向後相容：**得**新增選填 `init` 參數、新增事件與方法；**不得**移除既有 API 或改變其語意。
- 確有破壞性變更的必要時，**必須**依上方「收斂程序」的通知期預告，並於生效日一次切換——可變路徑沒有舊版可退，**不得**以「發新路徑、舊路徑不管」的方式規避通知。
- 可變路徑的 `Cache-Control` **不得**設定超過 **5 分鐘**的 `max-age`，否則修補無法及時生效，可變路徑的意義即失效。
- 新舊 SDK **不得**要求不同的 Assertion 格式；協定只有一套。


---

## 12. 整合檢核清單

> **▶ 實作**：`npm test`（server + admin + client + sdk）可自動驗證 12.2 的多數項目；
> 12.1 多為客戶端的部署與流程檢查，需人工確認。

### 12.1 客戶端

- [ ] 金鑰對以 `RS256`（≥2048）或 `ES256`（P-256）產生，且在自有可信環境產生
- [ ] 私鑰不在版控、前端、日誌中；檔案權限 `0600` 或改用 KMS
- [ ] 公鑰已上傳 HyAgent，`kid` 與本地計算結果一致（`node hyagent-keygen.mjs --kid <public.pem>`，§3.4）
- [ ] Allowed Origins 已登記所有嵌入網域（含測試環境）
- [ ] Identity Endpoint 以自家 Session 判定身分，未登入回 `401`
- [ ] Identity Endpoint 回應帶 `Cache-Control: no-store`
- [ ] Assertion `iss` 等於 Tenant ID、`aud` 等於 `hyagent`、有效期 60 秒
- [ ] 每次呼叫都產生新的 `jti`，前端未快取 Assertion
- [ ] `sub` 使用穩定且不重複配發的內部 ID（非 email）
- [ ] `ES256` 簽章為 R‖S 格式（用 `@hyagent/sdk/server` 的 `issueAssertion()` 即已處理；自行實作時 Node.js 須指定 `dsaEncoding: "ieee-p1363"`）
- [ ] 伺服器已 NTP 校時（HyAgent 預設僅容忍 15 秒偏移，§10.4）
- [ ] 使用者登出 / 切換帳號時有呼叫 `logout()` / `refreshIdentity()`
- [ ] CSP 已放行 HyAgent 網域
- [ ] 未將錯誤代碼直接顯示給終端使用者，僅記錄 `error` 與 `requestId`（§7.5）
- [ ] 使用 `data-token-url`（或 headless SDK 的函式形式 `assertion`），未把簽好的憑證寫死在頁面上（§6.5）

### 12.2 HyAgent 端

- [ ] 依註冊演算法驗章，不信任 `header.alg`
- [ ] 禁用 `none`、HMAC 與 `jku` / `jwk` / `x5u` / `x5c`
- [ ] `kid` 查表綁定 Tenant，支援同時 2 把有效公鑰與撤銷狀態
- [ ] 強制執行公鑰上限 2 把、至少保留 1 把 `active` 的不變條件（§7.3）
- [ ] §8 全部 22 項檢查（步驟 0–21）皆實作且順序正確
- [ ] 步驟 0 的大小上限置於解碼與驗章之前（§4.2.4）
- [ ] `jti` 以原子操作寫入，TTL 至 `exp`
- [ ] Origin 白名單檢查
- [ ] 驗證失敗不洩漏內部細節，日誌不含完整 Assertion
- [ ] 速率限制與 `Retry-After`
- [ ] 時鐘偏移容忍逐 Tenant 設定（0 ～ 30 秒，且 ≤ 有效期 ¼），並記錄與告警觀測偏移（§10.4）
- [ ] 金鑰撤銷於 60 秒內生效；公鑰查詢無 TTL > 30 秒的快取，撤銷狀態讀取走 primary
- [ ] Session 紀錄含建立時的 `kid`，撤銷金鑰時連帶作廢該 `kid` 的所有 Session
- [ ] Session 驗證無 TTL > 30 秒的快取；長連線定期重檢授權或於撤銷時主動中斷
- [ ] 支援以 `sub` 作廢特定使用者的 Session（§7.4），同樣於 60 秒內生效
- [ ] Tenant 可設定 `expiresIn`（300 ～ 28800 秒），預設 3600
- [ ] 驗證不因 Assertion 含有未知 claims 而失敗（§11.1）
- [ ] 後台可檢視各 Tenant 現行設定值，並標示偏離預設值、尚未完成收斂者（§11.1）

---

## 附錄 A：測試向量與驗證工具

### A.1 本規格的實作與測試

於 repo 根目錄：

```powershell
npm run keygen -- ES256 ./keys      # 產生金鑰對（§3.1）
npm test                            # 全部測試（server + admin + client + sdk）
npm test -w server                  # 只跑 HyAgent 端：§8 驗證規則、§7 換發與管理端
npm test -w sdk                     # 只跑客戶端：keygen CLI、簽發、Session 續期
```

完整信任鏈的可執行 demo 為 `presale/widge-tenant/`（模擬客戶網站 + Identity Endpoint + 嵌入
Widget），需先啟動 `npm run dev:server` 與 `npm run dev:client`，詳見該目錄的 README。

各檔案的用途與適用角色見 §1.6。

### A.2 驗證器必要測試案例

任何 HyAgent 端驗證器**應該**至少涵蓋下列案例。「實作」欄標示 `server/tests/assertion-verifier.test.ts` 是否已涵蓋。

| 案例 | 預期錯誤碼 | 實作 |
| --- | --- | --- |
| 有效 Assertion（RS256 / ES256 各一） | 通過 | ✅ |
| `exp` 等於當下秒數 | `TOKEN_EXPIRED` | ✅ |
| `iat` 在未來 | `TOKEN_NOT_ACTIVE` | ✅ |
| `exp - iat = 301` | `INVALID_CLAIMS` | ✅ |
| payload 遭竄改（改 `sub`） | `INVALID_SIGNATURE` | ✅ |
| `alg` 改為 `HS256`，以公鑰當 HMAC 金鑰簽章 | `INVALID_ALGORITHM` | ✅ |
| `alg` 改為 `none`、簽章留空 | `MALFORMED_TOKEN` | ✅ |
| header 加入 `jku` / `jwk` / `x5u` / `x5c` | `INVALID_ALGORITHM` | ✅ |
| `kid` 不存在或缺漏 | `UNKNOWN_KID` | ✅ |
| 使用 Tenant A 的 `kid` 搭配 Tenant B 的 `iss` | `UNKNOWN_KID` | ✅ |
| `header.alg` 與該 `kid` 註冊的演算法不符 | `INVALID_ALGORITHM` | ✅ |
| 公鑰已撤銷或停用 | `KEY_REVOKED` | ✅ |
| 輪替期間新舊公鑰皆可用 | 通過 | ✅ |
| 同一 `jti` 連送兩次 | 第二次 `TOKEN_REPLAYED` | ✅ |
| ES256 簽章以 DER 編碼 | `INVALID_SIGNATURE` | ✅ |
| 選填 claims 型別錯誤（`roles` 非陣列、`picture` 非 https） | `INVALID_CLAIMS` | ✅ |
| Assertion 超過 4096 bytes | `ASSERTION_TOO_LARGE` | ✅ |
| `exp` 已過但在 15 秒容忍內 | 通過 | ✅ |
| `exp` 已過且超出容忍 | `TOKEN_EXPIRED` | ✅ |
| `iat` 在未來但在 15 秒容忍內 | 通過 | ✅ |
| `iat` 在未來且超出容忍 | `TOKEN_NOT_ACTIVE` | ✅ |
| `clockSkewSeconds` 設定超出 0 ～ 30 | 建構時 `RangeError` | ✅ |
| Origin 不在白名單 | `ORIGIN_NOT_ALLOWED` | ✅ |

### A.3 三份實作的互通實測

金鑰由客戶端 CLI 產生、由客戶端 SDK 簽發、由 HyAgent 後端驗證——三段程式互不共用
（CLI 零相依、SDK 在 `sdk/`、驗證器在 `server/`）。因此「互通」本身要實測，不能靠讀碼推論。

以 `sdk/bin/keygen.mjs` → `sdk/src/assertion.ts` 的 `issueAssertion()` →
`server/src/lib/assertion/verifier.ts` 的 `verifyAndConsume()` 串起一輪（Node.js v22.21.1）：

```text
ES256  kid=XQAj9j7a9xsU…  397 bytes  驗證通過 sub=507 name=羅玉瑩
ES256  同一張再送一次     → TOKEN_REPLAYED
RS256  kid=AD3ADMoYUCx7…  653 bytes  驗證通過 sub=507 name=羅玉瑩
RS256  同一張再送一次     → TOKEN_REPLAYED
```

`kid` 的三份實作以 RFC 7638 §3.1 官方測試向量交叉比對，結果一致
（`sdk/src/keygen-cli.test.ts`、`server/tests/assertion-keygen.test.ts`）：

```text
kid = NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs
```

其餘案例（A.2 全表、§7 的 HTTP 契約、§6.6 的 postMessage）由各自的測試檔涵蓋，
案例數與對應章節見 §1.6「測試在哪」，執行方式見 A.1。
