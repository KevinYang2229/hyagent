# @hyagent/sdk

HyAgent 整合 SDK（瀏覽器端）。提供兩種整合方式，共用同一組租戶設定：

- **headless REST**：開發者自建 UI，直接呼叫對話 / 表單 API。
- **widget 橋接**：程式化開關內建 widget、訂閱事件。

## 安裝

```bash
npm install @hyagent/sdk
```

## headless 用法（自建 UI）

```ts
import { createOAAgent } from '@hyagent/sdk';

const oa = createOAAgent({
  key: 'pk_xxxxx',                     // 租戶公開金鑰
  // Token Provider：需要身分時現取一張 Assertion（免內部帳密登入，選用）。
  // 傳函式而非字串：Assertion 有效期 60 秒且一次性，SDK 會在 Session 到期前
  // 60 秒與收到 401 時自動再呼叫一次，長駐頁面不必重建 client。
  assertion: () => fetch('/api/mybot/identity', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.token ?? null),
  apiBase: 'https://oa.example',       // 省略則同源
});

// 建立對話（不帶 message → 不觸發 LLM；帶 message → 起首輪）
const turn = await oa.conversations.create({ formId: 'leave-request', message: '我要請假' });
await oa.conversations.sendMessage(turn.id!, '明天一天');
const result = await oa.conversations.submit(turn.id!);
console.log(result.submission?.oaRequestId);
```

## widget 橋接用法

```ts
const oa = createOAAgent({ key: 'pk_xxxxx', tokenUrl: '/api/mybot/identity' });

oa.loadWidget();            // 動態注入 https://<apiBase>/sdk/widget.js（自動帶上 key / tokenUrl）
oa.open();                  // 程式化開關
const off = oa.on('submitted', (detail) => console.log('已送出', detail));
// off(); // 取消訂閱
```

事件型別：`open` / `close` / `submitted`（對應 widget.js 發出的 `oa-agent:*` DOM 事件）。

## 產生金鑰對：keygen CLI（`bin/keygen.mjs`）

導入第一天與每次金鑰輪替時用一次。**金鑰對必須在你自己的環境產生**——HyAgent 只拿公鑰，
因此沒有能力偽造你家任何一位使用者的身分（規格 §2.2）。

```bash
npx hyagent-keygen ES256 ./keys     # 已安裝本套件時
node bin/keygen.mjs ES256 ./keys    # 或直接執行；HyAgent 也可只交付這一個檔案
```

```text
{ "alg": "ES256", "kid": "JIyMfVT7Az-…" }
-----BEGIN PUBLIC KEY-----
…
-----END PUBLIC KEY-----

已寫入：
  keys/hyagent-<kid>.public.pem    ← 上傳 HyAgent 後台
  keys/hyagent-<kid>.private.pem   ← 自行保管，絕不外流（0600）
```

| 參數／選項 | 說明 |
| --- | --- |
| `[RS256\|ES256] [輸出目錄]` | 預設 `ES256` 與 `./keys` |
| `--modulus <bits>` | RS256 的 modulus，預設 2048；低於 2048 拒絕 |
| `--kid <PEM 檔>` | 只算既有金鑰的 `kid`（以 OpenSSL 產生、或要和後台核對時用） |

這支 CLI **零相依、單一檔案、Node 18+ 可直接跑**，不需要 `npm install`：它的使用者是你的維運
人員，而它一年只跑一兩次，不值得為它準備一套工具鏈。代價是它自帶一份 `kid` 計算，
由 `src/keygen-cli.test.ts` 與 SDK、HyAgent 後端交叉比對釘住。

在本 repo 內開發時：`npm run keygen -- ES256 ./keys`。

## 伺服器端：簽發 Identity Assertion（`@hyagent/sdk/server`）

給「整合方後端」用：使用者登入自家系統後，以**自家私鑰**簽一張短效 Assertion，
由自家的 Identity Endpoint 回給 widget（`data-token-url`），或交給 headless SDK（`assertion`）。

**私鑰絕不可離開你的環境。** HyAgent 只持有公鑰，因此沒有能力偽造任何一位使用者的身分。

```ts
import { generateKeyPair, issueAssertion } from '@hyagent/sdk/server';

// 一次性：產生金鑰對，publicKeyPem 交給 HyAgent 登記，privateKeyPem 留在你的環境
const { publicKeyPem, privateKeyPem } = generateKeyPair('ES256');

// 每次前端來要身分時（Identity Endpoint 內）：
const assertion = issueAssertion({
  privateKey: process.env.HYAGENT_PRIVATE_KEY!, // 建議 KMS / Vault
  tenant: 'your-tenant-id',                     // 會成為 iss
  subject: 'EMP-1234',                          // 使用者在你系統的識別
  profile: { name: '小明' },                     // 自訂 claims，原樣帶過
});
```

每次呼叫都會產生新的 `jti`：Assertion 有效期 60 秒且**一次性**，
快取重用會被 HyAgent 以 `TOKEN_REPLAYED` 拒絕。

> 主入口（`@hyagent/sdk`）是瀏覽器端；server 子入口零相依（只用 `node:crypto`），僅供 Node 使用。
> 完整可跑範例見 [presale/widge-tenant](../presale/widge-tenant)。

## 認證模型

- `key`（pk_…）→ 每個請求附 `x-api-key`，後端解析租戶並做資料隔離；省略則落到預設租戶。
  它**不決定身分**：租戶由 Assertion 的 `iss` 認定，`pk_` 只影響外觀設定與 CORS。
- `assertion` → 貴方以**私鑰**簽發的 Identity Assertion（RS256 / ES256），換得一個不透明的
  HyAgent Session。Session 是伺服器端有狀態的，SDK 不解析它的內容。

簽章要求：`iss` 為 Tenant ID、`aud=hyagent`、`exp - iat ≤ 300 秒`、每張帶新的 `jti`（一次性）。
外部 `role` 不作為授權依據。詳見 [Identity Assertion 契約](../docs/HANDOFF-SSO.md)。

### Session 的續期與結束

SSO 路徑**沒有 refresh token**（規格 §7.1）。續期就是重走一次 token provider：

| 時機 | 誰做 |
| --- | --- |
| 到期前 60 秒 | SDK 自動（下一個請求前判斷；`assertion` 須為函式） |
| Session 被作廢（撤銷 `kid`、依 `sub` 作廢）而回 `401` | SDK 自動重取一張並重送該請求 |
| 貴方系統換了登入者 | 呼叫 `refreshIdentity()`——SDK 看不到這件事 |
| 使用者登出 | 呼叫 `logout()`：通知後端作廢 Session，並清掉本地憑證 |

`assertion` 傳字串時只能換一次（那張票是一次性的），到期後 `refreshIdentity()` 會回 `false`。
