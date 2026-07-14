# 租戶自帶 AI 金鑰（BYO key）＋ Token 級成本歸戶 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租戶可透過 sk\_ 自助 API 或 admin 後台設定自己的 OpenAI / Anthropic API key 與 provider/model；LLM 與 embedding 呼叫依租戶設定計費歸戶（按模型 × key 來源聚合 token，配單價表算成本）。

**Architecture:** 方案 A 工廠參數化——`getLLMProvider(config?)` 接租戶 `llmConfig`，SDK client 以 apiKey 快取；`LLMResult` 由 provider 蓋上 `model` / `keySource` 戳記，usage store 據此聚合。設定的讀寫集中在 `llmConfigService`（合併、驗證、遮罩、稽核），自助與 admin 兩條路由共用。

**Tech Stack:** Express + TypeScript（NodeNext、`@/` 別名）、zod 驗證、jest + ts-jest + supertest（測試在 `server/tests/*.test.ts`）、React admin（`admin/src`）。

**Spec:** `docs/superpowers/specs/2026-07-14-tenant-byo-llm-key-design.md`

## Global Constraints

- 註解、錯誤訊息、UI 文案一律**繁體中文**；程式碼註解風格比照現有檔案（說「為什麼」，不贅述「做什麼」）。
- **向後相容**：未帶 tenant/未設 llmConfig 的行為與現行完全相同（預設租戶、舊 widget 零改變）；`npm run smoke` 必須始終通過。
- 完整 API key **絕不**出現在任何 API 回應、log、audit summary 中；回應一律遮罩。
- 租戶 key 失效**不得** fallback 平台 key（spec D6）。
- Anthropic SDK 為 0.32（**沒有** `client.models.list()`）；key 驗證用原生 `fetch` 打各家 `/v1/models`。
- 指令從 repo 根目錄跑：測試 `npm run test -w server`、單檔 `npm run test -w server -- tests/<file>.test.ts`、型別 `npm run typecheck`、煙測 `npm run smoke`。
- 測試環境（`server/tests/setup-env.ts`）已設 `ANTHROPIC_API_KEY=test-anthropic-key`、`ADMIN_API_KEY=test-admin-key`、資料目錄隔離；env 預設 `LLM_PROVIDER=anthropic`、`LLM_MODEL=claude-sonnet-4-5`、`LLM_ROUTER_MODEL=claude-haiku-4-5-20251001`。
- 預設租戶固定金鑰 `pk_default` / `sk_default`（tenant.store 種子），supertest 可直接用。
- commit message 用 Conventional Commits 繁中描述，結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: LLM 設定解析（型別 + resolveLLMSettings + pickModel）

**Files:**
- Modify: `server/src/lib/llm/types.ts`
- Create: `server/src/lib/llm/resolve-settings.ts`
- Test: `server/tests/llm-resolve-settings.test.ts`

**Interfaces:**
- Consumes: `env`（`@/config/env`：`LLM_PROVIDER` / `LLM_MODEL` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）
- Produces（後續 Task 全靠這些簽章）:
  - `type LLMKeySource = 'platform' | 'tenant'`
  - `interface TenantLLMConfig { provider?: 'anthropic' | 'openai'; model?: string; anthropicApiKey?: string; openaiApiKey?: string }`
  - `LLMResult` 增加 `model: string; keySource: LLMKeySource`
  - `resolveLLMSettings(config?: TenantLLMConfig): ResolvedLLMSettings`
  - `pickModel(settings: ResolvedLLMSettings, requested?: string): string`
  - `interface ResolvedLLMSettings { provider: 'anthropic' | 'openai'; apiKey: string; keySource: LLMKeySource; model: string; lockModel: boolean }`

- [ ] **Step 1: 寫失敗測試**

`server/tests/llm-resolve-settings.test.ts`：

```ts
import { pickModel, resolveLLMSettings } from '@/lib/llm/resolve-settings';

// setup-env：LLM_PROVIDER=anthropic（預設）、LLM_MODEL=claude-sonnet-4-5、
// ANTHROPIC_API_KEY=test-anthropic-key、OPENAI_API_KEY 未設（''）

describe('resolveLLMSettings fallback 矩陣', () => {
  it('無設定 → 平台 provider / 平台 key / 不鎖模型', () => {
    const s = resolveLLMSettings(undefined);
    // 不寫死 key 值：setup-env 用 ??=，開發機 shell 若已匯出真 key 不會被覆蓋
    expect(s).toEqual({
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      keySource: 'platform',
      model: 'claude-sonnet-4-5',
      lockModel: false,
    });
  });

  it('只放同廠商 key（未設 provider）→ 換帳單歸屬，模型照舊、不鎖', () => {
    const s = resolveLLMSettings({ anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.keySource).toBe('tenant');
    expect(s.apiKey).toBe('sk-ant-tenant-key-000000');
    expect(s.provider).toBe('anthropic');
    expect(s.lockModel).toBe(false);
  });

  it('只放他廠商 key（未設 provider）→ 用不到，仍是平台 key', () => {
    const s = resolveLLMSettings({ openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(s.keySource).toBe('platform');
    expect(s.apiKey).toBe('test-anthropic-key');
  });

  it('自訂 provider + key + model → 全套租戶設定且鎖模型', () => {
    const s = resolveLLMSettings({
      provider: 'openai',
      model: 'gpt-4o',
      openaiApiKey: 'sk-tenant-openai-key-000',
    });
    expect(s).toEqual({
      provider: 'openai',
      apiKey: 'sk-tenant-openai-key-000',
      keySource: 'tenant',
      model: 'gpt-4o',
      lockModel: true,
    });
  });

  it('自訂他廠商 provider 未給 model → 用該廠商內建預設（env.LLM_MODEL 是別家的模型名）', () => {
    const s = resolveLLMSettings({ provider: 'openai', openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(s.model).toBe('gpt-4o-mini');
    expect(s.lockModel).toBe(true);
  });

  it('自訂 provider 同平台廠商未給 model → 沿用 env.LLM_MODEL', () => {
    const s = resolveLLMSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.model).toBe('claude-sonnet-4-5');
  });
});

describe('pickModel（每呼叫模型選擇）', () => {
  it('未鎖：呼叫端覆寫優先（router 用便宜模型）', () => {
    const s = resolveLLMSettings(undefined);
    expect(pickModel(s, 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(pickModel(s, undefined)).toBe('claude-sonnet-4-5');
  });

  it('鎖定：一律用租戶模型，忽略覆寫（避免廠商錯配）', () => {
    const s = resolveLLMSettings({ provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(pickModel(s, 'claude-haiku-4-5-20251001')).toBe('gpt-4o');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/llm-resolve-settings.test.ts`
Expected: FAIL（Cannot find module '@/lib/llm/resolve-settings'）

- [ ] **Step 3: 實作**

`server/src/lib/llm/types.ts` — 在檔尾（`LLMResult` 定義處）修改與新增：

```ts
export type LLMKeySource = 'platform' | 'tenant';

/**
 * 租戶層 AI 設定（BYO key）。key 按廠商分欄：對話 provider 選 anthropic 時，
 * openaiApiKey 仍可供知識庫 embedding 使用（Anthropic 無 embedding API）。
 */
export interface TenantLLMConfig {
  provider?: 'anthropic' | 'openai';
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}
```

並把 `LLMResult` 改為（provider 蓋戳記，讓 usage 記錄不必回推設定）：

```ts
export interface LLMResult {
  text: string;
  toolCalls: LLMToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: LLMUsage;
  /** 本次實際使用的模型（計費歸戶用） */
  model: string;
  /** 本次用的是平台 key 還是租戶自帶 key（計費歸戶用） */
  keySource: LLMKeySource;
}
```

Create `server/src/lib/llm/resolve-settings.ts`：

```ts
/**
 * 租戶 llmConfig → 實際 LLM 連線設定的解析（spec D5 方案 A 的核心規則）。
 *
 * - 未設 provider：平台 provider/model 照舊；若租戶放了「同廠商」的 key，只換帳單歸屬。
 * - 有設 provider：全套用租戶設定，並鎖定模型（router/rerank 的便宜模型覆寫一律忽略，
 *   避免「租戶用 OpenAI 但 router model 是 claude-haiku」的廠商錯配）。
 */
import { env } from '@/config/env';
import type { LLMKeySource, TenantLLMConfig } from './types';

export type LLMProviderName = 'anthropic' | 'openai';

/** 租戶自訂 provider 但未指定 model 時的各廠商預設（env.LLM_MODEL 可能是別家的模型名） */
const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
};

export interface ResolvedLLMSettings {
  provider: LLMProviderName;
  apiKey: string;
  keySource: LLMKeySource;
  model: string;
  /** true = 每呼叫的 model 覆寫一律忽略（租戶自訂 provider 時） */
  lockModel: boolean;
}

function envKeyFor(provider: LLMProviderName): string {
  return provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
}

function tenantKeyFor(provider: LLMProviderName, config?: TenantLLMConfig): string | undefined {
  const key = provider === 'anthropic' ? config?.anthropicApiKey : config?.openaiApiKey;
  return key && key.trim() ? key : undefined;
}

export function resolveLLMSettings(config?: TenantLLMConfig): ResolvedLLMSettings {
  const provider = config?.provider ?? env.LLM_PROVIDER;
  const tenantKey = tenantKeyFor(provider, config);
  const apiKey = tenantKey ?? envKeyFor(provider);
  const keySource: LLMKeySource = tenantKey ? 'tenant' : 'platform';

  if (config?.provider) {
    return {
      provider,
      apiKey,
      keySource,
      model:
        config.model ?? (provider === env.LLM_PROVIDER ? env.LLM_MODEL : DEFAULT_MODELS[provider]),
      lockModel: true,
    };
  }
  return { provider, apiKey, keySource, model: env.LLM_MODEL, lockModel: false };
}

/** 每次呼叫實際使用的模型：鎖定時一律租戶模型；否則呼叫端覆寫優先 */
export function pickModel(settings: ResolvedLLMSettings, requested?: string): string {
  return settings.lockModel ? settings.model : (requested ?? settings.model);
}
```

> 注意：此時 `LLMResult` 多了必填欄位，兩個 provider 尚未回傳 → `npm run typecheck` 會暫時紅（Task 3 修）。本 task 只要求新測試綠。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -w server -- tests/llm-resolve-settings.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/llm/types.ts server/src/lib/llm/resolve-settings.ts server/tests/llm-resolve-settings.test.ts
git commit -m "feat(llm): 租戶 LLM 設定解析（provider/key/model fallback 矩陣）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 錯誤歸因（AppError.badGateway + mapProviderError）

**Files:**
- Modify: `server/src/utils/app-error.ts`
- Create: `server/src/lib/llm/provider-error.ts`
- Test: `server/tests/llm-provider-error.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ResolvedLLMSettings`
- Produces:
  - `AppError.badGateway(message?: string): AppError`（HTTP 502）
  - `mapProviderError(err: unknown, settings: Pick<ResolvedLLMSettings, 'keySource'>): unknown`

- [ ] **Step 1: 寫失敗測試**

`server/tests/llm-provider-error.test.ts`：

```ts
import { mapProviderError } from '@/lib/llm/provider-error';
import { AppError } from '@/utils/app-error';

function sdkError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe('mapProviderError（spec D6：租戶 key 失效明確歸因、不 fallback）', () => {
  it('租戶 key + 401/403 → 502 AppError，訊息指出租戶金鑰問題', () => {
    const out = mapProviderError(sdkError(401), { keySource: 'tenant' });
    expect(out).toBeInstanceOf(AppError);
    expect((out as AppError).statusCode).toBe(502);
    expect((out as AppError).message).toContain('AI 金鑰');
  });

  it('租戶 key + 429 → 502 額度/限流訊息', () => {
    const out = mapProviderError(sdkError(429), { keySource: 'tenant' });
    expect((out as AppError).message).toContain('額度');
  });

  it('租戶 key + 其他錯誤（如 500）→ 原樣拋回', () => {
    const err = sdkError(500);
    expect(mapProviderError(err, { keySource: 'tenant' })).toBe(err);
  });

  it('平台 key → 一律原樣（維持現行行為）', () => {
    const err = sdkError(401);
    expect(mapProviderError(err, { keySource: 'platform' })).toBe(err);
  });
});
```

> 若 `AppError` 的狀態碼屬性名不是 `statusCode`，以 `server/src/utils/app-error.ts` 實際欄位名為準修正測試（先讀該檔）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/llm-provider-error.test.ts`
Expected: FAIL（Cannot find module '@/lib/llm/provider-error'）

- [ ] **Step 3: 實作**

`server/src/utils/app-error.ts` — 在 `internal()` 旁加（比照既有 static 寫法與屬性名）：

```ts
  static badGateway(message = 'Bad gateway'): AppError {
    return new AppError(502, message);
  }
```

> 以檔內既有 static（如 `internal`）的建構參數順序為準；若建構子是 `(message, statusCode)` 順序則對調。

Create `server/src/lib/llm/provider-error.ts`：

```ts
/**
 * 租戶自帶 key 失效時的錯誤歸因（spec D6）。
 *
 * 只在 keySource='tenant' 時把 401/403/402/429 轉成明確訊息的 502，
 * 讓呼叫端與使用者知道「是租戶的 key 出問題」而不是籠統 500；
 * 平台 key 的錯誤維持原樣（現行行為，交由既有 error handler）。
 * 絕不在此 fallback 平台 key——否則租戶以為在花自己的錢，實際燒平台的。
 */
import { AppError } from '@/utils/app-error';
import type { ResolvedLLMSettings } from './resolve-settings';

export function mapProviderError(
  err: unknown,
  settings: Pick<ResolvedLLMSettings, 'keySource'>,
): unknown {
  if (settings.keySource !== 'tenant') return err;
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    return AppError.badGateway('此租戶設定的 AI 金鑰無效或遭拒，請更新租戶的 AI 金鑰設定');
  }
  if (status === 402 || status === 429) {
    return AppError.badGateway('此租戶的 AI 金鑰額度不足或被限流，請檢查該金鑰的方案與用量');
  }
  return err;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -w server -- tests/llm-provider-error.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/utils/app-error.ts server/src/lib/llm/provider-error.ts server/tests/llm-provider-error.test.ts
git commit -m "feat(llm): 租戶金鑰失效錯誤歸因（502 明確訊息、不 fallback 平台 key）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Provider 工廠改造 + getLLMProvider(config?)

**Files:**
- Modify: `server/src/lib/llm/anthropic.provider.ts`
- Modify: `server/src/lib/llm/openai.provider.ts`
- Modify: `server/src/lib/llm/index.ts`

**Interfaces:**
- Consumes: Task 1 `resolveLLMSettings` / `pickModel` / `ResolvedLLMSettings`、Task 2 `mapProviderError`
- Produces:
  - `createAnthropicProvider(settings: ResolvedLLMSettings): LLMProvider`
  - `createOpenAIProvider(settings: ResolvedLLMSettings): LLMProvider`
  - `getLLMProvider(config?: TenantLLMConfig): LLMProvider`（無參數＝現行行為）
  - 兩家 provider 的 `createMessage` 回傳值多 `model` / `keySource`

- [ ] **Step 1: 改造 anthropic.provider.ts**

刪除 module-level `const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });` 與 `export const anthropicProvider`，改為工廠 + client 快取（`toContentParam` / `toMessageParams` / `STOP_MAP` 不動）：

```ts
import Anthropic from '@anthropic-ai/sdk';
import { mapProviderError } from './provider-error';
import { pickModel, type ResolvedLLMSettings } from './resolve-settings';
// （移除 `import { env } from '@/config/env'`；model/maxTokens 預設改由 settings 與 env 以外途徑）
```

> 注意：`max_tokens` 仍用 `params.maxTokens ?? env.LLM_MAX_TOKENS`，故 `env` import **保留**，只是不再用於 apiKey/model。

```ts
// SDK client 以 apiKey 快取：同 key 重用連線，不每請求重建
const clients = new Map<string, Anthropic>();
function getClient(apiKey: string): Anthropic {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

export function createAnthropicProvider(settings: ResolvedLLMSettings): LLMProvider {
  return {
    name: 'anthropic',

    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      const toolList = params.tools ?? [];
      const tools = /* …原樣保留現有 tools 組裝… */;
      const system = /* …原樣保留現有 system 組裝… */;

      const model = pickModel(settings, params.model);
      let resp: Anthropic.Message;
      try {
        resp = await getClient(settings.apiKey).messages.create({
          model,
          max_tokens: params.maxTokens ?? env.LLM_MAX_TOKENS,
          system,
          tools: tools.length > 0 ? tools : undefined,
          messages: toMessageParams(params.messages),
        });
      } catch (err) {
        throw mapProviderError(err, settings);
      }

      /* …原樣保留 text/toolCalls/usage 解析… */

      return {
        text,
        toolCalls,
        stopReason: STOP_MAP[resp.stop_reason ?? ''] ?? 'other',
        model,
        keySource: settings.keySource,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
        },
      };
    },
  };
}
```

（「原樣保留」的區塊照現檔內容搬進工廠函式即可，內容不變。）

- [ ] **Step 2: 改造 openai.provider.ts**

同樣手法：刪 `let client` lazy singleton 與 `export const openaiProvider`，`toOpenAIMessages` / `parseArgs` / `STOP_MAP` 不動：

```ts
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

export function createOpenAIProvider(settings: ResolvedLLMSettings): LLMProvider {
  return {
    name: 'openai',

    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      const tools: ChatCompletionTool[] = /* …原樣… */;
      const model = pickModel(settings, params.model);
      let resp: OpenAI.Chat.Completions.ChatCompletion;
      try {
        resp = await getClient(settings.apiKey).chat.completions.create({
          model,
          max_tokens: params.maxTokens ?? env.LLM_MAX_TOKENS,
          messages: toOpenAIMessages(params.system, params.messages),
          tools: tools.length > 0 ? tools : undefined,
        });
      } catch (err) {
        throw mapProviderError(err, settings);
      }

      /* …原樣保留 choice/text/toolCalls 解析… */

      return {
        text,
        toolCalls,
        stopReason: STOP_MAP[choice?.finish_reason ?? ''] ?? 'other',
        model,
        keySource: settings.keySource,
        usage: {
          inputTokens: resp.usage?.prompt_tokens ?? 0,
          outputTokens: resp.usage?.completion_tokens ?? 0,
          cacheReadTokens: resp.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
        },
      };
    },
  };
}
```

- [ ] **Step 3: 改 index.ts 工廠簽章**

`server/src/lib/llm/index.ts` 全檔改為：

```ts
/**
 * LLM provider 工廠：依「租戶 llmConfig → resolveLLMSettings」選擇實作與金鑰。
 * 未帶 config（或租戶未設定）＝現行 env 行為，預設租戶零改變。
 */
import { createAnthropicProvider } from './anthropic.provider';
import { createOpenAIProvider } from './openai.provider';
import { resolveLLMSettings } from './resolve-settings';
import type { LLMProvider, TenantLLMConfig } from './types';

export function getLLMProvider(config?: TenantLLMConfig): LLMProvider {
  const settings = resolveLLMSettings(config);
  return settings.provider === 'anthropic'
    ? createAnthropicProvider(settings)
    : createOpenAIProvider(settings);
}

export * from './types';
export { resolveLLMSettings, pickModel } from './resolve-settings';
export type { ResolvedLLMSettings, LLMProviderName } from './resolve-settings';
```

- [ ] **Step 4: 驗證**

Run: `npm run typecheck`
Expected: PASS（既有呼叫端 `getLLMProvider()` 零參數呼叫依然合法；`LLMResult` 新欄位由 provider 補齊）

Run: `npm run test -w server`
Expected: PASS（全部既有測試不受影響）

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/llm/
git commit -m "refactor(llm): provider 改工廠參數化，client 依 apiKey 快取，結果蓋 model/keySource 戳記

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 金鑰驗證 verifyLLMKey（原生 fetch）

**Files:**
- Create: `server/src/lib/llm/verify-key.ts`
- Test: `server/tests/llm-verify-key.test.ts`

**Interfaces:**
- Produces: `verifyLLMKey(provider: 'anthropic' | 'openai', apiKey: string): Promise<boolean>`
  - 金鑰無效（HTTP 4xx）→ `false`；有效 → `true`；網路層失敗 → throw `AppError.badGateway`

- [ ] **Step 1: 寫失敗測試**

`server/tests/llm-verify-key.test.ts`：

```ts
import { verifyLLMKey } from '@/lib/llm/verify-key';
import { AppError } from '@/utils/app-error';

describe('verifyLLMKey', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('anthropic：帶 x-api-key + anthropic-version 打 /v1/models，200 → true', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mock as unknown as typeof fetch;
    await expect(verifyLLMKey('anthropic', 'sk-ant-xxx')).resolves.toBe(true);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-xxx');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('openai：帶 Bearer 打 /v1/models，401 → false', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    global.fetch = mock as unknown as typeof fetch;
    await expect(verifyLLMKey('openai', 'sk-bad')).resolves.toBe(false);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-bad');
  });

  it('網路失敗 → 拋 502（不能誤判成金鑰無效）', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(verifyLLMKey('openai', 'sk-x')).rejects.toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/llm-verify-key.test.ts`
Expected: FAIL（Cannot find module '@/lib/llm/verify-key'）

- [ ] **Step 3: 實作**

`server/src/lib/llm/verify-key.ts`：

```ts
/**
 * 存前金鑰驗證：以各家 GET /v1/models 輕量確認 key 有效（免費、不產生 token 費用）。
 *
 * 用原生 fetch 而非 SDK：本專案的 @anthropic-ai/sdk 0.32 沒有 models API，
 * 且驗證只需一個 GET，不值得為此升級/繞道 SDK。
 * 語意：4xx = 金鑰無效（false）；網路層失敗 = 無法驗證（502，避免把斷線誤判成壞 key）。
 */
import { AppError } from '@/utils/app-error';
import type { LLMProviderName } from './resolve-settings';

const VERIFY_TIMEOUT_MS = 10_000;

export async function verifyLLMKey(provider: LLMProviderName, apiKey: string): Promise<boolean> {
  const { url, headers } =
    provider === 'anthropic'
      ? {
          url: 'https://api.anthropic.com/v1/models',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        }
      : {
          url: 'https://api.openai.com/v1/models',
          headers: { authorization: `Bearer ${apiKey}` },
        };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    return res.ok;
  } catch {
    throw AppError.badGateway('無法連線至 AI 供應商驗證金鑰，請稍後再試');
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -w server -- tests/llm-verify-key.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/llm/verify-key.ts server/tests/llm-verify-key.test.ts
git commit -m "feat(llm): 存前金鑰驗證（fetch /v1/models，4xx=無效、斷線=502）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: usage store 擴充 + 單價表 + 成本計算

**Files:**
- Modify: `server/src/modules/usage/usage.store.ts`
- Create: `server/src/config/model-pricing.ts`
- Create: `server/src/modules/usage/usage.cost.ts`
- Test: `server/tests/usage-cost.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LLMUsage` / `LLMKeySource`
- Produces:
  - `interface ModelTokenUsage { model: string; keySource: LLMKeySource; inputTokens: number; outputTokens: number; cacheReadTokens: number }`
  - `TenantUsage` 增加 `embeddingTokens: number; llmByModel: Record<string, ModelTokenUsage>`（key 格式 `` `${keySource}|${model}` ``，value 自帶 model/keySource 供 UI 直接用）
  - `usageStore.recordLLMUsage(tenantId: string, result?: { usage?: LLMUsage; model?: string; keySource?: LLMKeySource }): void`（**簽章變更**：原第二參數 `LLMUsage` 改為整個 result-like 物件）
  - `usageStore.recordEmbeddingUsage(tenantId: string, tokens: number, model: string, keySource: LLMKeySource): void`
  - `computeUsageCost(usage: TenantUsage): UsageCost`；`interface UsageCost { totalUsd: number; platformUsd: number; tenantUsd: number; byModel: Array<ModelTokenUsage & { usd: number | null }> }`（未知模型 `usd: null`、不計入總額）

- [ ] **Step 1: 寫失敗測試**

`server/tests/usage-cost.test.ts`：

```ts
import { usageStore } from '@/modules/usage/usage.store';
import { computeUsageCost } from '@/modules/usage/usage.cost';

const T = `usage-cost-test-${Date.now()}`; // 每次跑用新租戶 id，避免磁碟殘留干擾

describe('usage 按模型×key 來源聚合', () => {
  it('recordLLMUsage 聚合到 llmByModel，llmTokens 總數照舊累加', () => {
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 500, outputTokens: 100 },
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
    });
    usageStore.recordLLMUsage(T, {
      usage: { inputTokens: 400, outputTokens: 50 },
      model: 'gpt-4o',
      keySource: 'tenant',
    });

    const u = usageStore.get(T);
    expect(u.llmTokens).toBe(1000 + 200 + 300 + 500 + 100 + 400 + 50);
    expect(u.llmByModel['platform|claude-sonnet-4-5']).toEqual({
      model: 'claude-sonnet-4-5',
      keySource: 'platform',
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 300,
    });
    expect(u.llmByModel['tenant|gpt-4o'].inputTokens).toBe(400);
  });

  it('recordEmbeddingUsage 累加 embeddingTokens 並進 llmByModel', () => {
    usageStore.recordEmbeddingUsage(T, 8000, 'text-embedding-3-large', 'platform');
    const u = usageStore.get(T);
    expect(u.embeddingTokens).toBe(8000);
    expect(u.llmByModel['platform|text-embedding-3-large'].inputTokens).toBe(8000);
  });

  it('無 usage 或 0 token 不寫入', () => {
    const before = JSON.stringify(usageStore.get(T));
    usageStore.recordLLMUsage(T, undefined);
    usageStore.recordLLMUsage(T, { usage: { inputTokens: 0, outputTokens: 0 } });
    expect(JSON.stringify(usageStore.get(T))).toBe(before);
  });
});

describe('computeUsageCost', () => {
  it('已知模型按單價表計價，平台/租戶分開加總', () => {
    const cost = computeUsageCost(usageStore.get(T));
    // claude-sonnet-4-5（platform）：in 1500*3 + out 300*15 + cache 300*0.3 = (4500+4500+90)/1e6
    const sonnet = cost.byModel.find((m) => m.model === 'claude-sonnet-4-5');
    expect(sonnet?.usd).toBeCloseTo((1500 * 3 + 300 * 15 + 300 * 0.3) / 1_000_000, 8);
    expect(cost.platformUsd).toBeGreaterThan(0);
    expect(cost.tenantUsd).toBeGreaterThan(0); // gpt-4o（tenant）
    expect(cost.totalUsd).toBeCloseTo(cost.platformUsd + cost.tenantUsd, 8);
  });

  it('未知模型 usd=null 且不計入總額', () => {
    const T2 = `usage-cost-unknown-${Date.now()}`;
    usageStore.recordLLMUsage(T2, {
      usage: { inputTokens: 100, outputTokens: 100 },
      model: 'some-unknown-model',
      keySource: 'platform',
    });
    const cost = computeUsageCost(usageStore.get(T2));
    expect(cost.byModel[0].usd).toBeNull();
    expect(cost.totalUsd).toBe(0);
  });

  it('recordLLMUsage 未帶 model（舊呼叫端防禦）→ 只加總數、不進 byModel', () => {
    const T3 = `usage-cost-nomodel-${Date.now()}`;
    usageStore.recordLLMUsage(T3, { usage: { inputTokens: 10, outputTokens: 5 } });
    const u = usageStore.get(T3);
    expect(u.llmTokens).toBe(15);
    expect(Object.keys(u.llmByModel)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/usage-cost.test.ts`
Expected: FAIL（Cannot find module '@/modules/usage/usage.cost'；recordLLMUsage 型別/行為不符）

- [ ] **Step 3: 實作單價表**

Create `server/src/config/model-pricing.ts`：

```ts
/**
 * 模型單價表（USD / 每百萬 token）。成本在「讀取時」計算、不落地——改價免重算歷史。
 * 未列出的模型視為無單價（usd: null），UI 標示「無單價資料」。
 * 來源：各家官方定價頁；cacheRead 為 prompt cache 讀取價（Anthropic 為 input 的 10%）。
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  'text-embedding-3-large': { inputPerMTok: 0.13, outputPerMTok: 0, cacheReadPerMTok: 0 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0, cacheReadPerMTok: 0 },
};
```

- [ ] **Step 4: 擴充 usage.store.ts**

修改 `server/src/modules/usage/usage.store.ts`（保留 persist/restore/increment 既有邏輯）：

```ts
import type { LLMKeySource, LLMUsage } from '@/lib/llm/types';

export interface ModelTokenUsage {
  model: string;
  keySource: LLMKeySource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TenantUsage {
  conversations: number;
  messages: number;
  submissions: number;
  llmTokens: number;
  embeddingTokens: number;
  /** key = `${keySource}|${model}`；value 自帶 model/keySource，UI 不需解析 key */
  llmByModel: Record<string, ModelTokenUsage>;
}

export type UsageMetric = 'conversations' | 'messages' | 'submissions' | 'llmTokens' | 'embeddingTokens';
```

`empty()` 補新欄位；restore 時舊檔資料正規化（磁碟上的舊紀錄沒有新欄位）：

```ts
function empty(): TenantUsage {
  return { conversations: 0, messages: 0, submissions: 0, llmTokens: 0, embeddingTokens: 0, llmByModel: {} };
}
// restore 迴圈內改為：
for (const [k, v] of raw) usage.set(k, { ...empty(), ...v });
```

`recordLLMUsage` 改簽章 + 新增 `recordEmbeddingUsage` 與共用聚合：

```ts
function bucket(u: TenantUsage, model: string, keySource: LLMKeySource): ModelTokenUsage {
  const key = `${keySource}|${model}`;
  return (u.llmByModel[key] ??= { model, keySource, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
}

export const usageStore = {
  increment(/* 原樣不動 */) { /* … */ },

  /** result 直接餵 LLMResult 即可（provider 已蓋 model/keySource 戳記） */
  recordLLMUsage(
    tenantId: string,
    result?: { usage?: LLMUsage; model?: string; keySource?: LLMKeySource },
  ): void {
    const llmUsage = result?.usage;
    if (!llmUsage) return;
    const total = llmUsage.inputTokens + llmUsage.outputTokens + (llmUsage.cacheReadTokens ?? 0);
    if (total <= 0) return;
    const current = usage.get(tenantId) ?? empty();
    current.llmTokens += total;
    if (result?.model) {
      const b = bucket(current, result.model, result.keySource ?? 'platform');
      b.inputTokens += llmUsage.inputTokens;
      b.outputTokens += llmUsage.outputTokens;
      b.cacheReadTokens += llmUsage.cacheReadTokens ?? 0;
    }
    usage.set(tenantId, current);
    persist();
  },

  recordEmbeddingUsage(tenantId: string, tokens: number, model: string, keySource: LLMKeySource): void {
    if (tokens <= 0) return;
    const current = usage.get(tenantId) ?? empty();
    current.embeddingTokens += tokens;
    bucket(current, model, keySource).inputTokens += tokens;
    usage.set(tenantId, current);
    persist();
  },

  get(tenantId: string): TenantUsage {
    return usage.get(tenantId) ?? empty();
  },
};
```

- [ ] **Step 5: 實作成本計算**

Create `server/src/modules/usage/usage.cost.ts`：

```ts
/**
 * 用量 → 預估成本（讀取時計算，spec D4）。
 * platform key = 應向租戶收的錢；tenant key = 參考資訊（錢已直接付給 AI 廠商）。
 */
import { MODEL_PRICING } from '@/config/model-pricing';
import type { ModelTokenUsage, TenantUsage } from './usage.store';

export interface UsageCost {
  totalUsd: number;
  platformUsd: number;
  tenantUsd: number;
  byModel: Array<ModelTokenUsage & { usd: number | null }>;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function computeUsageCost(usage: TenantUsage): UsageCost {
  let platformUsd = 0;
  let tenantUsd = 0;
  const byModel = Object.values(usage.llmByModel).map((m) => {
    const price = MODEL_PRICING[m.model];
    if (!price) return { ...m, usd: null };
    const usd =
      (m.inputTokens * price.inputPerMTok +
        m.outputTokens * price.outputPerMTok +
        m.cacheReadTokens * price.cacheReadPerMTok) /
      1_000_000;
    if (m.keySource === 'platform') platformUsd += usd;
    else tenantUsd += usd;
    return { ...m, usd: round(usd) };
  });
  return {
    totalUsd: round(platformUsd + tenantUsd),
    platformUsd: round(platformUsd),
    tenantUsd: round(tenantUsd),
    byModel,
  };
}
```

- [ ] **Step 6: 修既有呼叫端編譯錯誤（簽章變更）**

`recordLLMUsage(tenantId, result.usage)` 的 5 個呼叫端此時型別不符（`LLMUsage` 沒有 `usage` 屬性但結構相容——實際上舊呼叫傳 `result.usage` 會被當成 `{usage?...}` 物件，`.usage` 為 undefined → 不記錄）。**本步先把 5 個呼叫端改為傳整個 `result`**（同時就是 Task 6 的 usage 部分，提前到這裡讓行為不迴歸）：

- `server/src/modules/conversation/conversation.agent.ts:77`：`usageStore.recordLLMUsage(session.tenantId, result);`
- `server/src/modules/conversation/intent-router.ts:90`：`usageStore.recordLLMUsage(session.tenantId, result);`
- `server/src/modules/conversation/tool-loop.ts:39`：`usageStore.recordLLMUsage(session.tenantId, result);`
- `server/src/modules/knowledge/rerank.ts:43`：`usageStore.recordLLMUsage(tenantId, result);`
- `server/src/modules/knowledge/knowledge.agent-service.ts:126`：`usageStore.recordLLMUsage(session.tenantId, result);`

- [ ] **Step 7: 跑測試確認通過**

Run: `npm run test -w server -- tests/usage-cost.test.ts`
Expected: PASS（6 tests）

Run: `npm run typecheck && npm run test -w server`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/usage/ server/src/config/model-pricing.ts server/src/modules/conversation/ server/src/modules/knowledge/
git commit -m "feat(usage): token 按模型×key來源聚合＋單價表成本計算

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 呼叫點接上租戶 llmConfig

**Files:**
- Modify: `server/src/modules/tenant/tenant.types.ts`
- Modify: `server/src/modules/conversation/conversation.agent.ts`
- Modify: `server/src/modules/conversation/intent-router.ts`
- Modify: `server/src/modules/knowledge/rerank.ts`
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts`

**Interfaces:**
- Consumes: Task 3 `getLLMProvider(config?)`、`TenantLLMConfig`（自 `@/lib/llm`）
- Produces: `Tenant.llmConfig?: TenantLLMConfig`；`summarizeText` 私有函式簽章改為 `(tenantId: string, name: string, text: string)`

- [ ] **Step 1: Tenant 型別加 llmConfig**

`server/src/modules/tenant/tenant.types.ts`：

```ts
import type { TenantLLMConfig } from '@/lib/llm/types';
```

`Tenant` interface 內（`grantedScopes` 之後）加：

```ts
  /**
   * 租戶自帶 AI 設定（BYO key，spec 2026-07-14）：provider/model/兩家 key。
   * 未設＝平台 env 設定；讀寫一律走 llmConfigService（合併/驗證/遮罩/稽核）。
   */
  llmConfig?: TenantLLMConfig;
```

- [ ] **Step 2: 四個 getLLMProvider 呼叫點傳入租戶設定**

`conversation.agent.ts` — `runTurn` 內：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
// …
const llm = getLLMProvider(tenantStore.getTenant(session.tenantId)?.llmConfig);
```

`intent-router.ts` — classify 內（有 `session`）：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
// …
const result = await getLLMProvider(tenantStore.getTenant(session.tenantId)?.llmConfig).createMessage({
```

`rerank.ts` — `rerankChunks` 內（有 `tenantId` 參數）：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
// …
const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
```

`knowledge-file.service.ts` — `summarizeText` 加 `tenantId` 參數並用之；呼叫端同步改：

```ts
async function summarizeText(tenantId: string, name: string, text: string): Promise<string | null> {
  try {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      // …system/messages/maxTokens/model 原樣…
    });
    usageStore.recordLLMUsage(tenantId, result); // 摘要呼叫此前漏記用量，一併補上
    // …原樣…
```

`ingestFile` 內呼叫處改為：

```ts
const summary = pieces.length >= 2 ? await summarizeText(tenantId, name, text) : null;
```

（`knowledge-file.service.ts` 需補 `import { tenantStore } from '@/modules/tenant/tenant.store';` 與 `import { usageStore } from '@/modules/usage/usage.store';`。）

> 註：`knowledge.agent-service.ts` 與 `tool-loop.ts` 的 `llm` 是 `runTurn` 傳入的參數，改 `runTurn` 一處即全數生效，無需再動。

- [ ] **Step 3: 驗證**

Run: `npm run typecheck && npm run test -w server`
Expected: PASS

Run: `npm run smoke`
Expected: PASS（純 schema 引擎，不碰 LLM——向後相容證據）

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tenant/tenant.types.ts server/src/modules/conversation/ server/src/modules/knowledge/
git commit -m "feat(llm): 對話/路由/重排/摘要呼叫點依租戶 llmConfig 選 provider 與金鑰

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Embedding 租戶化 + token 記錄

**Files:**
- Modify: `server/src/lib/embedding/index.ts`
- Modify: `server/src/modules/knowledge/ingest.service.ts`
- Modify: `server/src/modules/knowledge/knowledge-file.service.ts`
- Modify: `server/src/modules/knowledge/retriever.staticIndex.ts`
- Modify: `server/tests/knowledge-file.test.ts`（mock 形狀）＋ 其他 mock `@/lib/embedding` 的測試

**Interfaces:**
- Consumes: `TenantLLMConfig` / `LLMKeySource`、`usageStore.recordEmbeddingUsage`
- Produces（**breaking change**，呼叫端全在本 task 內更新）:
  - `interface EmbedResult { vectors: number[][]; tokens: number }`
  - `EmbeddingProvider.embed(texts: string[], model?: string): Promise<EmbedResult>`
  - `EmbeddingProvider.keySource: LLMKeySource`
  - `getEmbeddingProvider(config?: TenantLLMConfig): EmbeddingProvider`（租戶有 `openaiApiKey` 就用它，spec D3）

- [ ] **Step 1: 找出所有 embed 呼叫端與 mock**

Run: `grep -rn "getEmbeddingProvider\|@/lib/embedding" server/src server/tests --include="*.ts"`
Expected 已知清單：`ingest.service.ts`、`knowledge-file.service.ts`、`retriever.staticIndex.ts`、`tests/knowledge-file.test.ts`。若 grep 多出其他檔（如其他測試 mock），一併按下述形狀更新。

- [ ] **Step 2: 改寫 lib/embedding/index.ts**

```ts
/**
 * Embedding provider（用於知識庫 RAG）。
 *
 * Claude 無原生 embedding API，故用 OpenAI text-embedding 系列；
 * 租戶設有自己的 openaiApiKey 時用租戶的 key（BYO，帳單歸租戶），否則用平台 key。
 * 回傳含 tokens 供成本歸戶；索引與查詢共用同一模型/維度。
 */
import OpenAI from 'openai';
import { env } from '@/config/env';
import type { LLMKeySource, TenantLLMConfig } from '@/lib/llm/types';

export interface EmbedResult {
  vectors: number[][];
  /** 本次消耗的 embedding token 數（OpenAI usage.total_tokens） */
  tokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly keySource: LLMKeySource;
  /** 批次向量化；回傳順序與輸入對應；model 可覆寫預設模型 */
  embed(texts: string[], model?: string): Promise<EmbedResult>;
}

// SDK client 以 apiKey 快取（同 lib/llm 手法）；延遲建立避免無 key 時啟動失敗
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

function createProvider(apiKey: string, keySource: LLMKeySource): EmbeddingProvider {
  return {
    model: env.EMBEDDING_MODEL,
    keySource,
    async embed(texts: string[], model?: string): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      const resp = await getClient(apiKey).embeddings.create({
        model: model ?? env.EMBEDDING_MODEL,
        input: texts,
      });
      return { vectors: resp.data.map((d) => d.embedding), tokens: resp.usage?.total_tokens ?? 0 };
    },
  };
}

export function getEmbeddingProvider(config?: TenantLLMConfig): EmbeddingProvider {
  const tenantKey = config?.openaiApiKey?.trim();
  return tenantKey ? createProvider(tenantKey, 'tenant') : createProvider(env.OPENAI_API_KEY, 'platform');
}
```

- [ ] **Step 3: 更新三個呼叫端（傳租戶設定＋記 token）**

`ingest.service.ts`（embed 迴圈處；`params.tenantId` 已存在）：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
// …
const embedder = getEmbeddingProvider(tenantStore.getTenant(params.tenantId)?.llmConfig);
const chunks: IndexedChunk[] = [];
for (let i = 0; i < pending.length; i += EMBED_BATCH) {
  const batch = pending.slice(i, i + EMBED_BATCH);
  const { vectors, tokens } = await embedder.embed(batch.map((c) => c.text), params.embeddingModel);
  usageStore.recordEmbeddingUsage(params.tenantId, tokens, params.embeddingModel ?? embedder.model, embedder.keySource);
  batch.forEach((c, j) => chunks.push({ ...c, vector: vectors[j] }));
  onProgress?.({ /* 原樣 */ });
}
```

> 若 `params.embeddingModel` 型別為必填 string，直接用 `params.embeddingModel`（以檔內實際型別為準）。

`knowledge-file.service.ts`（`ingestFile` 內）：

```ts
const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
const { vectors, tokens } = await embedder.embed(toEmbed, model);
usageStore.recordEmbeddingUsage(tenantId, tokens, model, embedder.keySource);
```

`retriever.staticIndex.ts`（`search` 內）：

```ts
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
// …
const embedder = getEmbeddingProvider(tenantStore.getTenant(tenantId)?.llmConfig);
const { vectors: [queryVec], tokens } = await embedder.embed([q], idx.model);
usageStore.recordEmbeddingUsage(tenantId, tokens, idx.model, embedder.keySource);
if (!queryVec) return [];
```

- [ ] **Step 4: 更新測試 mock**

`server/tests/knowledge-file.test.ts` 的 mock 改為新形狀：

```ts
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]), tokens: texts.length * 10 }),
  }),
}));
```

Step 1 grep 找到的其他 mock 檔比照更新。

- [ ] **Step 5: 驗證**

Run: `npm run typecheck && npm run test -w server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/embedding/ server/src/modules/knowledge/ server/tests/
git commit -m "feat(embedding): 租戶 OpenAI key 歸戶 embedding 呼叫並記錄 token 用量

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: llmConfig 儲存層 + 遮罩 + llmConfigService

**Files:**
- Modify: `server/src/modules/tenant/tenant.store.ts`
- Create: `server/src/modules/tenant/llm-config.schema.ts`
- Create: `server/src/modules/tenant/llm-config.service.ts`
- Test: `server/tests/tenant-llm-config.test.ts`

**Interfaces:**
- Consumes: Task 4 `verifyLLMKey`（測試中 jest.mock）、`auditStore`、`tenantStore`
- Produces:
  - `tenantStore.updateTenant` 的 patch 支援 `llmConfig?: TenantLLMConfig | undefined`（`'llmConfig' in patch` 時整包覆寫；`undefined` = 清空）
  - `putLlmConfigSchema`（zod）；`type PutLLMConfigInput`：`{ provider?: 'anthropic'|'openai'|null; model?: string|null; anthropicApiKey?: string|null; openaiApiKey?: string|null }`（省略=不變、null=清除）
  - `interface LLMConfigView { provider: 'anthropic' | 'openai' | null; model: string | null; anthropicApiKey: string | null; openaiApiKey: string | null }`（key 為遮罩字串）
  - `llmConfigService.get(tenantId: string): LLMConfigView`
  - `llmConfigService.update(tenantId: string, patch: PutLLMConfigInput, actor: string): Promise<LLMConfigView>`
  - `maskKey(key: string): string`

- [ ] **Step 1: 寫失敗測試**

`server/tests/tenant-llm-config.test.ts`：

```ts
jest.mock('@/lib/llm/verify-key', () => ({
  verifyLLMKey: jest.fn(async () => true),
}));

import { verifyLLMKey } from '@/lib/llm/verify-key';
import { llmConfigService, maskKey } from '@/modules/tenant/llm-config.service';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';

const mockVerify = verifyLLMKey as jest.MockedFunction<typeof verifyLLMKey>;

describe('maskKey', () => {
  it('只露頭 7 尾 4', () => {
    expect(maskKey('sk-ant-api03-abcdefghijklmnop-wxyz')).toBe('sk-ant-…wxyz');
    expect(maskKey('sk-proj-1234567890abcdef')).toBe('sk-proj…cdef');
  });
});

describe('llmConfigService', () => {
  beforeEach(() => mockVerify.mockClear());

  it('update 合併設定、驗證新 key、回傳遮罩視圖', async () => {
    const t = tenantStore.createTenant('byo-test');
    const view = await llmConfigService.update(
      t.id,
      { provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-proj-tenant-openai-000000' },
      'admin',
    );
    expect(mockVerify).toHaveBeenCalledWith('openai', 'sk-proj-tenant-openai-000000');
    expect(view.provider).toBe('openai');
    expect(view.openaiApiKey).toContain('…'); // 遮罩
    expect(view.openaiApiKey).not.toContain('tenant-openai'); // 不露完整 key
    // store 內存完整 key（runtime 要用）
    expect(tenantStore.getTenant(t.id)?.llmConfig?.openaiApiKey).toBe('sk-proj-tenant-openai-000000');
  });

  it('省略欄位=不變、null=清除', async () => {
    const t = tenantStore.createTenant('byo-merge');
    await llmConfigService.update(t.id, { anthropicApiKey: 'sk-ant-key-000000000000000' }, 'admin');
    await llmConfigService.update(t.id, { model: null }, 'admin'); // 不動 key
    expect(tenantStore.getTenant(t.id)?.llmConfig?.anthropicApiKey).toBeDefined();
    await llmConfigService.update(t.id, { anthropicApiKey: null }, 'admin');
    expect(tenantStore.getTenant(t.id)?.llmConfig).toBeUndefined(); // 全空 → 整包清除
  });

  it('key 驗證失敗 → 400 且不寫入', async () => {
    mockVerify.mockResolvedValueOnce(false);
    const t = tenantStore.createTenant('byo-badkey');
    await expect(
      llmConfigService.update(t.id, { openaiApiKey: 'sk-proj-bad-key-0000000000' }, 'admin'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(tenantStore.getTenant(t.id)?.llmConfig).toBeUndefined();
  });

  it('model 未搭配 provider → 400', async () => {
    const t = tenantStore.createTenant('byo-model-only');
    await expect(llmConfigService.update(t.id, { model: 'gpt-4o' }, 'admin')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  // setup-env 不設 OPENAI_API_KEY；但開發機 shell 若有匯出真 key，此情境不成立 → 跳過
  const itNoOpenAIKey = process.env.OPENAI_API_KEY ? it.skip : it;
  itNoOpenAIKey('provider=openai 但無任何 OpenAI key（租戶+平台皆無）→ 400', async () => {
    const t = tenantStore.createTenant('byo-no-key');
    await expect(llmConfigService.update(t.id, { provider: 'openai' }, 'admin')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('查無租戶 → 404；get 未設定 → 全 null 視圖', async () => {
    await expect(llmConfigService.update('nope', { model: null }, 'admin')).rejects.toBeInstanceOf(AppError);
    const t = tenantStore.createTenant('byo-empty');
    expect(llmConfigService.get(t.id)).toEqual({
      provider: null,
      model: null,
      anthropicApiKey: null,
      openaiApiKey: null,
    });
  });
});
```

> `AppError` 狀態碼屬性名以 Task 2 確認的為準（`statusCode` 或其他）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/tenant-llm-config.test.ts`
Expected: FAIL（Cannot find module '@/modules/tenant/llm-config.service'）

- [ ] **Step 3: tenant.store.updateTenant 支援 llmConfig**

`updateTenant` 的 patch 型別 `Pick<…>` 清單加 `'llmConfig'`，spread 區塊加（用 `in` 檢查讓 `undefined` 能「清空」欄位——與其他欄位的 `!== undefined` 慣例不同，因為這裡需要三態：不動/覆寫/清空）：

```ts
      ...('llmConfig' in patch ? { llmConfig: patch.llmConfig } : {}),
```

並把 patch 型別改為：

```ts
    patch: Partial<
      Pick<
        Tenant,
        | 'name'
        | 'allowedOrigins'
        | 'ssoSecret'
        | 'appearance'
        | 'disabledServices'
        | 'disabledForms'
        | 'grantedScopes'
        | 'scopesMigrated'
        | 'llmConfig'
      >
    >,
```

- [ ] **Step 4: zod schema**

Create `server/src/modules/tenant/llm-config.schema.ts`：

```ts
import { z } from 'zod';

/** PUT llm-config：省略欄位＝不變、null＝清除該欄（三態 patch 語意） */
export const putLlmConfigSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).nullable().optional(),
    model: z.string().trim().min(1).max(100).nullable().optional(),
    anthropicApiKey: z.string().trim().min(20).max(300).nullable().optional(),
    openaiApiKey: z.string().trim().min(20).max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

export type PutLLMConfigInput = z.infer<typeof putLlmConfigSchema>;
```

- [ ] **Step 5: llm-config.service**

Create `server/src/modules/tenant/llm-config.service.ts`：

```ts
/**
 * 租戶 AI 設定（BYO key）的唯一讀寫入口：合併三態 patch、存前驗證金鑰、
 * 回應一律遮罩、異動寫 audit。自助（sk_）與 admin 兩條路由共用。
 */
import { env } from '@/config/env';
import { verifyLLMKey } from '@/lib/llm/verify-key';
import type { TenantLLMConfig } from '@/lib/llm/types';
import { auditStore } from '@/modules/audit/audit.store';
import { AppError } from '@/utils/app-error';
import type { PutLLMConfigInput } from './llm-config.schema';
import { tenantStore } from './tenant.store';

export interface LLMConfigView {
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
}

/** 頭 7 尾 4，中間以 … 取代；完整 key 絕不外流 */
export function maskKey(key: string): string {
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function toView(config?: TenantLLMConfig): LLMConfigView {
  return {
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    anthropicApiKey: config?.anthropicApiKey ? maskKey(config.anthropicApiKey) : null,
    openaiApiKey: config?.openaiApiKey ? maskKey(config.openaiApiKey) : null,
  };
}

function ensureTenant(tenantId: string) {
  const tenant = tenantStore.getTenant(tenantId);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

/** 三態合併：undefined=不變、null=清除、值=覆寫 */
function mergeField<K extends keyof TenantLLMConfig>(
  merged: TenantLLMConfig,
  patch: PutLLMConfigInput,
  field: K,
): void {
  const v = patch[field as keyof PutLLMConfigInput];
  if (v === undefined) return;
  if (v === null) delete merged[field];
  else merged[field] = v as TenantLLMConfig[K];
}

export const llmConfigService = {
  get(tenantId: string): LLMConfigView {
    return toView(ensureTenant(tenantId).llmConfig);
  },

  async update(tenantId: string, patch: PutLLMConfigInput, actor: string): Promise<LLMConfigView> {
    const tenant = ensureTenant(tenantId);
    const merged: TenantLLMConfig = { ...tenant.llmConfig };
    mergeField(merged, patch, 'provider');
    mergeField(merged, patch, 'model');
    mergeField(merged, patch, 'anthropicApiKey');
    mergeField(merged, patch, 'openaiApiKey');

    // 規則檢查（合併後整體看）：model 沒有 provider 就無意義（spec 路由規則只認 provider）
    if (merged.model && !merged.provider) {
      throw AppError.badRequest('model 需搭配 provider 一併設定');
    }
    // provider 指定後，該廠商必須有可用金鑰（租戶自帶或平台 env），否則 runtime 必炸
    if (merged.provider) {
      const tenantKey = merged.provider === 'anthropic' ? merged.anthropicApiKey : merged.openaiApiKey;
      const envKey = merged.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (!tenantKey && !envKey) {
        throw AppError.badRequest(`供應商 ${merged.provider} 沒有可用金鑰，請一併提供 key`);
      }
    }
    // 只驗證「本次新提供」的 key（既存 key 已驗過；清除不需驗）
    if (patch.anthropicApiKey) {
      if (!(await verifyLLMKey('anthropic', patch.anthropicApiKey))) {
        throw AppError.badRequest('Anthropic 金鑰驗證失敗，請確認金鑰有效');
      }
    }
    if (patch.openaiApiKey) {
      if (!(await verifyLLMKey('openai', patch.openaiApiKey))) {
        throw AppError.badRequest('OpenAI 金鑰驗證失敗，請確認金鑰有效');
      }
    }

    const next = Object.keys(merged).length > 0 ? merged : undefined;
    tenantStore.updateTenant(tenantId, { llmConfig: next });

    // 稽核只記「動了哪些欄位」，絕不記 key 內容
    const changed = (Object.keys(patch) as Array<keyof PutLLMConfigInput>).map((k) =>
      patch[k] === null ? `${k}(清除)` : k,
    );
    auditStore.record(tenantId, {
      toolId: 'tenant.llm-config.update',
      userId: actor,
      at: new Date().toISOString(),
      ok: true,
      summary: `更新 AI 模型設定：${changed.join('、')}`,
    });

    return toView(next);
  },
};
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npm run test -w server -- tests/tenant-llm-config.test.ts`
Expected: PASS（7 tests；有本機 OPENAI_API_KEY 時其中 1 skip）

Run: `npm run typecheck && npm run test -w server`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/tenant/ server/tests/tenant-llm-config.test.ts
git commit -m "feat(tenant): llmConfig 儲存層＋三態合併/存前驗證/遮罩/稽核 service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: 自助 API（sk\_）+ admin API + getUsage 成本

**Files:**
- Create: `server/src/modules/tenant/tenant.self.controller.ts`
- Create: `server/src/modules/tenant/tenant.routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`
- Modify: `server/src/modules/admin/admin.controller.ts`
- Test: `server/tests/tenant-llm-config-api.test.ts`

**Interfaces:**
- Consumes: Task 8 `llmConfigService` / `putLlmConfigSchema`、Task 5 `computeUsageCost`、既有 `resolveTenant` / `tenantRateLimit` / `requireAdmin` / `validate` / `asyncHandler`
- Produces:
  - `GET/PUT /api/tenant/llm-config`（僅 `req.apiKeyType === 'secret'`，否則 403）
  - `GET/PUT /api/admin/tenants/:id/llm-config`
  - `GET /api/admin/tenants/:id/usage` 回應改為 `{ ...TenantUsage, cost: UsageCost }`

- [ ] **Step 1: 寫失敗測試（supertest）**

`server/tests/tenant-llm-config-api.test.ts`：

```ts
jest.mock('@/lib/llm/verify-key', () => ({
  verifyLLMKey: jest.fn(async () => true),
}));

import request from 'supertest';
import { createApp } from '@/app';

const app = createApp();

describe('/api/tenant/llm-config（sk_ 自助）', () => {
  it('sk_ 金鑰可 PUT + GET（GET 回遮罩）', async () => {
    const put = await request(app)
      .put('/api/tenant/llm-config')
      .set('x-api-key', 'sk_default')
      .send({ provider: 'anthropic', anthropicApiKey: 'sk-ant-tenant-key-00000000' });
    expect(put.status).toBe(200);
    expect(put.body.data.anthropicApiKey).toContain('…');

    const get = await request(app).get('/api/tenant/llm-config').set('x-api-key', 'sk_default');
    expect(get.status).toBe(200);
    expect(get.body.data.provider).toBe('anthropic');
    expect(JSON.stringify(get.body)).not.toContain('sk-ant-tenant-key-00000000');
  });

  it('pk_ 公開金鑰 → 403（公開金鑰不得讀寫設定）', async () => {
    const res = await request(app).get('/api/tenant/llm-config').set('x-api-key', 'pk_default');
    expect(res.status).toBe(403);
  });

  it('未帶 key（落預設租戶但無金鑰種類）→ 403', async () => {
    const res = await request(app).get('/api/tenant/llm-config');
    expect(res.status).toBe(403);
  });

  it('驗證失敗 → 400', async () => {
    const { verifyLLMKey } = jest.requireMock('@/lib/llm/verify-key') as {
      verifyLLMKey: jest.Mock;
    };
    verifyLLMKey.mockResolvedValueOnce(false);
    const res = await request(app)
      .put('/api/tenant/llm-config')
      .set('x-api-key', 'sk_default')
      .send({ openaiApiKey: 'sk-proj-bad-key-000000000000' });
    expect(res.status).toBe(400);
  });
});

describe('/api/admin/tenants/:id/llm-config 與 usage 成本', () => {
  it('admin 可代設與讀取', async () => {
    const created = await request(app)
      .post('/api/admin/tenants')
      .set('x-admin-key', 'test-admin-key')
      .send({ name: 'byo-admin-api' });
    const id = created.body.data.tenant.id as string;

    const put = await request(app)
      .put(`/api/admin/tenants/${id}/llm-config`)
      .set('x-admin-key', 'test-admin-key')
      .send({ provider: 'anthropic', anthropicApiKey: 'sk-ant-admin-set-000000000' });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get(`/api/admin/tenants/${id}/llm-config`)
      .set('x-admin-key', 'test-admin-key');
    expect(get.body.data.provider).toBe('anthropic');
  });

  it('getUsage 回應含 cost 結構', async () => {
    const res = await request(app)
      .get('/api/admin/tenants/default/usage')
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(200);
    expect(res.body.data.cost).toEqual(
      expect.objectContaining({ totalUsd: expect.any(Number), byModel: expect.any(Array) }),
    );
  });
});
```

> `POST /api/admin/tenants` 的回應形狀（`data.tenant.id` 或 `data.id`）以 `admin.controller.ts` 的 `createTenant` 實際回傳為準，寫測試前先確認並對齊。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w server -- tests/tenant-llm-config-api.test.ts`
Expected: FAIL（404：路由不存在）

- [ ] **Step 3: 自助 controller + routes**

Create `server/src/modules/tenant/tenant.self.controller.ts`：

```ts
/**
 * 租戶自助設定端點（Surface：對外整合方的工程師自己呼叫）。
 * 只認 sk_ 秘密金鑰：pk_ 會出現在瀏覽器端，絕不能拿來改設定或讀金鑰遮罩。
 */
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import type { PutLLMConfigInput } from './llm-config.schema';
import { llmConfigService } from './llm-config.service';

function requireSecretKeyTenant(req: Request): string {
  if (req.apiKeyType !== 'secret') {
    throw AppError.forbidden('此端點僅限 sk_ 秘密金鑰存取');
  }
  return req.tenant!.id;
}

export const tenantSelfController = {
  async getLlmConfig(req: Request, res: Response): Promise<void> {
    const tenantId = requireSecretKeyTenant(req);
    res.status(200).json({ data: llmConfigService.get(tenantId) });
  },

  async putLlmConfig(req: Request, res: Response): Promise<void> {
    const tenantId = requireSecretKeyTenant(req);
    const view = await llmConfigService.update(tenantId, req.body as PutLLMConfigInput, 'sk-api');
    res.status(200).json({ data: view });
  },
};
```

> `req.tenant` / `req.apiKeyType` 的型別擴充已存在（resolveTenant 在用）；若 `req.tenant` 型別為可選，比照專案內既有用法（`!` 或 guard）。

Create `server/src/modules/tenant/tenant.routes.ts`：

```ts
import { Router } from 'express';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { putLlmConfigSchema } from './llm-config.schema';
import { tenantSelfController } from './tenant.self.controller';

const router = Router();

router.get('/llm-config', asyncHandler(tenantSelfController.getLlmConfig));
router.put(
  '/llm-config',
  validate({ body: putLlmConfigSchema }),
  asyncHandler(tenantSelfController.putLlmConfig),
);

export const tenantSelfRouter = router;
```

- [ ] **Step 4: app.ts 掛載**

`server/src/app.ts`（widget 掛載行之後）：

```ts
import { tenantSelfRouter } from '@/modules/tenant/tenant.routes';
// …
  // 租戶自助設定：resolveTenant 解析 sk_（controller 內強制 secret）；無 requireAuth（整合方伺服器對伺服器）
  app.use('/api/tenant', resolveTenant, tenantRateLimit, tenantSelfRouter);
```

- [ ] **Step 5: admin 路由 + controller**

`admin.routes.ts`（usage 路由旁）：

```ts
import { putLlmConfigSchema } from '@/modules/tenant/llm-config.schema';
// …
router.get(
  '/tenants/:id/llm-config',
  validate({ params: tenantParamSchema }),
  asyncHandler(adminController.getLlmConfig),
);
router.put(
  '/tenants/:id/llm-config',
  validate({ params: tenantParamSchema, body: putLlmConfigSchema }),
  asyncHandler(adminController.putLlmConfig),
);
```

`admin.controller.ts`：

```ts
import { llmConfigService } from '@/modules/tenant/llm-config.service';
import type { PutLLMConfigInput } from '@/modules/tenant/llm-config.schema';
import { computeUsageCost } from '@/modules/usage/usage.cost';
// …
  async getLlmConfig(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: llmConfigService.get(tenant.id) });
  },

  async putLlmConfig(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const view = await llmConfigService.update(tenant.id, req.body as PutLLMConfigInput, 'admin');
    res.status(200).json({ data: view });
  },
```

`getUsage` 改為：

```ts
  async getUsage(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const usage = usageStore.get(tenant.id);
    res.status(200).json({ data: { ...usage, cost: computeUsageCost(usage) } });
  },
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npm run test -w server -- tests/tenant-llm-config-api.test.ts`
Expected: PASS（6 tests）

Run: `npm run typecheck && npm run test -w server`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/tenant/ server/src/modules/admin/ server/src/app.ts server/tests/tenant-llm-config-api.test.ts
git commit -m "feat(api): 租戶自助（sk_）與 admin 的 llm-config 端點；usage 回應含成本

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: admin UI（api client + SettingsTab AI 卡片 + UsageTab 成本）

**Files:**
- Modify: `admin/src/api.ts`
- Modify: `admin/src/pages/tabs/SettingsTab.tsx`
- Modify: `admin/src/pages/tabs/UsageTab.tsx`

**Interfaces:**
- Consumes: Task 9 的兩個 admin 端點與 usage 回應新形狀
- Produces: admin 後台可視化設定與成本呈現（無新 export 給他人）

- [ ] **Step 1: api.ts 型別與方法**

`Usage` interface 擴充 + 新型別（放 `Usage` 旁）：

```ts
export interface ModelTokenUsage {
  model: string;
  keySource: 'platform' | 'tenant';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface UsageCost {
  totalUsd: number;
  platformUsd: number;
  tenantUsd: number;
  byModel: Array<ModelTokenUsage & { usd: number | null }>;
}

export interface Usage {
  conversations: number;
  messages: number;
  submissions: number;
  llmTokens: number;
  embeddingTokens?: number;
  llmByModel?: Record<string, ModelTokenUsage>;
  cost?: UsageCost;
}

export interface LLMConfigView {
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  anthropicApiKey: string | null; // 遮罩字串
  openaiApiKey: string | null;
}

/** PUT patch：省略=不變、null=清除 */
export interface LLMConfigPatch {
  provider?: 'anthropic' | 'openai' | null;
  model?: string | null;
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
}
```

`api` 物件加（`getUsage` 旁）：

```ts
  getLlmConfig: (id: string) => req<LLMConfigView>('GET', `/admin/tenants/${id}/llm-config`),
  putLlmConfig: (id: string, patch: LLMConfigPatch) =>
    req<LLMConfigView>('PUT', `/admin/tenants/${id}/llm-config`, patch),
```

- [ ] **Step 2: SettingsTab 加「AI 模型（BYO key）」卡片**

在既有「租戶設定」卡片後加一個 `card`。實作要點（沿用檔內 `card` / `card-head` / `field` 等既有 class 與 useState 慣例）：

```tsx
// 新增 state
const [llmCfg, setLlmCfg] = useState<LLMConfigView | null>(null);
const [llmProvider, setLlmProvider] = useState<'' | 'anthropic' | 'openai'>('');
const [llmModel, setLlmModel] = useState('');
const [anthropicKey, setAnthropicKey] = useState('');
const [openaiKey, setOpenaiKey] = useState('');
const [llmBusy, setLlmBusy] = useState(false);

useEffect(() => {
  let cancelled = false;
  void api
    .getLlmConfig(tenant.id)
    .then((c) => {
      if (cancelled) return;
      setLlmCfg(c);
      setLlmProvider(c.provider ?? '');
      setLlmModel(c.model ?? '');
    })
    .catch(onError);
  return () => {
    cancelled = true;
  };
}, [tenant.id, onError]);

async function saveLlm() {
  setLlmBusy(true);
  try {
    const patch: LLMConfigPatch = {
      provider: llmProvider === '' ? null : llmProvider,
      model: llmModel.trim() === '' ? null : llmModel.trim(),
    };
    if (anthropicKey.trim()) patch.anthropicApiKey = anthropicKey.trim();
    if (openaiKey.trim()) patch.openaiApiKey = openaiKey.trim();
    const view = await api.putLlmConfig(tenant.id, patch);
    setLlmCfg(view);
    setAnthropicKey('');
    setOpenaiKey('');
    onSaved();
  } catch (e) {
    onError(e);
  } finally {
    setLlmBusy(false);
  }
}

async function clearKey(field: 'anthropicApiKey' | 'openaiApiKey') {
  try {
    const view = await api.putLlmConfig(tenant.id, { [field]: null });
    setLlmCfg(view);
  } catch (e) {
    onError(e);
  }
}
```

JSX 結構（class 名沿用檔內既有表單欄位寫法）：

- 標題「AI 模型（租戶自帶金鑰）」＋說明文字「未設定時使用平台預設模型與金鑰；設定後此租戶的 AI 費用計入自帶金鑰。」
- `select`：供應商 — 選項 `''`＝平台預設、`anthropic`＝Anthropic (Claude)、`openai`＝OpenAI
- `input`：模型（placeholder：`未填用供應商預設（如 gpt-4o-mini / claude-sonnet-4-5）`；僅在選了供應商時 enabled）
- 兩個 `input type="password"`：Anthropic 金鑰 / OpenAI 金鑰。placeholder 顯示現況：`llmCfg?.anthropicApiKey ?? '未設定'`。每個 input 旁若已設定（`llmCfg?.xxx` 非 null）顯示「清除」按鈕 → `clearKey('anthropicApiKey')`。
- 儲存按鈕（`disabled={llmBusy}`）→ `saveLlm()`。

- [ ] **Step 3: UsageTab 顯示成本明細**

在既有 stats 區塊後加（有 `usage.cost` 且 `byModel` 非空才 render）：

```tsx
{usage.cost && usage.cost.byModel.length > 0 && (
  <div className="card">
    <div className="card-head">
      <div>
        <div className="card-title">Token 用量與預估成本</div>
        <div className="card-desc">
          平台金鑰 ${usage.cost.platformUsd.toFixed(4)}（應收） ／ 自帶金鑰 $
          {usage.cost.tenantUsd.toFixed(4)}（參考） ／ 合計 ${usage.cost.totalUsd.toFixed(4)} USD
        </div>
      </div>
    </div>
    <table className="table">
      <thead>
        <tr>
          <th>模型</th>
          <th>金鑰</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache 讀</th>
          <th>預估成本</th>
        </tr>
      </thead>
      <tbody>
        {usage.cost.byModel.map((m) => (
          <tr key={`${m.keySource}|${m.model}`}>
            <td>{m.model}</td>
            <td>{m.keySource === 'tenant' ? '自帶' : '平台'}</td>
            <td>{m.inputTokens.toLocaleString()}</td>
            <td>{m.outputTokens.toLocaleString()}</td>
            <td>{m.cacheReadTokens.toLocaleString()}</td>
            <td>{m.usd === null ? '無單價資料' : `$${m.usd.toFixed(4)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
```

> `table` 的 class 名以 admin 專案既有表格寫法為準（先 grep `<table` 找一個現例，沿用其 class）；若無現例則用上述最簡結構＋既有 `card` 樣式。

- [ ] **Step 4: 驗證**

Run: `npm run typecheck && npm run build -w admin`
Expected: PASS

Run: `npm run test -w admin`
Expected: PASS（既有 tokenGauge 測試不受影響）

- [ ] **Step 5: Commit**

```bash
git add admin/src/
git commit -m "feat(admin): AI 模型 BYO key 設定卡片＋用量頁成本明細

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: 文件更新 + 全面驗證

**Files:**
- Modify: `README.md`（「可抽換層」一節）
- Modify: `INTEGRATION.md`（三種整合方式之後補自助 API 說明）

**Interfaces:** 無（純文件與回歸驗證）

- [ ] **Step 1: README「可抽換層」一節補一行**

在 LLM 條目下加：

```markdown
- 租戶 BYO key：每租戶可自帶 OpenAI / Anthropic API key 與 provider/model（`llmConfig`），
  未設定 fallback 平台 env 金鑰；用量按「模型 × key 來源」歸戶（`/api/admin/tenants/:id/usage` 含預估成本）。
  設定入口：sk_ 自助 `PUT /api/tenant/llm-config` 或 admin 後台「AI 模型」卡片。
```

- [ ] **Step 2: INTEGRATION.md 補自助端點說明**

在「三種整合方式」章節後補一小節：

```markdown
### 租戶自帶 AI 金鑰（BYO key）

整合方可用 **sk_ 秘密金鑰**（伺服器對伺服器）自行設定 AI 供應商與金鑰：

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/tenant/llm-config` | 讀取目前設定（金鑰遮罩，只露頭 7 尾 4） |
| PUT | `/api/tenant/llm-config` | 更新設定；省略欄位=不變、`null`=清除；新金鑰存前會打該廠商 `/v1/models` 驗證 |

Body 欄位：`provider`（`anthropic`/`openai`）、`model`、`anthropicApiKey`、`openaiApiKey`。
規則：`model` 需搭配 `provider`；設定 `provider` 後該租戶所有 AI 呼叫（含意圖路由）鎖定該供應商與模型；
金鑰失效時回 502 明確錯誤，**不會** fallback 平台金鑰。pk_ 公開金鑰一律 403。
```

- [ ] **Step 3: 全面回歸**

```bash
npm run typecheck
npm run test
npm run smoke
npm run build
```

Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add README.md INTEGRATION.md
git commit -m "docs: 租戶 BYO AI 金鑰與成本歸戶說明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec 覆蓋對照（自審用）

| Spec 決策 | Task |
|---|---|
| D1 sk\_ 自助 + admin 代設 | 9, 10 |
| D2 provider + key + model | 1, 8 |
| D3 embedding 用租戶 OpenAI key | 7 |
| D4 成本歸戶（模型×來源 + 單價表讀時計算） | 5, 9, 10 |
| D5 方案 A 工廠參數化 + client 快取 | 3, 6 |
| D6 失效歸因、不 fallback | 2, 3 |
| 存前驗證（models list） | 4, 8 |
| 遮罩（頭 7 尾 4）/ audit / pk\_ 403 | 8, 9 |
| 模型鎖定規則（租戶 provider → 全呼叫鎖模型） | 1, 3 |
| 向後相容（smoke / 預設租戶零改變） | 每 task 驗證步驟 + 11 |
