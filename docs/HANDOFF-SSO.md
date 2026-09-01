# 交接：SSO handoff（宿主系統帶身分進來）

> 對象：接手把 SSO 從 demo 級別做到可上線的開發者。
> 前置閱讀：[`INTEGRATION.md`](../INTEGRATION.md) 的「SSO handoff」段。
> 姊妹文件：[`HANDOFF-OA-HTTP.md`](HANDOFF-OA-HTTP.md)（送單那一半）。

## 0. 一句話說明

整合方（租戶）在**自己的後端**用該租戶的 `ssoSecret` 簽一張短效 JWT（`userToken`），
前端把它塞進 widget；我方驗章後換發**本系統的** access/refresh token，
終端使用者因此不必再輸入我方帳密。

`ssoSecret` 是**對稱密鑰**（HMAC），雙方各持一份，**絕不可出現在瀏覽器**。

## 1. 現況流程

```
① 使用者已登入「整合方的網站」
        ↓
② 整合方後端：signUserToken({ sub, name, role, secret: ssoSecret, expiresIn: '5m' })
        ↓                                    sdk/src/server.ts
③ 前端載入 widget：<script src=".../widget.js" data-key="pk_..." data-user-token="<jwt>">
        ↓                                    client/public/widget.js
④ widget 開 iframe：/?embed=1&key=pk_...&userToken=<jwt>
        ↓                                    client/src/embedConfig.ts
⑤ 前端呼叫 POST /api/auth/sso/exchange
        headers: x-api-key: pk_...           ← 用來解析「是哪個租戶」
        body:    { userToken }
        ↓
⑥ resolveTenant 中介層 → req.tenant         server/src/middlewares/resolve-tenant.ts
        ↓
⑦ authService.ssoExchange(tenant, userToken) server/src/modules/auth/auth.service.ts
        ├─ tenant.ssoSecret 未設 → 403「此租戶未啟用 SSO」
        ├─ jwt.verify(userToken, tenant.ssoSecret) 失敗 → 401
        ├─ claims.sub 為空 → 401「SSO token 缺少 sub」
        └─ 通過 → 簽發 { sub, role, via:'sso', tenantId, name }
        ↓
⑧ 回 { accessToken, refreshToken }；之後所有 API 帶 Authorization: Bearer <accessToken>
```

## 2. `userToken` 契約

| 項目 | 現況 |
| --- | --- |
| 演算法 | HS256（`jsonwebtoken` 預設；**我方未鎖定**，見 4.1） |
| 密鑰 | 該租戶的 `ssoSecret`，最短 16 字元（[`admin.schema.ts`](../server/src/modules/admin/admin.schema.ts) 的 `z.string().min(16)`） |
| `sub` | **必填**，終端使用者在宿主系統的唯一識別（工號 / 帳號）。空字串會被擋 |
| `name` | 選填，顯示名稱 |
| `role` | 選填，省略時我方預設 `employee` |
| 其他 claims | **會被忽略**（`SsoClaims` 只讀這三個） |
| 有效期 | 建議 `5m`（SDK 預設）。**我方不強制要求 `exp`**，見 4.2 |

租戶端簽章可直接用我方 SDK，不必自己接 `jsonwebtoken`：

```ts
import { signUserToken } from '@hyagent/sdk/server';

const userToken = signUserToken({
  sub: 'HYW018',
  name: '林佩蓉',
  secret: process.env.TENANT_SSO_SECRET,   // 留在後端
  expiresIn: '5m',
});
```

## 3. 建租戶並啟用 SSO

`ssoSecret` 只能透過管理 API 設定（需 `ADMIN_API_KEY`，預設為空＝管理 API 停用）：

```bash
# 建租戶時一併設定
curl -s -X POST localhost:3000/api/admin/tenants \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"示範租戶","allowedOrigins":["http://localhost:4000"],"ssoSecret":"test-secret1234567890"}'

# 既有租戶補設
curl -s -X PATCH localhost:3000/api/admin/tenants/<tenantId> \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"ssoSecret":"至少十六個字元的密鑰"}'
```

設了 `DATA_ENCRYPTION_KEY`（64 hex）後，`ssoSecret` 會以 AES-256-GCM 加密落地，
舊的明文資料在開機時自動補加密（[`tenant.store.ts`](../server/src/modules/tenant/tenant.store.ts)）。**正式環境務必設定**。

## 4. 五個待辦缺口

前四項在 [`auth.service.ts`](../server/src/modules/auth/auth.service.ts)，第五項是產品決策。
這些是「demo 能跑、上線不夠」的具體差距，也是這次交接的主要工作。

### 4.1 `jwt.verify` 沒帶任何 options

```ts
claims = jwt.verify(userToken, tenant.ssoSecret) as SsoClaims;
```

- **未鎖定 `algorithms`**：應明確傳 `{ algorithms: ['HS256'] }`，避免日後改用非對稱金鑰時被演算法混淆攻擊。
- **未驗 `issuer` / `audience`**：同一把 `ssoSecret` 若被租戶挪去簽別的用途的 token，那張 token 也能拿來換我方身分。建議約定 `iss`/`aud` 並驗證。
- **無 replay 防護**：同一張 `userToken` 在有效期內可重複兌換無限次。要防就得記 `jti`（短期黑名單即可，效期通常只有 5 分鐘）。

### 4.2 `exp` 由宿主決定，我方不強制

`jwt.verify` 只在 token **帶有** `exp` 時才檢查。宿主端若忘了設 `expiresIn`，
那張 `userToken` 就是**永久有效**——而它會出現在前端 HTML 屬性裡。

建議：驗章後自行檢查 `exp` 存在且距 `iat` 不超過某上限（例如 15 分鐘），否則拒收。

### 4.3 SSO 使用者不在名錄 → 只拿得到最小權限

[`user.directory.ts`](../server/src/modules/user/user.directory.ts) 是 mock 目錄，只有 `kevin` / `hyweb` 兩人。
SSO 進來的 `sub` 不在裡面，`getApplicant()` 會回退成：

```ts
{ id: sub, name: sub, department: UNKNOWN_DEPARTMENT }   // UNKNOWN_DEPARTMENT = '—'
```

而 `scopePolicy.groups` 是**以部門字串為 key** 解析權限的，所以 SSO 訪客一律落在「未知部門」這一桶，
拿到的是最小權限。這不是 bug（方向正確：預設最小權限），但代表：

> **SSO 使用者目前無法取得依部門授予的任何服務。**

要讓 SSO 使用者有正常身分，得二選一（或並用），**這是產品決策，請先確認**：

- (a) 擴充 `userToken` claims 帶 `department` / `title` / `email`，我方信任宿主的宣告；
- (b) 接真實 HR / OA 目錄，`sub` 進來後由我方反查。

不論走哪條，`user.directory.ts` 的介面（`getApplicant` / `isKnownUser` / `listDepartments`）都應維持不變，只換實作。

### 4.4 SSO 的 refresh 是無條件輪替

```ts
if (payload.via === 'sso') {
  return issueTokens({ sub, role, via: 'sso', tenantId, name });   // 不查任何來源
}
```

內部帳號 refresh 時會先 `isKnownUser(sub)` 確認帳號仍有效，**SSO 使用者則直接續發**。
後果：宿主端把使用者停權後，對方手上的 refresh token 仍可一路續命到 `JWT_REFRESH_EXPIRES_IN`（預設 7 天）到期。

要補的話有幾種做法（成本遞增）：縮短 SSO 的 refresh 效期／每次 refresh 回查宿主／建立撤銷清單。請評估後選一。

### 4.5 `login` 那一半仍是 mock

```ts
if (!isKnownUser(userId) || password !== env.AUTH_DEV_PASSWORD) { ... }
```

帳密登入走的是 mock 名錄 + **全體共用的 `AUTH_DEV_PASSWORD`**（dev 預設 `oa1234`）。
`NODE_ENV=production` 時若仍是預設值會 boot fail-fast，但「所有人同一組密碼」這件事本身就不能上線。

「真實身分來源」其實是一件事的兩半（SSO 與帳密登入）。
**交接範圍是否包含這一半，請先切清楚**——只做 SSO 的話，內部使用者的登入仍是未解問題。

## 5. 常見誤判

- **沒帶 `x-api-key` 不會報「缺 API Key」**。[`resolveTenant`](../server/src/middlewares/resolve-tenant.ts) 在沒有金鑰時會**落到預設租戶**，
  而預設租戶通常沒設 `ssoSecret`，所以你會看到 `403 此租戶未啟用 SSO`。
  看到這個 403 時，先確認你到底打到哪個租戶，而不是急著去設 secret。
- **金鑰來源有三個**：`x-api-key` header → `Authorization: ApiKey <key>` → `?key=pk_`（query 只接受 `pk_`，因為 iframe 載入無法帶自訂 header）。
- **`pk_` 與 `sk_` 都能換發**。`pk_` 是公開金鑰、會出現在瀏覽器，安全性由 `ssoSecret` 的簽章保證，不是由金鑰保密性保證。
- **CORS**：租戶的 `allowedOrigins` 要包含整合方網站的來源，否則瀏覽器端會先被 CORS 擋掉，根本走不到 SSO。

## 6. 本機驗證

已有一支可跑的**模擬租戶後端**，同時就是交給整合方的參考實作：

```bash
# 前提：server 已在 :3000 跑，且有一個設了 ssoSecret 的租戶
node presale/widge-tenant/server.mjs        # → http://localhost:4000
open http://localhost:4000
```

點右下角浮動按鈕，**不該看到登入頁**，直接進對話，身分＝SSO 帶入的使用者。
設定見 [`presale/widge-tenant/README.md`](../presale/widge-tenant/README.md)（`TENANT_PK` / `TENANT_SSO_SECRET` / `DEMO_USER_*`）。

純 API 驗證：

```bash
# 用 SDK 簽一張 userToken（Node REPL 或小腳本）
node -e "import('@hyagent/sdk/server').then(m=>console.log(m.signUserToken({sub:'HYW018',name:'林佩蓉',secret:'test-secret1234567890',expiresIn:'5m'})))"

# 換發
curl -s -X POST localhost:3000/api/auth/sso/exchange \
  -H 'content-type: application/json' -H 'x-api-key: pk_xxx' \
  -d '{"userToken":"<剛剛那張>"}' | jq .data
```

其他參考實作：[`sdk/src/index.ts`](../sdk/src/index.ts) 的 `ssoExchange` + 401 自動 refresh、
[`client/src/api.ts`](../client/src/api.ts) 的前端呼叫、[`presale/sdk-custom-ui/`](../presale/sdk-custom-ui/)（完全自建 UI 的整合方式）。

## 7. 測試現況

`authService.ssoExchange` **目前沒有任何測試**（`sdk/src/server.test.ts` 只測簽章工具那一端）。
[`server/tests/auth-sso.test.ts`](../server/tests/auth-sso.test.ts) 是這次補上的骨架，涵蓋現行契約：
未啟用 SSO → 403、驗章失敗 → 401、缺 `sub` → 401、成功換發帶 `via:'sso'` 與 `tenantId`。

**改動 SSO 行為前先看它，改完要讓它繼續綠**；4.1～4.4 的每一項補強都應該在這支檔案裡多一個 case。

```bash
npm test -w server -- auth-sso
```

## 8. 驗收清單

- [ ] `jwt.verify` 鎖定 `algorithms`，並依約定驗 `iss` / `aud`（4.1）
- [ ] 強制 `exp` 存在且效期在合理上限內（4.2）
- [ ] SSO 使用者的部門／權限來源已決定並實作，`user.directory.ts` 介面未變（4.3）
- [ ] SSO refresh 的撤銷策略已決定並實作（4.4）
- [ ] 帳密登入是否納入本次範圍，已與專案負責人確認（4.5）
- [ ] 正式環境設有 `DATA_ENCRYPTION_KEY`，`ssoSecret` 為加密落地
- [ ] `presale/widge-tenant` 走得通：不出現登入頁、身分正確、跨租戶隔離仍為 404
- [ ] `auth-sso.test.ts` 全綠；`npm run typecheck && npm test && npm run lint` 全綠
