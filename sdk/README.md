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
  key: 'pk_xxxxx',            // 租戶公開金鑰
  userToken: '<宿主簽發的 JWT>', // SSO：免內部帳密登入（選用）
  apiBase: 'https://oa.example', // 省略則同源
});

// 建立對話（不帶 message → 不觸發 LLM；帶 message → 起首輪）
const turn = await oa.conversations.create({ formId: 'leave-request', message: '我要請假' });
await oa.conversations.sendMessage(turn.id!, '明天一天');
const result = await oa.conversations.submit(turn.id!);
console.log(result.submission?.oaRequestId);
```

## widget 橋接用法

```ts
const oa = createOAAgent({ key: 'pk_xxxxx', widgetSrc: 'https://oa.example/widget.js' });

oa.loadWidget();            // 動態注入 widget.js（自動帶上 key / userToken）
oa.open();                  // 程式化開關
const off = oa.on('submitted', (detail) => console.log('已送出', detail));
// off(); // 取消訂閱
```

事件型別：`open` / `close` / `submitted`（對應 widget.js 發出的 `oa-agent:*` DOM 事件）。

## 伺服器端：簽發 SSO user token（`@hyagent/sdk/server`）

給「整合方後端」用：使用者登入自家系統後，用該租戶的 `ssoSecret` 簽一張 user token，
交給前端塞進 widget（`data-user-token`）或 SDK（`userToken`）。**ssoSecret 須留在後端、勿外洩。**

```ts
import { signUserToken } from '@hyagent/sdk/server';

// 在你的後端，於使用者登入後：
const userToken = signUserToken({
  sub: 'EMP-1234',      // 使用者在你系統的識別
  name: '小明',          // 顯示名（選用）
  secret: process.env.OA_SSO_SECRET, // = 建租戶時設定的 ssoSecret
  expiresIn: '5m',      // 建議短效
});
// 把 userToken 回給前端使用
```

> 主入口（`@hyagent/sdk`）是瀏覽器端；server 子入口依賴 `jsonwebtoken`，僅供 Node 使用。
> 完整可跑範例見 [presale/widge-tenant](../presale/widge-tenant)。

## 認證模型

- `key`（pk_…）→ 每個請求附 `x-api-key`，後端解析租戶並做資料隔離；省略則落到預設租戶。
- `userToken` → 以租戶 SSO 密鑰驗章後換發本系統 token；遇 401 自動 refresh 一次。
