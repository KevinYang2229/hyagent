# 地端 LLM 支援 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓平台的 chat 與 embedding 都能在「雲端 API」與「地端 OpenAI 相容端點」之間切換，部署層以 env 決定預設、租戶可在後台覆寫，且選地端時絕不 fallback 回雲端。

**Architecture:** 「地端」= 第一級 provider `local`，底層重用既有的 OpenAI 相容 provider，只是把 `baseURL` 從 env（`LLM_BASE_URL` / `EMBEDDING_BASE_URL`）一路帶進 `ResolvedLLMSettings` 與 embedding client。地端 endpoint 是部署層基礎設施，租戶不可自填 URL（避免 SSRF）。Anthropic 路徑完全不動。

**Tech Stack:** TypeScript、Express、Zod（env 與租戶設定驗證）、OpenAI Node SDK（相容端點）、Jest + ts-jest。

## Global Constraints

- 選地端（provider=local）時**絕不跨 provider fallback 到雲端**；端點缺失一律報錯，不得靜默改打 `api.openai.com` / `api.anthropic.com`。
- 地端 endpoint 只來自部署層 env（`LLM_BASE_URL` / `EMBEDDING_BASE_URL`）；**租戶設定不得攜帶任意 URL**。
- 地端 chat 端點路徑格式為 OpenAI 相容根路徑（如 `http://vllm:8000/v1`）；verify-key 對 `${base}/models` 探測。
- `LLM_API_KEY` 預設 `'not-needed'`（**非空字串**，OpenAI SDK 不接受空 apiKey）。
- 既有雲端行為與所有既有測試必須維持綠燈（零回歸）。
- Provider 值一律小寫字面量：`'anthropic' | 'openai' | 'local'`。
- 每個 task 結束都要跑 `npm run typecheck -w server`（或對應 workspace）確保型別無回歸。

---

### Task 1: env 新增 local provider 與地端端點變數 + fail-fast

**Files:**
- Modify: `server/src/config/env.ts`
- Test: `server/tests/env-local-llm.test.ts`（Create）

**Interfaces:**
- Produces: `env.LLM_PROVIDER: 'anthropic' | 'openai' | 'local'`、`env.LLM_BASE_URL?: string`、`env.LLM_API_KEY: string`、`env.EMBEDDING_PROVIDER: 'openai' | 'local'`、`env.EMBEDDING_BASE_URL?: string`；並 `export const envSchema`（供測試 safeParse）。

- [ ] **Step 1: 先寫失敗測試**

Create `server/tests/env-local-llm.test.ts`：

```ts
import { envSchema } from '@/config/env';

// setup-env 已備妥 ANTHROPIC_API_KEY 等；此處直接對 schema safeParse 各種組合
describe('env 地端 LLM 驗證', () => {
  it('LLM_PROVIDER=local 缺 LLM_BASE_URL → 失敗', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local' });
    expect(r.success).toBe(false);
  });

  it('LLM_PROVIDER=local + LLM_BASE_URL → 成功，且不需雲端 key', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local', LLM_BASE_URL: 'http://vllm:8000/v1' });
    expect(r.success).toBe(true);
  });

  it('LLM_API_KEY 未給 → 預設 not-needed（非空）', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local', LLM_BASE_URL: 'http://vllm:8000/v1' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.LLM_API_KEY).toBe('not-needed');
  });

  it('EMBEDDING_PROVIDER=local 缺 EMBEDDING_BASE_URL → 失敗', () => {
    const r = envSchema.safeParse({
      LLM_PROVIDER: 'local',
      LLM_BASE_URL: 'http://vllm:8000/v1',
      EMBEDDING_PROVIDER: 'local',
    });
    expect(r.success).toBe(false);
  });

  it('EMBEDDING_PROVIDER=local + EMBEDDING_BASE_URL → 成功', () => {
    const r = envSchema.safeParse({
      LLM_PROVIDER: 'local',
      LLM_BASE_URL: 'http://vllm:8000/v1',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_BASE_URL: 'http://vllm:8000/v1',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w server -- env-local-llm`
Expected: FAIL — `envSchema` 尚未 export（或 local 不是合法 enum 值）。

- [ ] **Step 3: 改 env.ts**

在 `server/src/config/env.ts`：

3a. `LLM_PROVIDER` enum 加 `'local'`（第 66 行）：

```ts
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'local']).default('anthropic'),
```

3b. 在 `OPENAI_API_KEY` 那行（第 72 行）後補地端 chat 變數：

```ts
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  // ---- 地端 LLM（provider=local；OpenAI 相容端點，如 vLLM / Ollama）----
  // 地端 chat 端點根路徑（含 /v1）；LLM_PROVIDER=local 時必填（見 superRefine）
  LLM_BASE_URL: z.string().optional(),
  // 地端端點通常不驗 key；OpenAI SDK 不接受空 apiKey，故給非空 dummy
  LLM_API_KEY: z.string().default('not-needed'),
```

3c. 在 `EMBEDDING_MODEL` 那行（第 77 行）前補地端 embedding 變數：

```ts
  // embedding 供應商：openai=雲端；local=地端 OpenAI 相容 /v1/embeddings
  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
  // 地端 embedding 端點根路徑（含 /v1）；EMBEDDING_PROVIDER=local 時必填
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
```

3d. superRefine 內，`OA_BASE_URL` 檢查（第 107-113 行）後補兩段 fail-fast：

```ts
  // LLM_PROVIDER=local 時必須提供 LLM_BASE_URL，boot 時 fail-fast
  if (val.LLM_PROVIDER === 'local' && !val.LLM_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_BASE_URL'],
      message: 'LLM_BASE_URL is required when LLM_PROVIDER=local',
    });
  }
  // EMBEDDING_PROVIDER=local 時必須提供 EMBEDDING_BASE_URL，boot 時 fail-fast
  if (val.EMBEDDING_PROVIDER === 'local' && !val.EMBEDDING_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMBEDDING_BASE_URL'],
      message: 'EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=local',
    });
  }
```

3e. 把 schema 宣告改成 export（第 9 行）：

```ts
export const envSchema = z.object({
```

（結尾 `.superRefine(...)` 與 `const parsed = envSchema.safeParse(process.env)` 不變。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w server -- env-local-llm`
Expected: PASS（5 案例全綠）。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck -w server`
Expected: 無錯誤。

```bash
git add server/src/config/env.ts server/tests/env-local-llm.test.ts
git commit -m "feat(env): 新增 local LLM provider 與地端 chat/embedding 端點變數（含 fail-fast）"
```

---

### Task 2: resolve-settings 支援 local（baseURL 帶入、無雲端 fallback）

**Files:**
- Modify: `server/src/lib/llm/resolve-settings.ts`
- Modify: `server/src/lib/llm/types.ts:71-75`（`TenantLLMConfig.provider` union 加 `'local'`）
- Modify: `server/tests/setup-env.ts`（補地端測試環境變數）
- Test: `server/tests/llm-resolve-settings.test.ts`（既有檔，追加案例）

**Interfaces:**
- Consumes: `env.LLM_BASE_URL`、`env.LLM_API_KEY`、`env.LLM_MODEL`（Task 1）。
- Produces: `LLMProviderName = 'anthropic' | 'openai' | 'local'`；`ResolvedLLMSettings` 新增 `baseURL?: string`；`resolveLLMSettings(config?)` 對 `provider==='local'` 回傳 `{ provider:'local', apiKey: env.LLM_API_KEY, keySource:'platform', baseURL: env.LLM_BASE_URL, model: config?.model ?? env.LLM_MODEL, lockModel: Boolean(config?.provider) }`，且 `local` 且無 `LLM_BASE_URL` 時 throw。

- [ ] **Step 1: 補測試環境變數**

在 `server/tests/setup-env.ts` 末尾（第 25 行後）加：

```ts
// 地端 LLM 測試：resolve/embedding 的 local 路徑需要端點；僅在 provider=local 時生效，
// 不影響預設 anthropic 的雲端測試
process.env.LLM_BASE_URL ??= 'http://localhost:8000/v1';
```

- [ ] **Step 2: 寫失敗測試**

在 `server/tests/llm-resolve-settings.test.ts` 的 `describe('resolveLLMSettings fallback 矩陣', ...)` 內追加：

```ts
  it('provider=local → 帶入 baseURL、apiKey=LLM_API_KEY、platform、鎖模型', () => {
    const s = resolveLLMSettings({ provider: 'local' });
    expect(s.provider).toBe('local');
    expect(s.baseURL).toBe(process.env.LLM_BASE_URL);
    expect(s.apiKey).toBe('not-needed');
    expect(s.keySource).toBe('platform');
    expect(s.model).toBe('claude-sonnet-4-5'); // 未指定 → 用 env.LLM_MODEL
    expect(s.lockModel).toBe(true);
  });

  it('provider=local + 指定 model → 用租戶 model', () => {
    const s = resolveLLMSettings({ provider: 'local', model: 'Qwen2.5-32B-Instruct' });
    expect(s.model).toBe('Qwen2.5-32B-Instruct');
  });

  it('provider=local 帶了雲端 key 也不會走雲端（keySource 恆 platform、baseURL 仍是地端）', () => {
    const s = resolveLLMSettings({ provider: 'local', anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.provider).toBe('local');
    expect(s.keySource).toBe('platform');
    expect(s.baseURL).toBe(process.env.LLM_BASE_URL);
  });
```

並在檔案末尾新增一個 describe（測「無端點不 fallback」）：

```ts
describe('resolveLLMSettings 地端安全性', () => {
  afterEach(() => {
    process.env.LLM_BASE_URL = 'http://localhost:8000/v1';
    jest.resetModules();
  });

  it('provider=local 但平台未設 LLM_BASE_URL → 丟錯，絕不改走雲端', () => {
    jest.resetModules();
    delete process.env.LLM_BASE_URL;
    const { resolveLLMSettings: reResolve } = require('@/lib/llm/resolve-settings') as typeof import('@/lib/llm/resolve-settings');
    expect(() => reResolve({ provider: 'local' })).toThrow();
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm test -w server -- llm-resolve-settings`
Expected: FAIL — `provider: 'local'` 型別不符 / `baseURL` 未定義 / 未丟錯。

- [ ] **Step 4: 改 types.ts**

`server/src/lib/llm/types.ts` 的 `TenantLLMConfig`（第 71 行）：

```ts
export interface TenantLLMConfig {
  provider?: 'anthropic' | 'openai' | 'local';
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}
```

- [ ] **Step 5: 改 resolve-settings.ts**

整檔改為（完整覆寫）：

```ts
/**
 * 租戶 llmConfig → 實際 LLM 連線設定的解析（spec D5 方案 A 的核心規則）。
 *
 * - provider=local：走部署層地端 endpoint（LLM_BASE_URL），不涉租戶 key，
 *   絕不 fallback 雲端；端點缺失即丟錯。
 * - 未設 provider：平台 provider/model 照舊；若租戶放了「同廠商」的 key，只換帳單歸屬。
 * - 有設雲端 provider：全套用租戶設定，並鎖定模型（router/rerank 覆寫一律忽略）。
 */
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';
import type { LLMKeySource, TenantLLMConfig } from './types';

export type LLMProviderName = 'anthropic' | 'openai' | 'local';

/** 雲端 provider 未指定 model 時的內建預設（local 無通用預設名，改走 env.LLM_MODEL） */
const DEFAULT_MODELS: Record<'anthropic' | 'openai', string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
};

export interface ResolvedLLMSettings {
  provider: LLMProviderName;
  apiKey: string;
  keySource: LLMKeySource;
  model: string;
  /** 地端 OpenAI 相容端點；雲端為 undefined（用 SDK 內建位址） */
  baseURL?: string;
  /** true = 每呼叫的 model 覆寫一律忽略（租戶自訂 provider 時） */
  lockModel: boolean;
}

function envKeyFor(provider: 'anthropic' | 'openai'): string {
  return provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
}

function tenantKeyFor(
  provider: 'anthropic' | 'openai',
  config?: TenantLLMConfig,
): string | undefined {
  const key = provider === 'anthropic' ? config?.anthropicApiKey : config?.openaiApiKey;
  return key && key.trim() ? key : undefined;
}

export function resolveLLMSettings(config?: TenantLLMConfig): ResolvedLLMSettings {
  const provider = config?.provider ?? env.LLM_PROVIDER;

  // 地端：部署層 endpoint，不涉租戶 key；缺 endpoint 即丟錯（絕不靜默走雲端）
  if (provider === 'local') {
    if (!env.LLM_BASE_URL) {
      throw AppError.badRequest('平台未設定地端模型端點（LLM_BASE_URL），無法使用地端模型');
    }
    return {
      provider: 'local',
      apiKey: env.LLM_API_KEY,
      keySource: 'platform',
      baseURL: env.LLM_BASE_URL,
      model: config?.model ?? env.LLM_MODEL,
      lockModel: Boolean(config?.provider),
    };
  }

  // 以下 provider 收斂為 anthropic | openai
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

> 註：`envKeyFor` / `tenantKeyFor` 的參數型別收窄為 `'anthropic' | 'openai'`——因為 local 在上方已提前 return，TS 會把 `provider` 在此後收斂為兩者之一。若 typecheck 抱怨 `env.LLM_PROVIDER`（型別含 local）指派到收窄參數，於呼叫處已被 `provider==='local'` 的 early-return 排除，無需 cast。

- [ ] **Step 6: 跑測試確認通過**

Run: `npm test -w server -- llm-resolve-settings`
Expected: PASS（含既有 fallback 矩陣與 pickModel 全綠 + 新增地端案例）。

- [ ] **Step 7: typecheck + commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/lib/llm/resolve-settings.ts server/src/lib/llm/types.ts server/tests/setup-env.ts server/tests/llm-resolve-settings.test.ts
git commit -m "feat(llm): resolveLLMSettings 支援 local provider（baseURL 帶入、無雲端 fallback）"
```

---

### Task 3: OpenAI provider 依 baseURL 建 client（local 重用此 provider）

**Files:**
- Modify: `server/src/lib/llm/openai.provider.ts:24-33,110`
- Modify: `server/src/lib/llm/index.ts`（工廠註解，說明 local 走 openai 實作）
- Test: `server/tests/openai-provider-baseurl.test.ts`（Create）

**Interfaces:**
- Consumes: `ResolvedLLMSettings.baseURL`（Task 2）、`getLLMProvider`（`index.ts`）。
- Produces: `createOpenAIProvider` 建構的 OpenAI client 帶 `baseURL`；client 快取鍵為 `apiKey|baseURL`。

- [ ] **Step 1: 寫失敗測試**

Create `server/tests/openai-provider-baseurl.test.ts`：

```ts
// 攔截 OpenAI 建構參數，驗證 provider=local 時帶 baseURL
const ctorArgs: Array<{ apiKey: string; baseURL?: string }> = [];
const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: { apiKey: string; baseURL?: string }) => {
    ctorArgs.push(opts);
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { getLLMProvider } from '@/lib/llm';

describe('OpenAI provider baseURL', () => {
  it('provider=local → 以 env.LLM_BASE_URL 建構 client', async () => {
    const provider = getLLMProvider({ provider: 'local' });
    await provider.createMessage({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(ctorArgs.some((a) => a.baseURL === process.env.LLM_BASE_URL)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w server -- openai-provider-baseurl`
Expected: FAIL — 建構參數不含 `baseURL`（現行 `new OpenAI({ apiKey })`）。

- [ ] **Step 3: 改 openai.provider.ts**

3a. `getClient`（第 24-33 行）改為以 `apiKey|baseURL` 為鍵並帶 baseURL：

```ts
// SDK client 以 apiKey|baseURL 快取：同 key+端點重用連線，不每請求重建
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string, baseURL?: string): OpenAI {
  const cacheKey = `${apiKey}|${baseURL ?? ''}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL });
    clients.set(cacheKey, c);
  }
  return c;
}
```

3b. `createMessage` 內呼叫處（第 110 行）帶入 baseURL：

```ts
        resp = await getClient(settings.apiKey, settings.baseURL).chat.completions.create({
```

- [ ] **Step 4: 改 index.ts 工廠註解**

`server/src/lib/llm/index.ts` 的 `getLLMProvider`（第 10-15 行）補註解（邏輯不變，local 落 else 分支）：

```ts
export function getLLMProvider(config?: TenantLLMConfig): LLMProvider {
  const settings = resolveLLMSettings(config);
  // local 為 OpenAI 相容端點，重用 openai provider（差別僅在 settings.baseURL）
  return settings.provider === 'anthropic'
    ? createAnthropicProvider(settings)
    : createOpenAIProvider(settings);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test -w server -- openai-provider-baseurl`
Expected: PASS。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/lib/llm/openai.provider.ts server/src/lib/llm/index.ts server/tests/openai-provider-baseurl.test.ts
git commit -m "feat(llm): OpenAI provider 依 baseURL 建 client，local 重用此實作"
```

---

### Task 4: embedding 支援地端端點

**Files:**
- Modify: `server/src/lib/embedding/index.ts:26-61`
- Test: `server/tests/embedding-local.test.ts`（Create）

**Interfaces:**
- Consumes: `env.EMBEDDING_PROVIDER`、`env.EMBEDDING_BASE_URL`、`env.LLM_API_KEY`（Task 1）。
- Produces: `getEmbeddingProvider(config?)` 在 `env.EMBEDDING_PROVIDER==='local'` 時回傳走 `env.EMBEDDING_BASE_URL`、`keySource='platform'` 的 provider（忽略租戶 openaiApiKey）；否則維持現行。

- [ ] **Step 1: 寫失敗測試**

Create `server/tests/embedding-local.test.ts`：

```ts
// 用 resetModules + require 讓 env 以本測試設定的 EMBEDDING_PROVIDER 重新解析
const ctorArgs: Array<{ apiKey: string; baseURL?: string }> = [];
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: { apiKey: string; baseURL?: string }) => {
    ctorArgs.push(opts);
    return { embeddings: { create: mockCreate } };
  }),
}));

describe('embedding 地端', () => {
  afterEach(() => {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_BASE_URL;
    jest.resetModules();
    ctorArgs.length = 0;
  });

  it('EMBEDDING_PROVIDER=local → keySource platform，忽略租戶 openaiApiKey', () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'local';
    process.env.EMBEDDING_BASE_URL = 'http://localhost:8000/v1';
    const { getEmbeddingProvider } = require('@/lib/embedding') as typeof import('@/lib/embedding');
    const p = getEmbeddingProvider({ openaiApiKey: 'sk-tenant-key' });
    expect(p.keySource).toBe('platform');
  });

  it('EMBEDDING_PROVIDER=local → 建構帶 EMBEDDING_BASE_URL', async () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'local';
    process.env.EMBEDDING_BASE_URL = 'http://localhost:8000/v1';
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3] }], usage: { total_tokens: 3 } });
    const { getEmbeddingProvider } = require('@/lib/embedding') as typeof import('@/lib/embedding');
    await getEmbeddingProvider().embed(['hi']);
    expect(ctorArgs.some((a) => a.baseURL === 'http://localhost:8000/v1')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w server -- embedding-local`
Expected: FAIL — local 分支不存在（keySource 仍依租戶 key、建構無 baseURL）。

- [ ] **Step 3: 改 embedding/index.ts**

3a. `getClient`（第 27-35 行）加 baseURL：

```ts
// SDK client 以 apiKey|baseURL 快取（同 lib/llm 手法）；延遲建立避免無 key 時啟動失敗
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string, baseURL?: string): OpenAI {
  const cacheKey = `${apiKey}|${baseURL ?? ''}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL });
    clients.set(cacheKey, c);
  }
  return c;
}
```

3b. `createProvider`（第 37 行）加 baseURL 參數並傳入 getClient：

```ts
function createProvider(apiKey: string, keySource: LLMKeySource, baseURL?: string): EmbeddingProvider {
  return {
    model: env.EMBEDDING_MODEL,
    keySource,
    async embed(texts: string[], model?: string): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      let resp: OpenAI.Embeddings.CreateEmbeddingResponse;
      try {
        resp = await getClient(apiKey, baseURL).embeddings.create({
          model: model ?? env.EMBEDDING_MODEL,
          input: texts,
        });
      } catch (err) {
        // 租戶 key 失效比照 D6 明確歸因 502；平台 key 原樣拋出（現行行為）
        throw mapProviderError(err, { keySource });
      }
      return { vectors: resp.data.map((d) => d.embedding), tokens: resp.usage?.total_tokens ?? 0 };
    },
  };
}
```

3c. `getEmbeddingProvider`（第 58-61 行）加 local 分支：

```ts
export function getEmbeddingProvider(config?: TenantLLMConfig): EmbeddingProvider {
  // 地端：走部署層 embedding 端點，不涉租戶 key
  if (env.EMBEDDING_PROVIDER === 'local') {
    return createProvider(env.LLM_API_KEY, 'platform', env.EMBEDDING_BASE_URL);
  }
  const tenantKey = config?.openaiApiKey?.trim();
  return tenantKey
    ? createProvider(tenantKey, 'tenant')
    : createProvider(env.OPENAI_API_KEY, 'platform');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w server -- embedding-local`
Expected: PASS。並跑既有 embedding 測試確認未回歸：
Run: `npm test -w server -- embedding-provider`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/lib/embedding/index.ts server/tests/embedding-local.test.ts
git commit -m "feat(embedding): 支援地端 OpenAI 相容 /v1/embeddings 端點"
```

---

### Task 5: verify-key 對 local 做端點可達性探測

**Files:**
- Modify: `server/src/lib/llm/verify-key.ts`
- Test: `server/tests/llm-verify-key-local.test.ts`（Create）

**Interfaces:**
- Consumes: `env.LLM_BASE_URL`。
- Produces: `verifyLLMKey('local', apiKey)` → 對 `${env.LLM_BASE_URL}/models` GET，2xx 回 `true`，逾時/連線失敗/無端點回 `false`（不丟 502）。

- [ ] **Step 1: 寫失敗測試**

Create `server/tests/llm-verify-key-local.test.ts`：

```ts
import { verifyLLMKey } from '@/lib/llm/verify-key';

describe('verifyLLMKey local 可達性', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('地端 /models 回 2xx → true', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    await expect(verifyLLMKey('local', 'not-needed')).resolves.toBe(true);
  });

  it('地端連線失敗 → false（不丟例外）', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(verifyLLMKey('local', 'not-needed')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w server -- llm-verify-key-local`
Expected: FAIL — local 分支不存在（走到雲端 else 分支，打 api.openai.com）。

- [ ] **Step 3: 改 verify-key.ts**

3a. 檔案頂部補 env import（第 10 行 `import type { LLMProviderName }` 前）：

```ts
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';
import type { LLMProviderName } from './resolve-settings';
```

3b. `verifyLLMKey` 函式開頭（第 14 行 `export async function` 內、`const { url, headers } =` 之前）插入 local 分支：

```ts
export async function verifyLLMKey(provider: LLMProviderName, apiKey: string): Promise<boolean> {
  // 地端：無雲端金鑰可驗，改做端點可達性探測（GET /models）
  if (provider === 'local') {
    if (!env.LLM_BASE_URL) return false;
    try {
      const res = await fetch(`${env.LLM_BASE_URL}/models`, {
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  const { url, headers } =
    provider === 'anthropic'
      ? {
```

（其餘雲端邏輯不變。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w server -- llm-verify-key-local`
Expected: PASS。既有雲端 verify 測試不受影響：
Run: `npm test -w server -- llm-verify-key`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/lib/llm/verify-key.ts server/tests/llm-verify-key-local.test.ts
git commit -m "feat(llm): verify-key 對 local 改做端點可達性探測"
```

---

### Task 6: 租戶設定接受 local（跳過雲端 key 檢查、守住無端點）

**Files:**
- Modify: `server/src/modules/tenant/llm-config.schema.ts:6`
- Modify: `server/src/modules/tenant/llm-config.service.ts:14,70-76`
- Test: `server/tests/tenant-llm-config.test.ts`（既有檔，追加案例）

**Interfaces:**
- Consumes: `env.LLM_BASE_URL`、`putLlmConfigSchema`、`llmConfigService.update`。
- Produces: 租戶 `provider` 可為 `'local'`；選 local 時不要求雲端 key；若 `env.LLM_BASE_URL` 未設則 `update` 丟 `AppError.badRequest`。

- [ ] **Step 1: 寫失敗測試**

先確認既有 `server/tests/tenant-llm-config.test.ts` 建立/取得租戶的既有寫法，於其 describe 內追加（沿用該檔既有的 tenantId 建立 helper／模式；下方以 `llmConfigService` 直呼為例，實際 import 與租戶建立步驟比照該檔現有案例）：

```ts
  it('provider=local → 不需雲端 key 即可設定（走部署層地端端點）', async () => {
    const view = await llmConfigService.update(tenantId, { provider: 'local' }, 'tester');
    expect(view.provider).toBe('local');
    // local 不設任何雲端 key
    expect(view.anthropicApiKey).toBeNull();
    expect(view.openaiApiKey).toBeNull();
  });
```

> 註：本檔測試環境 `env.LLM_BASE_URL` 已由 setup-env（Task 2）設好，故 local 可被接受。「未設端點 → 擋下」的守門已在 Task 2 的 resolve-settings 單元測試以 resetModules 覆蓋，此處不重複。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w server -- tenant-llm-config`
Expected: FAIL — schema `provider` enum 不含 local（zod 驗證擋下）。

- [ ] **Step 3: 改 schema**

`server/src/modules/tenant/llm-config.schema.ts` 第 6 行：

```ts
    provider: z.enum(['anthropic', 'openai', 'local']).nullable().optional(),
```

- [ ] **Step 4: 改 service**

4a. `LLMConfigView.provider` 型別（第 14 行）：

```ts
export interface LLMConfigView {
  provider: 'anthropic' | 'openai' | 'local' | null;
  model: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
}
```

4b. key-availability 檢查（第 70-76 行）改為：雲端 provider 才檢查 key；local 改檢查部署層端點：

```ts
    // 雲端 provider 指定後，該廠商必須有可用金鑰（租戶自帶或平台 env），否則 runtime 必炸
    if (merged.provider && merged.provider !== 'local') {
      const tenantKey = merged.provider === 'anthropic' ? merged.anthropicApiKey : merged.openaiApiKey;
      const envKey = merged.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (!tenantKey && !envKey) {
        throw AppError.badRequest(`供應商 ${merged.provider} 沒有可用金鑰，請一併提供 key`);
      }
    }
    // 地端 provider：需部署層已設 endpoint，否則 runtime 會誤打雲端（違反不外流原則）
    if (merged.provider === 'local' && !env.LLM_BASE_URL) {
      throw AppError.badRequest('平台未設定地端模型端點，無法選用地端模型');
    }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test -w server -- tenant-llm-config`
Expected: PASS（既有雲端案例 + 新增 local 案例）。同時跑 API 層測試確認未回歸：
Run: `npm test -w server -- tenant-llm-config-api`
Expected: PASS。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/modules/tenant/llm-config.schema.ts server/src/modules/tenant/llm-config.service.ts server/tests/tenant-llm-config.test.ts
git commit -m "feat(tenant): AI 模型設定支援 local（免雲端 key、守住無端點）"
```

---

### Task 7: admin 前端「AI 模型」卡片新增「地端」選項

**Files:**
- Modify: `admin/src/api.ts:81,89`
- Modify: `admin/src/pages/tabs/SettingsTab.tsx:21,160-165,174`

**Interfaces:**
- Consumes: 後端 `provider` 已接受 `'local'`（Task 6）。
- Produces: admin 供應商下拉多一個「地端（自架模型）」；選地端時金鑰欄位隱藏（地端不需 key），模型欄可填地端模型名。

- [ ] **Step 1: 改 api.ts 型別**

`admin/src/api.ts` 第 81 與 89 行，兩處 `provider` union 加 `'local'`：

```ts
export interface LLMConfigView {
  provider: 'anthropic' | 'openai' | 'local' | null;
  model: string | null;
  anthropicApiKey: string | null; // 遮罩字串
  openaiApiKey: string | null;
}

/** PUT patch：省略=不變、null=清除 */
export interface LLMConfigPatch {
  provider?: 'anthropic' | 'openai' | 'local' | null;
  model?: string | null;
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
}
```

- [ ] **Step 2: 改 SettingsTab.tsx state 型別**

第 21 行：

```ts
  const [llmProvider, setLlmProvider] = useState<'' | 'anthropic' | 'openai' | 'local'>('');
```

- [ ] **Step 3: 改下拉 onChange 型別與選項**

第 160 行 onChange 的 cast、第 162-165 行選項清單：

```tsx
              onChange={(e) => setLlmProvider(e.target.value as '' | 'anthropic' | 'openai' | 'local')}
            >
              <option value="">平台預設</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="local">地端（自架模型）</option>
            </select>
```

- [ ] **Step 4: 地端時隱藏金鑰欄位**

第 179 行起的兩個金鑰 `<div className="field">…Anthropic 金鑰…</div>` 與 `…OpenAI 金鑰…</div>`，各自外層條件包成 `{llmProvider !== 'local' && ( … )}`。並把「模型」欄位 placeholder（第 175 行）補地端範例：

```tsx
              placeholder="未填用供應商預設（如 gpt-4o-mini / claude-sonnet-4-5 / Qwen2.5-32B-Instruct）"
```

（模型欄的 `disabled={llmProvider === ''}` 維持不變：地端可填模型名。）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck -w admin`
Expected: 無錯誤。

- [ ] **Step 6: 手動驗證 + commit**

啟動 admin dev（`npm run dev:admin`），開租戶設定，確認供應商下拉出現「地端（自架模型）」、選它後金鑰欄消失、可存檔。

```bash
git add admin/src/api.ts admin/src/pages/tabs/SettingsTab.tsx
git commit -m "feat(admin): AI 模型卡片新增地端選項，選地端隱藏金鑰欄"
```

---

### Task 8: 文件（.env.example + README）

**Files:**
- Modify: `server/.env.example`
- Modify: `README.md`（「可抽換層」段）

**Interfaces:** 無程式介面；交付物為可據以部署地端的文件。

- [ ] **Step 1: 更新 .env.example**

在 `server/.env.example` 的 LLM 區塊，`OPENAI_API_KEY=` 行後補地端說明；並在 provider 註解加入 local：

```bash
# ---- LLM provider（支援 anthropic / openai / local；預設 anthropic）----
# local：接地端自架的 OpenAI 相容端點（vLLM / Ollama / TGI），資料不出機房
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5
LLM_ROUTER_MODEL=claude-haiku-4-5-20251001
LLM_MAX_TOKENS=1024
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# ---- 地端 LLM（LLM_PROVIDER=local 時生效）----
# 地端 chat 端點根路徑（含 /v1）；設 local 時必填，否則 boot fail-fast
# LLM_BASE_URL=http://vllm:8000/v1
# 地端通常不驗 key；留預設即可（OpenAI SDK 不接受空字串）
LLM_API_KEY=not-needed
# 地端範例：LLM_PROVIDER=local / LLM_MODEL=Qwen2.5-32B-Instruct / LLM_BASE_URL=http://vllm:8000/v1

# ---- Embedding 供應商（openai=雲端；local=地端 /v1/embeddings）----
EMBEDDING_PROVIDER=openai
# EMBEDDING_PROVIDER=local 時必填；換模型後各租戶索引需以同模型重跑 ingest
# EMBEDDING_BASE_URL=http://vllm:8000/v1
```

（若 `.env.example` 既有 `EMBEDDING_MODEL` 行，保留；上方 `EMBEDDING_PROVIDER` / `EMBEDDING_BASE_URL` 置於其前。）

- [ ] **Step 2: 更新 README「可抽換層」**

在 `README.md` 的「可抽換層」LLM 條目後補一行：

```markdown
- 地端模型：`LLM_PROVIDER=local` + `LLM_BASE_URL` 指向自架 OpenAI 相容端點（vLLM / Ollama），資料不出機房；embedding 另以 `EMBEDDING_PROVIDER=local` + `EMBEDDING_BASE_URL` 地端化。選地端時絕不 fallback 回雲端。租戶亦可於後台「AI 模型」選「地端」（沿用部署層端點，租戶不自帶 URL）。
```

- [ ] **Step 3: commit**

```bash
git add server/.env.example README.md
git commit -m "docs: 地端 LLM 部署設定（.env.example + README）"
```

---

### Task 9: 全套回歸驗證

**Files:** 無（驗證步驟）。

- [ ] **Step 1: 全測試**

Run: `npm test -w server`
Expected: 全綠（既有 + 新增地端測試）。

- [ ] **Step 2: 全 workspace typecheck**

Run: `npm run typecheck`
Expected: server / client / admin 皆無錯誤。

- [ ] **Step 3: 離線 smoke（不需 key，確認 schema 引擎未受影響）**

Run: `npm run smoke -w server`
Expected: 通過。

- [ ] **Step 4: 最終 commit（若有殘留）**

```bash
git status
# 若有未提交變更再視情況 commit
```

---

## Self-Review

**Spec coverage：**
- env（local + 端點 + fail-fast）→ Task 1 ✅
- 解析層（LLMProviderName + baseURL + local 解析 + 無 fallback）→ Task 2 ✅
- chat provider（getClient baseURL）→ Task 3 ✅
- embedding 地端 → Task 4 ✅
- verify-key local → Task 5 ✅
- 租戶設定 + admin/自助（schema/service enum、免 key、守端點）→ Task 6（後端，含自助路由，因共用 service/schema）+ Task 7（admin UI）✅
- 安全性：租戶不自帶 URL（沿用 env）→ Task 2/6 設計落實 ✅
- 文件 → Task 8 ✅
- 測試清單（resolve local、無 fallback、env fail-fast、embedding local、getClient baseURL）→ Task 1/2/3/4 ✅

**Placeholder scan：** 無 TBD/TODO；每個 code step 均含實際程式碼與指令。Task 6 Step 1 明確標注「沿用該檔既有租戶建立 helper」——因該檔既有模式需執行時對照，非佔位。

**Type consistency：** `provider` union 三處一致（`LLMProviderName` @ resolve-settings、`TenantLLMConfig.provider` @ types.ts、`LLMConfigView.provider` @ service、admin `api.ts`）皆為 `'anthropic' | 'openai' | 'local'`。`getClient(apiKey, baseURL?)` 簽名在 openai.provider 與 embedding 一致。`ResolvedLLMSettings.baseURL?` 於 Task 2 定義、Task 3 消費，名稱一致。
