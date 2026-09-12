# SSO handoff

整合方在自己的後端完成登入後，以租戶的 `ssoSecret` 簽發短效 userToken，交給 widget 或 SDK。前端呼叫 `POST /api/auth/sso/exchange`，帶公開 API Key 與 userToken，交換 HyAgent Access / Refresh Token。

`ssoSecret` 僅留在整合方後端。管理 API 的租戶回應只提供 `ssoConfigured`，不回傳密鑰。

## 簽章契約

| 欄位 | 要求 |
| --- | --- |
| algorithm | HS256 |
| iss | hyagent:handoff |
| aud | hyagent:sso |
| sub | 宿主使用者唯一識別，不可空白 |
| name | 選填的顯示名稱字串 |
| iat | 簽發時間，必填，不得在未來 |
| exp | 必填，距 iat 最多 300 秒，交換時不得過期 |
| role | 不作為 HyAgent 授權依據；所有 SSO 登入一律為 employee |

使用更新後的 SDK：

```ts
import { signUserToken } from '@hyagent/sdk/server';

const userToken = signUserToken({
  secret: process.env.OA_SSO_SECRET!,
  sub: authenticatedUser.id,
  name: authenticatedUser.name,
  expiresIn: '5m',
});
```

自行使用 jsonwebtoken：

```ts
const userToken = jwt.sign(
  { sub: authenticatedUser.id, name: authenticatedUser.name },
  process.env.OA_SSO_SECRET!,
  {
    algorithm: 'HS256',
    issuer: 'hyagent:handoff',
    audience: 'hyagent:sso',
    expiresIn: '5m',
  },
);
```

交換請求：

```http
POST /api/auth/sso/exchange
Content-Type: application/json
x-api-key: pk_<租戶公開金鑰>

{"userToken":"<整合方後端簽發的短效 JWT>"}
```

## 把 token 交給 widget

userToken 最長只有 5 分鐘，所以「什麼時候簽」比「怎麼簽」更容易踩雷。widget 支援兩種交付方式：

| 方式 | 屬性 | 適用 |
| --- | --- | --- |
| 靜態 | `data-user-token="<jwt>"` | 宿主頁載入當下就會用到 widget，或每次載入都重新簽 |
| 端點 | `data-token-url="/your/token-endpoint"` | 長駐頁面（SPA）——使用者可能停留數小時後才點開 |

`data-token-url` 由 widget 在**首次點開面板時**才請求，拿到的票必定在有效期內：

```
POST <data-token-url>
credentials: include        ← 同源 cookie，由宿主自己的登入狀態決定發給誰
accept: application/json
```

回應接受 `{"token":"<jwt>"}`、`{"userToken":"<jwt>"}` 或 `{"data":{"token":"<jwt>"}}`。

端點**必須在宿主自己的後端**（Next.js route handler、Vercel Function、既有 API 皆可）：簽章要用 `ssoSecret`，放到瀏覽器等於把密鑰公開。純靜態站台（無任何後端）沒辦法安全地做 SSO handoff，只能讓使用者在面板內自行登入。

換票失敗（端點 4xx/5xx、沒有 token 欄位、網路錯誤）不會擋住面板：widget 會在 console 留下警告並照常開啟，使用者改為自行登入。兩個屬性都設時 `data-user-token` 優先。

## 租戶與權限

交換後的 Token 綁定該租戶。一般業務 API 的 API Key 必須屬於同一租戶，不能拿另一租戶的公開金鑰切換身份。內部帳密登入僅綁定 default。

平台管理員使用獨立 audience 的管理 Token。租戶 SSO 的 role=admin、manager 等值均不能取得平台管理 API 權限。業務角色請由 HyAgent 後台的帳號／群組／套餐 scope 配置。

## 續期與撤銷

`POST /api/auth/refresh` 接收 Refresh Token，每個 Token 只能成功使用一次。重複使用會撤銷同一登入 family 下的 Access / Refresh Token。前端與 SDK 已在同一執行環境內合併並行續期請求；自訂整合也必須避免平行重用。

前端在支援 Web Locks 的瀏覽器會協調跨分頁續期。自訂整合、未支援 Web Locks 的環境或多個客戶端不應各自重用同一組 Refresh Token；應協調 Token 更新，或讓每個客戶端分別登入。

租戶刪除、停用 SSO 或任何 SSO 密鑰設定更新後，既有 Token 無效；恢復舊密鑰也不會復活舊 Token。DB 模式驗證使用最新租戶資料，而非依賴程序中的舊快取。

SSO userToken 過期後不能拿來重新交換，須由宿主重新取得短效 userToken。既有舊版登入 Token 需重新登入，不再接受缺少用途欄位的舊簽章。

部署與資料庫 migration 見 [安全修正升級說明](SECURITY-FIXES.md)。
