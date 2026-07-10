# Phase 2C：Email 連接器 + 表單送出通知信（＋移除 '*' 萬用字元）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接上第一個真外部系統（Email），把 `email:write` 從「擺著的 scope」變成「真的在控制一個會發生的動作」——租戶被授予 `email:write` 後，員工送出表單會收到通知信；未授予則不寄、且不影響送出。同時移除 `hasScopes` 的 `'*'` 萬用字元（email:write 為第一個有副作用的能力，收緊萬用字元）。

**Architecture:** 新增 `lib/email/`（EmailConnector 抽象 + stub + smtp，比照 OA connector 的 stub/http 模式），`getConnector` 擴充 `'email'`（overload）；`email.send` 工具（scope `email:write`、不暴露給 Agent）；表單送出後在 `resolveSubmit` 外層包一次 best-effort `notifyOnSubmit`（呼 `email.send`，權限不足或寄信失敗一律吞掉、不影響送出）。`hasScopes` 移除 `'*'` 分支。

**Tech Stack:** TS/Express/Jest；nodemailer 6.10.1（已安裝）；既有 env `SMTP_*`/`MAIL_FROM`。既有件：[oa/stub.connector.ts](../../../server/src/lib/oa/stub.connector.ts)、[connectors/index.ts](../../../server/src/lib/connectors/index.ts)、[tool.registry.ts](../../../server/src/modules/tools/tool.registry.ts)、[form-submit.registry.ts](../../../server/src/modules/conversation/form-submit.registry.ts)、[user.directory.ts](../../../server/src/modules/user/user.directory.ts)。

## Global Constraints

- 語言：程式註解、訊息用繁體中文。
- 測試：Jest，`server/tests/*.test.ts`；跑法 `cd server && npx jest <file>`。Email 測試走 stub、零外部依賴（不真的連 SMTP）。
- `email:write` 已在 scope 目錄（grantable），本階段讓它成為真正被強制的能力。
- 通知信為 **best-effort**：權限不足（`email:write` 未授予 → 403）或寄信失敗，一律不得讓表單送出失敗。
- 移除 `'*'` 後，權限一律逐個 scope 比對；受影響的既有測試（用 `['*']` 者）改為具體 scope。
- 收尾：`cd server && npx jest` 全綠、`npm run typecheck`、`npm run build` 通過。

---

### Task 1: 移除 hasScopes 的 '*' 萬用字元

**Files:**
- Modify: `server/src/modules/tools/tool.registry.ts`
- Modify: `server/tests/tool-registry.test.ts`、`server/tests/tool-available.test.ts`（改用具體 scope）

**Interfaces:**
- Produces: `hasScopes(granted, required)` = `required.every((s) => granted.includes(s))`（不再有 `'*'` 特例）。

- [ ] **Step 1: 改實作**

在 `tool.registry.ts`，把：

```ts
/** granted 含 '*' 視為萬用字元；否則需涵蓋 required 全部。 */
function hasScopes(granted: string[], required: string[]): boolean {
  if (granted.includes('*')) return true;
  return required.every((s) => granted.includes(s));
}
```

改為：

```ts
/** granted 需涵蓋 required 全部（無萬用字元；scope 一律逐個比對）。 */
function hasScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}
```

- [ ] **Step 2: 改受影響測試（READ 現況再改）**

開啟 `server/tests/tool-registry.test.ts` 與 `server/tests/tool-available.test.ts`，找出所有以 `['*']` 當 `ctx.scopes` 的案例：
- **測試「萬用字元 scope 通過」語意的案例**（例如 tool-registry.test 的「萬用字元 scope 通過任何工具的權限檢查」）→ **刪除該測試**（此行為已移除）。
- **只是借 `['*']` 圖方便讓工具通過的案例** → 改成授予該工具實際要求的具體 scope（例如工具 `scopes:['test:read']` → ctx `scopes:['test:read']`）。
- **不要動** `scope-catalog.test.ts` 的 `assertGrantableScopes(['*'])`——那是「驗證 '*' 不可授予」的另一件事，與 hasScopes 無關，保留。

- [ ] **Step 3: 綠 + 全套 + 型別**

Run: `cd server && npx jest tests/tool-registry.test.ts tests/tool-available.test.ts` → PASS
Run: `cd server && npx jest` → 全綠（確認無其他依賴 `'*'` 的測試）
Run: `cd "$(git rev-parse --show-toplevel)" && npm run typecheck` → 無誤

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tools/tool.registry.ts server/tests/tool-registry.test.ts server/tests/tool-available.test.ts
git commit -m "refactor(authz): 移除 hasScopes 的 '*' 萬用字元，scope 一律逐個比對"
```

---

### Task 2: Email 連接器（stub + smtp）+ getConnector 擴充

**Files:**
- Create: `server/src/lib/email/types.ts`、`stub.connector.ts`、`smtp.connector.ts`、`index.ts`
- Modify: `server/src/config/env.ts`（加 `EMAIL_CONNECTOR`）
- Modify: `server/src/lib/connectors/index.ts`（加 `'email'` overload）
- Test: `server/tests/email-connector.test.ts`

**Interfaces:**
- Produces:
  - `interface EmailSendInput { to: string; subject: string; html: string }`
  - `interface EmailSendResult { messageId: string; status: 'sent' | 'queued' | 'failed' }`
  - `interface EmailConnector { readonly name: string; send(input: EmailSendInput): Promise<EmailSendResult> }`
  - `getEmailConnector(): EmailConnector`（依 `env.EMAIL_CONNECTOR`）
  - `stubSentEmails: EmailSendInput[]`（stub 記錄，供測試/demo 檢視）
  - `getConnector('email'): EmailConnector`（overload）

- [ ] **Step 1: 寫失敗測試**

`server/tests/email-connector.test.ts`:

```ts
/** Email 連接器：getConnector('email') 走 stub，send 回 STUB messageId 並記錄。 */
import { getConnector } from '@/lib/connectors';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email 連接器（stub）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it("getConnector('email') 回具 send 的連接器", () => {
    const email = getConnector('email');
    expect(typeof email.send).toBe('function');
    expect(typeof email.name).toBe('string');
  });

  it('send 回 STUB messageId 並記錄寄件', async () => {
    const res = await getConnector('email').send({ to: 'a@x.com', subject: '嗨', html: '<p>hi</p>' });
    expect(res.messageId).toMatch(/^STUB-/);
    expect(res.status).toBe('sent');
    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('a@x.com');
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`server/src/lib/email/types.ts`:

```ts
/** Email 連接器抽象。真 SMTP 由 smtp.connector 實作；stub 供 demo/測試零依賴。 */
export interface EmailSendInput {
  to: string;
  subject: string;
  html: string;
}
export interface EmailSendResult {
  messageId: string;
  status: 'sent' | 'queued' | 'failed';
}
export interface EmailConnector {
  readonly name: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}
```

`server/src/lib/email/stub.connector.ts`:

```ts
/** StubEmailConnector：不連 SMTP，記錄寄件並回合成 messageId，供 demo/測試檢視。 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import type { EmailConnector, EmailSendInput, EmailSendResult } from './types';

/** 記憶體保存寄件，方便 demo 後檢視 / 測試斷言 */
export const stubSentEmails: EmailSendInput[] = [];

export const stubEmailConnector: EmailConnector = {
  name: 'stub',
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    stubSentEmails.push(input);
    const messageId = `STUB-${randomUUID().slice(0, 8).toUpperCase()}`;
    logger.info({ messageId, to: input.to, subject: input.subject }, '[email:stub] sent');
    return { messageId, status: 'sent' };
  },
};
```

`server/src/lib/email/smtp.connector.ts`:

```ts
/** SmtpEmailConnector：以 nodemailer 依 env SMTP_* 寄信。EMAIL_CONNECTOR=smtp 時使用。 */
import nodemailer from 'nodemailer';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { EmailConnector, EmailSendInput, EmailSendResult } from './types';

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export const smtpEmailConnector: EmailConnector = {
  name: 'smtp',
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const info = await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
    logger.info({ messageId: info.messageId, to: input.to }, '[email:smtp] sent');
    return { messageId: info.messageId, status: 'sent' };
  },
};
```

`server/src/lib/email/index.ts`:

```ts
/** Email 連接器工廠：依 env.EMAIL_CONNECTOR 選擇實作（預設 stub）。 */
import { env } from '@/config/env';
import { smtpEmailConnector } from './smtp.connector';
import { stubEmailConnector } from './stub.connector';
import type { EmailConnector } from './types';

export function getEmailConnector(): EmailConnector {
  switch (env.EMAIL_CONNECTOR) {
    case 'stub':
      return stubEmailConnector;
    case 'smtp':
      return smtpEmailConnector;
    default:
      throw new Error(`Unsupported email connector: ${env.EMAIL_CONNECTOR as string}`);
  }
}

export * from './types';
```

`env.ts`：在 SMTP 區附近加入：

```ts
  EMAIL_CONNECTOR: z.enum(['stub', 'smtp']).default('stub'),
```

並在 superRefine（OA_BASE_URL 那段附近）加 fail-fast：

```ts
  if (val.EMAIL_CONNECTOR === 'smtp' && !val.SMTP_HOST) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_HOST'], message: 'SMTP_HOST is required when EMAIL_CONNECTOR=smtp' });
  }
```

`lib/connectors/index.ts`：改為 overload 支援 email：

```ts
import { getOAConnector } from '@/lib/oa';
import type { OAConnector } from '@/lib/oa/types';
import { getEmailConnector } from '@/lib/email';
import type { EmailConnector } from '@/lib/email/types';

export type ConnectorName = 'oa' | 'email';

export function getConnector(name: 'oa'): OAConnector;
export function getConnector(name: 'email'): EmailConnector;
export function getConnector(name: ConnectorName): OAConnector | EmailConnector {
  switch (name) {
    case 'oa':
      return getOAConnector();
    case 'email':
      return getEmailConnector();
    default:
      throw new Error(`unknown connector: ${name as string}`);
  }
}
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/email-connector.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/lib/email/ server/src/config/env.ts server/src/lib/connectors/index.ts server/tests/email-connector.test.ts
git commit -m "feat(email): Email 連接器（stub + smtp）與 getConnector('email')"
```

---

### Task 3: email.send 工具

**Files:**
- Create: `server/src/modules/tools/email.tools.ts`
- Modify: `server/src/modules/tools/index.ts`（side-effect import）
- Test: `server/tests/email-tool.test.ts`

**Interfaces:**
- Produces: 註冊工具 `email.send`（input `{to,subject,html}`；scope `['email:write']`；**不標 agentExposed**；handler → `getConnector('email').send`）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/email-tool.test.ts`:

```ts
/** email.send 工具：需 email:write；未授予 → 403；授予 → 走 stub 寄出。不暴露給 Agent。 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email.send 工具', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });
  afterEach(() => scopePolicy.clear());

  it('已註冊且未暴露給 Agent', () => {
    expect(toolRegistry.has('email.send')).toBe(true);
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(toolRegistry.availableFor(ctx).map((t) => t.name)).not.toContain('email.send');
  });

  it('未授予 email:write → 403', async () => {
    const t = tenantStore.createTenant('email-tool-noscope');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    await expect(
      toolRegistry.invoke('email.send', { to: 'a@x.com', subject: 's', html: '<p>h</p>' }, ctx),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('授予 email:write → 寄出（stub）', async () => {
    const t = tenantStore.createTenant('email-tool-scope');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    const res = (await toolRegistry.invoke(
      'email.send',
      { to: 'a@x.com', subject: 's', html: '<p>h</p>' },
      ctx,
    )) as { messageId: string };
    expect(res.messageId).toMatch(/^STUB-/);
    expect(stubSentEmails).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 失敗 → 實作**

`server/src/modules/tools/email.tools.ts`:

```ts
/** Email 工具：把 EmailConnector.send 包成工具。scope email:write；不暴露給 Agent（第一版不自主寄信）。 */
import { getConnector } from '@/lib/connectors';
import type { EmailSendInput, EmailSendResult } from '@/lib/email/types';
import { registerTool } from './tool.registry';

registerTool({
  id: 'email.send',
  description: '寄送一封 HTML 通知信給指定收件者。',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      html: { type: 'string' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  handler: (input: EmailSendInput): Promise<EmailSendResult> => getConnector('email').send(input),
});
```

`server/src/modules/tools/index.ts`：在既有 `import './oa.tools';` 之後加：

```ts
import './email.tools';
```

- [ ] **Step 3: 綠 + 全套 + 型別 + commit**

Run: `cd server && npx jest tests/email-tool.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤

```bash
git add server/src/modules/tools/email.tools.ts server/src/modules/tools/index.ts server/tests/email-tool.test.ts
git commit -m "feat(tools): email.send 工具（需 email:write，不暴露 Agent）"
```

---

### Task 4: 表單送出後寄通知信（第一個呼叫者）

**Files:**
- Modify: `shared/src/index.ts`（`Applicant` 加 `email?: string`）
- Modify: `server/src/modules/user/user.directory.ts`（mock 加 email）
- Modify: `server/src/modules/conversation/form-submit.registry.ts`（加 `notifyOnSubmit` + 包 `resolveSubmit`）
- Test: `server/tests/form-submit-notify.test.ts`

**Interfaces:**
- Consumes: `toolRegistry`/`makeToolContext`（`@/modules/tools`）、`getApplicant`（user.directory）、`getDefinition`（form.registry）。
- Produces: `resolveSubmit(formId)` 回傳的送出函式，在成功送出後 best-effort 呼 `email.send`（收件人＝申請人 email；權限不足/失敗吞掉、不影響回傳的 `FormSubmission`）。

- [ ] **Step 1: 寫失敗測試**

`server/tests/form-submit-notify.test.ts`:

```ts
/** 送出後通知信：租戶授予 email:write → 送出成功且寄出；未授予 → 送出仍成功、不寄。 */
import { resolveSubmit } from '@/modules/conversation/form-submit.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';
import { getDefinition } from '@/modules/form/form.registry';

// 用一張內建表單的最小合法值送出；leave-request 需要的欄位由 domain service 驗證，
// 這裡改用「通用送出」路徑最單純：挑一張非專屬 service 的表單或直接驗證 outing。
// 為求穩定，改以 outing-registration（有 oa.schema、走各自 service）並帶齊必填。

function validOutingValues() {
  // 依 outing-registration 的必填欄位帶最小合法值（實作時 READ schema 補齊）
  return { /* 由實作者依 schema 補齊必填 */ } as Record<string, unknown>;
}

describe('送出後通知信（best-effort）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('租戶授予 email:write → 送出成功且寄出通知', async () => {
    const t = tenantStore.createTenant('notify-yes');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const submit = resolveSubmit('outing-registration');
    const result = await submit(t.id, 'kevin', validOutingValues());
    expect(result.oaRequestId).toBeTruthy();
    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('kevin@example.com'); // 依 mock email
  });

  it('未授予 email:write → 送出仍成功、不寄信', async () => {
    const t = tenantStore.createTenant('notify-no');
    const submit = resolveSubmit('outing-registration');
    const result = await submit(t.id, 'kevin', validOutingValues());
    expect(result.oaRequestId).toBeTruthy();
    expect(stubSentEmails).toHaveLength(0);
  });
});
```

> 實作者：`validOutingValues()` 請 READ `schemas/outing-registration/` 的必填欄位補齊最小合法值，讓送出通過驗證。若 outing 的 domain service 驗證過於複雜，可改用「通用送出」能接受的任一內建表單，並於報告說明所選表單與理由。

- [ ] **Step 2: 失敗 → 實作**

`shared/src/index.ts` 的 `Applicant` 介面加：

```ts
  email?: string;
```

`user.directory.ts` 的 `DIRECTORY` 兩位使用者加 email（並確保 `getApplicant` 會帶出——它已 `{ id, ...profile }`，profile 含 email 即可）：

```ts
  kevin: { name: "Kevin Yang", department: "行銷部", title: "技術經理", region: "台北", email: "kevin@example.com" },
  hyweb: { name: "Eason Hsieh", department: "行銷部", title: "處長", region: "新竹", email: "hyweb@example.com" },
```

`form-submit.registry.ts`：加入 notify 並包裝 resolveSubmit。頂部 import：

```ts
import { makeToolContext, toolRegistry } from '@/modules/tools';
import { getApplicant } from '@/modules/user/user.directory';
import { logger } from '@/lib/logger';
```

新增函式（檔案底部）：

```ts
/**
 * 送出後 best-effort 寄通知信：收件人＝申請人 email。
 * 權限不足（email:write 未授予 → 403）或寄信失敗一律吞掉，絕不影響送出結果。
 */
async function notifyOnSubmit(
  tenantId: string,
  userId: string,
  formId: string,
  submission: FormSubmission,
): Promise<void> {
  try {
    const to = getApplicant(userId).email;
    if (!to) return; // 無 email → 略過
    const title = getDefinition(tenantId, formId).data.title ?? formId;
    await toolRegistry.invoke(
      'email.send',
      {
        to,
        subject: `【${title}】已送出`,
        html: `<p>您的「${title}」已送出，單號：${submission.oaRequestId}。</p>`,
      },
      makeToolContext({ tenantId, userId }),
    );
  } catch (err) {
    logger.info({ err, formId, userId }, '送出通知信略過（無權限或寄信失敗）');
  }
}
```

改寫 `resolveSubmit`，在原本回傳的送出函式外包一層 notify：

```ts
export function resolveSubmit(formId: string): FormSubmitFn {
  const base = submitRegistry[formId] ?? makeGenericSubmit(formId);
  return async (tenantId, userId, values) => {
    const result = await base(tenantId, userId, values);
    await notifyOnSubmit(tenantId, userId, formId, result);
    return result;
  };
}
```

（`getDefinition` 已 import；若未 import 則補 `import { getDefinition } from '@/modules/form/form.registry';`。）

- [ ] **Step 3: 綠 + 全套 + 型別 + build + commit**

Run: `cd server && npx jest tests/form-submit-notify.test.ts` → PASS；`cd server && npx jest` → 全綠；`npm run typecheck` → 無誤；`cd "$(git rev-parse --show-toplevel)" && npm run build` → 成功

```bash
git add shared/src/index.ts server/src/modules/user/user.directory.ts server/src/modules/conversation/form-submit.registry.ts server/tests/form-submit-notify.test.ts
git commit -m "feat(email): 表單送出後 best-effort 寄通知信（租戶授予 email:write 才寄）"
```

---

## 完成後狀態（驗收）

- 第一個真外部系統（Email）接上：`getConnector('email')`、`email.send` 工具、stub/smtp 可切換。
- **第一個畫面看得到的成果**：租戶在權限分頁勾選 `email:write` → 員工送出表單收到通知信；未勾 → 不寄、送出照常成功。
- `email:write` 從擺著的 scope 變成真正被強制的能力（403 阻擋、best-effort 不破壞送出）。
- `'*'` 萬用字元移除，權限一律逐個比對。
- 全套測試綠、typecheck/build 綠。

## Self-Review 註記

- **Spec 覆蓋**：藍圖 Phase 2「Email 連接器 + email:write」、first-caller＝送出通知信、`'*'` 收緊（final review 標的 pre-side-effect 決定）。
- **型別一致**：`EmailConnector`/`getEmailConnector`/`getConnector('email')` overload/`email.send`/`notifyOnSubmit` 一致；`Applicant.email?` 為 shared 型別加選填欄位、向後相容。
- **best-effort 保證**：`notifyOnSubmit` 全程 try/catch，且包在 `resolveSubmit` 成功送出「之後」——送出結果先產生再通知，通知任何失敗都不回溯影響 `FormSubmission`。
- **安全**：`email.send` scope `email:write`、不 agentExposed；`'*'` 移除後租戶/群組/帳號授予是唯一放行途徑。
- **風險**：Task 1 改 hasScopes 會動到用 `['*']` 的既有測試——已於 Task 1 Step 2 指示 READ 現況並區分「刪除 vs 改具體 scope」；notify 測試的表單必填值需 READ schema 補齊（Task 4 Step 1 已註記）。
