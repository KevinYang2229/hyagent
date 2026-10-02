# 後端 MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓後端的智慧代理（agent）透過既有 Tool Registry 呼叫自建 MCP server 的工具；讀取直接執行，寫入一律經使用者在確認卡片上確認後才由後端執行。

**Architecture:** Tool Registry 新增「動態工具來源」介面，MCP 模組實作一個來源：依租戶歸屬與 `mcp:<serverId>` scope 把 MCP 工具轉成 `ToolDef`。寫入工具在 agent 的 `dispatchTool` 只建立 `session.pendingAction`，由新的確認端點（不經 LLM）重檢權限後執行；email 改走同一套機制。後端以每請求簽發的 ES256 JWT 向 MCP server 證明呼叫者身分，`mcp/kit` 提供 MCP 端驗證。

**Tech Stack:** Node 20+／TypeScript、Express 4、`@modelcontextprotocol/sdk` 1.31（Streamable HTTP）、Ajv 8、jest + ts-jest（server）、vitest + Testing Library（client / admin / kit）、Prisma（db 模式）。

**Spec:** [docs/superpowers/specs/2026-10-03-mcp-client-design.md](../specs/2026-10-03-mcp-client-design.md)

## Global Constraints

- `serverId` 格式：`/^[a-z0-9-]{1,32}$/`（不可含 `_` 或 `.`）。
- scope：`mcp:<serverId>`；工具 id：`mcp.<serverId>.<toolName>`；給 LLM 的名稱：`mcp_<serverId>_<toolName>`，必須符合 `/^[a-zA-Z0-9_-]{1,64}$/`，不符則不暴露。
- 讀寫判定：覆寫 `requireConfirm: true` → write；`annotations.readOnlyHint === true` → read；其餘（含未標註）→ write。`ToolDef.effect` 未標視為 write。
- 待確認動作效期 10 分鐘；同一 session 同時只存一筆；新提議、非確認的下一輪、過期皆使舊筆失效。
- 呼叫 JWT：ES256、`iss: "hyagent"`、`aud: <serverId>`、`sub: <userId>`（系統呼叫為 `hyagent-system`）、`tenant`、`scopes`（僅 `mcp:<serverId>` 及其子 scope）、效期 60 秒、`jti` 隨機。
- 私鑰環境變數 `MCP_SIGNING_KEY`（PKCS#8 PEM，可用 `\n` 跳脫）；未設則 MCP 功能整體停用，不得退回無簽章模式。
- JWKS 端點：`GET /.well-known/hyagent-mcp-jwks.json`。
- 逾時：`callTool` 預設 20000 ms（每 server 可調）、`listTools` 10000 ms；工具清單快取 10 分鐘；退避重連上限 5 分鐘；工具結果超過 16000 字元截斷並註明。
- 確認端點：`POST /api/conversations/:id/actions/:actionId/confirm`、`.../cancel`；過期或 id 不符回 409（`ACTION_EXPIRED` / `ACTION_NOT_FOUND`），權限撤銷回 403。
- 後端測試一律 `DATA_BACKEND=file`（`tests/setup-env.ts` 已設），絕不連真 DB；`server/.env` 的 `DATA_BACKEND=db` 指向真實資料庫，執行任何指令都不要覆寫或使用它。
- 回覆、註解、commit message 一律繁體中文；commit 結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- **雙擊或重送確認**：同一張卡片連按兩次「確認」→ 只執行一次，第二次回 409。測試在 Task 4。
- **提議後權限被撤銷**：管理員在使用者按確認前撤掉 scope → 回 403、不執行。測試在 Task 4。
- **MCP server 對話中途掛掉或逾時**：該輪對話照常完成，LLM 收到錯誤訊息並如實轉述，不丟 500。測試在 Task 8 與 Task 11。
- **卡片內容很長或結構複雜**（巢狀物件、陣列、HTML 內文、超長字串）→ 卡片仍可讀、有截斷。測試在 Task 2。
- **租戶 B 被誤授 `mcp:<A 專屬 server>`**：授權驗證直接拒絕，即使 scope 字串硬塞進政策，工具也不會出現。測試在 Task 9。

---

## 檔案結構

**新增（server）**

| 檔案 | 職責 |
|---|---|
| `server/src/modules/conversation/pending-action.ts` | 純函式：確認卡片摘要、建立／過期判斷、確認詞判斷 |
| `server/src/modules/conversation/pending-action.service.ts` | 執行／取消已確認的動作（重檢權限、寫逐字稿） |
| `server/src/modules/mcp/mcp.types.ts` | `McpServerConfig` 等型別與常數 |
| `server/src/modules/mcp/mcp.store.ts` | 登記資料 store（file / db） |
| `server/src/modules/mcp/mcp.identity.ts` | 呼叫 JWT 簽發、JWKS |
| `server/src/modules/mcp/mcp.routes.ts` | 公開 JWKS 路由 |
| `server/src/modules/mcp/mcp.connection.ts` | 連線、快取、逾時、退避、帶身分的 fetch |
| `server/src/modules/mcp/mcp.tool-source.ts` | MCP 工具 → `ToolDef`，動態工具來源 |
| `server/src/modules/mcp/mcp.intents.ts` | agent 路由意圖與提示詞的 MCP 段落 |
| `server/src/modules/mcp/register.ts` | 副作用：把 MCP 來源註冊進 registry |
| `server/src/modules/mcp/mcp.admin.schema.ts`、`mcp.admin.controller.ts` | 後台 API |
| `server/db/migrations/0019_mcp_servers.sql` | db 模式建表 |
| `server/tests/helpers/mcp-fixture.ts` | 測試用 MCP server（用 kit 組成） |

**新增（其他 workspace）**

| 檔案 | 職責 |
|---|---|
| `mcp/kit/src/verify.ts`、`middleware.ts`、`app.ts`、`index.ts` | MCP 端驗 JWT、Express middleware、無狀態 MCP HTTP app |
| `mcp/kit/examples/rooms/server.ts` | 範例 server（一讀一寫） |
| `client/src/ConfirmActionCard.tsx` | 確認卡片 |
| `admin/src/pages/McpServersPage.tsx`、`admin/src/pages/mcpForm.util.ts` | 後台 MCP 服務頁與表單工具函式 |

**修改**：`tool.types.ts`、`tool.registry.ts`、`tools/index.ts`、`oa.tools.ts`、`email.tools.ts`、`agent.agent-service.ts`、`agent-service.types.ts`、`conversation.types.ts`、`conversation.agent.ts`、`conversation.service.ts`、`conversation.controller.ts`、`conversation.routes.ts`、`conversation.schema.ts`、`intent-router.ts`、`scope-catalog.ts`、`admin.routes.ts`、`admin.controller.ts`、`app.ts`、`index.ts`、`config/env.ts`、`prisma/schema.prisma`、`docs/openapi.ts`、`tests/setup-env.ts`、`jest.config.js`、`shared/src/index.ts`、`client/src/api.ts`、`client/src/App.tsx`、`client/src/i18n.ts`、`admin/src/api.ts`、`admin/src/App.tsx`、`admin/src/components/AppLayout.tsx`、根 `package.json`、文件。

---

### Task 1：Tool Registry 支援 `effect` 與動態工具來源

**Files:**
- Modify: `server/src/modules/tools/tool.types.ts`
- Modify: `server/src/modules/tools/tool.registry.ts`
- Modify: `server/src/modules/tools/index.ts`
- Modify: `server/src/modules/tools/oa.tools.ts`
- Test: `server/tests/tool-source.test.ts`

**Interfaces:**
- Produces:
  - `type ToolEffect = 'read' | 'write'`；`ToolDef.effect?: ToolEffect`；`ToolDef.confirmTitle?: string`
  - `interface ToolSource { readonly id: string; prepare?(ctx: ToolContext): Promise<void>; toolsFor(ctx: ToolContext): ToolDef[] }`
  - `registerToolSource(source: ToolSource): void`、`unregisterToolSource(id: string): void`、`isWriteTool(tool: ToolDef): boolean`
  - `toolRegistry.resolve(id: string, ctx: ToolContext): ToolDef`
  - `toolRegistry.prepare(ctx: ToolContext): Promise<void>`
  - `toolRegistry.assertInvocable(id: string, input: unknown, ctx: ToolContext): void`（scope + Ajv，不執行、不稽核）
  - `toolRegistry.invoke` / `availableFor` 同時涵蓋靜態工具與來源工具（靜態 id 優先）

- [ ] **Step 1：寫失敗測試**

`server/tests/tool-source.test.ts`：

```ts
/** 動態工具來源：availableFor / invoke / resolve / prepare 合併靜態表與來源；effect 安全預設。 */
import {
  isWriteTool,
  registerToolSource,
  toolRegistry,
  unregisterToolSource,
  type ToolContext,
  type ToolDef,
  type ToolSource,
} from '@/modules/tools';

const ctx: ToolContext = { tenantId: 't-src', userId: 'u1', scopes: ['src:use'] };
const calls: unknown[] = [];

function dynTool(partial: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 'dyn.echo',
    description: '回聲',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    scopes: ['src:use'],
    agentExposed: true,
    effect: 'read',
    handler: async (input) => {
      calls.push(input);
      return { echoed: input };
    },
    ...partial,
  };
}

function source(tools: ToolDef[], extra: Partial<ToolSource> = {}): ToolSource {
  return { id: 'test-src', toolsFor: () => tools, ...extra };
}

afterEach(() => {
  unregisterToolSource('test-src');
  calls.length = 0;
});

describe('動態工具來源', () => {
  it('agentExposed 且有 scope 的來源工具出現在 availableFor', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.availableFor(ctx).map((t) => t.name)).toContain('dyn.echo');
  });

  it('缺 scope 的來源工具不出現', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.availableFor({ ...ctx, scopes: [] }).map((t) => t.name)).not.toContain('dyn.echo');
  });

  it('invoke 來源工具：Ajv 通過才執行 handler', async () => {
    registerToolSource(source([dynTool()]));
    await expect(toolRegistry.invoke('dyn.echo', { text: 1 }, ctx)).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toHaveLength(0);
    await expect(toolRegistry.invoke('dyn.echo', { text: 'hi' }, ctx)).resolves.toEqual({ echoed: { text: 'hi' } });
  });

  it('invoke 來源工具缺 scope → 403', async () => {
    registerToolSource(source([dynTool()]));
    await expect(toolRegistry.invoke('dyn.echo', { text: 'hi' }, { ...ctx, scopes: [] })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('靜態 id 優先於來源同名工具', () => {
    registerToolSource(source([dynTool({ id: 'oa.getLeaveBalance', description: '冒名' })]));
    const tools = toolRegistry.availableFor({ ...ctx, scopes: ['oa:read', 'src:use'] });
    const hits = tools.filter((t) => t.name === 'oa.getLeaveBalance');
    expect(hits).toHaveLength(1);
    expect(hits[0].description).not.toBe('冒名');
  });

  it('toolsFor 丟錯不影響 availableFor', () => {
    registerToolSource(source([], { toolsFor: () => { throw new Error('boom'); } }));
    expect(() => toolRegistry.availableFor(ctx)).not.toThrow();
  });

  it('prepare 會等待來源，來源失敗被吞掉', async () => {
    let prepared = false;
    registerToolSource(source([], { prepare: async () => { prepared = true; throw new Error('down'); } }));
    await expect(toolRegistry.prepare(ctx)).resolves.toBeUndefined();
    expect(prepared).toBe(true);
  });

  it('resolve 找得到來源工具；找不到丟錯', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.resolve('dyn.echo', ctx).description).toBe('回聲');
    expect(() => toolRegistry.resolve('dyn.none', ctx)).toThrow('unknown tool');
  });

  it('assertInvocable：驗證失敗丟錯且不執行 handler', () => {
    registerToolSource(source([dynTool()]));
    expect(() => toolRegistry.assertInvocable('dyn.echo', {}, ctx)).toThrow();
    expect(() => toolRegistry.assertInvocable('dyn.echo', { text: 'ok' }, ctx)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('isWriteTool：未標 effect 視為寫入', () => {
    expect(isWriteTool(dynTool({ effect: undefined }))).toBe(true);
    expect(isWriteTool(dynTool({ effect: 'write' }))).toBe(true);
    expect(isWriteTool(dynTool({ effect: 'read' }))).toBe(false);
  });

  it('既有 OA 唯讀工具已標 effect=read', () => {
    expect(toolRegistry.get('oa.getLeaveBalance').effect).toBe('read');
    expect(toolRegistry.get('oa.listMyRequests').effect).toBe('read');
    expect(toolRegistry.get('oa.getApprovalStatus').effect).toBe('read');
    expect(toolRegistry.get('oa.submitForm').effect).toBe('write');
  });
});
```

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/tool-source.test.ts`
Expected: FAIL，訊息為 `registerToolSource` / `isWriteTool` 不存在（`is not a function`）。

- [ ] **Step 3：擴充型別**

把 `server/src/modules/tools/tool.types.ts` 整檔改為：

```ts
/**
 * Tool Registry 契約：工具即一等公民。
 *
 * ToolDef 是最小可呼叫單位；連接器（OA/ERP/Calendar/Email）退為工具 handler 的內部依賴。
 * inputSchema 一物二用：給 Agent 當 LLM tool schema，也做 invoke 前的 Ajv 驗證。
 * 工具可以靜態註冊（registerTool），也可以由 ToolSource 動態提供（如 MCP server 的工具）。
 */
export interface ToolContext {
  tenantId: string;
  userId: string;
  locale?: string;
  /** resolveScopes(principal) 的結果；invoke 以此比對 tool.scopes */
  scopes: string[];
}

/** 'read' 唯讀可直接執行；'write' 有副作用，Agent 只能提議、須使用者確認後才由後端執行。 */
export type ToolEffect = 'read' | 'write';

export interface ToolDef<I = unknown, O = unknown> {
  /** 命名空間 id，如 'oa.submitForm' / 'oa.getLeaveBalance' / 'mcp.rooms.book' */
  readonly id: string;
  /** 給 Agent 的 LLM 分類/挑選用（Phase 1 起用） */
  readonly description: string;
  /** JSON Schema：LLM tool schema + 執行前 Ajv 驗證 */
  readonly inputSchema: Record<string, unknown>;
  /** 需具備的權限，如 ['oa:write']；空陣列＝不需權限 */
  readonly scopes: string[];
  /**
   * 是否可暴露給自主 Agent 由 LLM 自選（安全預設：未標＝不暴露）。
   * 寫入工具即使暴露，Agent 也只能「提議」，實際執行要經使用者確認（見 effect）。
   */
  readonly agentExposed?: boolean;
  /** 讀或寫。未標視為 'write'（安全預設）：寧可多問一次確認，也不要讓 LLM 自行執行副作用。 */
  readonly effect?: ToolEffect;
  /** 寫入工具的確認卡片標題；未設時取 description。 */
  readonly confirmTitle?: string;
  /** 是否寫入稽核軌跡（僅有副作用的動作應開，如 email.send / oa.submitForm）。 */
  readonly audit?: boolean;
  /** 稽核安全摘要（不含 PII）；invoke 記錄時呼叫。失敗會被 best-effort 吞掉。 */
  auditSummary?(input: I, result?: O): string;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * 動態工具來源（如 MCP）：工具清單在執行期才知道、可能依租戶不同。
 * toolsFor 必須同步（讀快取）；需要網路的更新放在 prepare，由 Agent 每輪取工具前呼叫。
 */
export interface ToolSource {
  readonly id: string;
  /** 更新快取；失敗須可被呼叫端吞掉（registry 會吞）。 */
  prepare?(ctx: ToolContext): Promise<void>;
  /** 此 ctx 可見的工具；scope 與 agentExposed 由 registry 再過濾。 */
  toolsFor(ctx: ToolContext): ToolDef[];
}
```

- [ ] **Step 4：改寫 registry**

把 `server/src/modules/tools/tool.registry.ts` 整檔改為：

```ts
/**
 * Agent 工具註冊表（碰外部系統的動作）。
 *
 * 與 service.registry 同構的查表結構。invoke 是唯一執行入口：
 * 集中做 scope 檢查、Ajv 輸入驗證、稽核鉤子，服務層不再直接碰連接器、也不寫權限碼。
 * 對話控制類工具（如 form 的 slot-filling）不進此表——只有碰外部系統的動作才進來。
 * 工具有兩種來源：registerTool 的靜態表，以及 registerToolSource 的動態來源（如 MCP）；
 * 同 id 時靜態優先，動態來源不得冒名頂替既有工具。
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { LLMTool } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { auditStore } from '@/modules/audit/audit.store';
import type { ToolContext, ToolDef, ToolSource } from './tool.types';

const ajv = new Ajv({ allErrors: true, strict: false });

/** 註冊表內部紀錄：ToolDef 連同編譯好的 Ajv validator，避免每次 invoke 重編譯。 */
interface Entry {
  tool: ToolDef;
  validate: ValidateFunction;
}

const registry = new Map<string, Entry>();
const sources = new Map<string, ToolSource>();
/** 動態工具的 validator 快取：以 ToolDef 物件為 key，來源換新物件（如重新 listTools）時自然失效。 */
const dynamicValidators = new WeakMap<ToolDef, ValidateFunction>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
  const validate = ajv.compile(tool.inputSchema);
  registry.set(tool.id, { tool, validate });
}

export function registerToolSource(source: ToolSource): void {
  if (sources.has(source.id)) throw new Error(`duplicate tool source: ${source.id}`);
  sources.set(source.id, source);
}

/** 測試與熱移除用。 */
export function unregisterToolSource(id: string): void {
  sources.delete(id);
}

/** 未標 effect 一律當寫入（安全預設）。 */
export function isWriteTool(tool: ToolDef): boolean {
  return tool.effect !== 'read';
}

/** granted 需涵蓋 required 全部（無萬用字元；scope 一律逐個比對）。 */
function hasScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}

/** 所有來源在此 ctx 下的工具；單一來源丟錯只記警告，不拖垮其他來源。 */
function dynamicTools(ctx: ToolContext): ToolDef[] {
  const out: ToolDef[] = [];
  for (const source of sources.values()) {
    try {
      out.push(...source.toolsFor(ctx));
    } catch (err) {
      logger.warn({ err, sourceId: source.id }, 'tool source toolsFor failed (ignored)');
    }
  }
  return out;
}

/** 查表：靜態優先，其次動態來源（需 ctx）；查無丟未知工具錯誤。 */
function lookup(id: string, ctx?: ToolContext): Entry {
  const entry = registry.get(id);
  if (entry) return entry;
  if (ctx) {
    const tool = dynamicTools(ctx).find((t) => t.id === id);
    if (tool) {
      let validate = dynamicValidators.get(tool);
      if (!validate) {
        validate = ajv.compile(tool.inputSchema);
        dynamicValidators.set(tool, validate);
      }
      return { tool, validate };
    }
  }
  throw new Error(`unknown tool: ${id}`);
}

/** scope 與輸入驗證；通過回 undefined，失敗回要丟出的 AppError（invoke 另行稽核）。 */
function precheck(id: string, { tool, validate }: Entry, input: unknown, ctx: ToolContext): AppError | undefined {
  if (!hasScopes(ctx.scopes, tool.scopes)) return AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
  if (!validate(input)) return AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
  return undefined;
}

export const toolRegistry = {
  /** 只查靜態表（既有呼叫端用）；動態工具請用 resolve。 */
  get(id: string): ToolDef {
    const entry = registry.get(id);
    if (!entry) throw new Error(`unknown tool: ${id}`);
    return entry.tool;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  resolve(id: string, ctx: ToolContext): ToolDef {
    return lookup(id, ctx).tool;
  },
  /** 每輪 Agent 取工具前呼叫：讓動態來源更新快取。來源失敗一律吞掉（該來源工具暫不出現）。 */
  async prepare(ctx: ToolContext): Promise<void> {
    await Promise.all(
      [...sources.values()].map(async (source) => {
        try {
          await source.prepare?.(ctx);
        } catch (err) {
          logger.warn({ err, sourceId: source.id }, 'tool source prepare failed (ignored)');
        }
      }),
    );
  },
  /** 提議寫入前用：與 invoke 相同的 scope + Ajv 檢查，但不執行、不稽核。 */
  assertInvocable(id: string, input: unknown, ctx: ToolContext): void {
    const error = precheck(id, lookup(id, ctx), input, ctx);
    if (error) throw error;
  },
  async invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const entry = lookup(id, ctx);
    const { tool } = entry;
    const audit = (ok: boolean, extra: { summary?: string; error?: string }): void => {
      if (!tool.audit) return;
      // 稽核為旁路：整段包 try/catch——摘要或寫入的任何失敗都不得影響工具呼叫的正常回傳/錯誤
      // （否則成功送出的 email/表單可能被回報成失敗，導致使用者重送）。
      try {
        let summary = extra.summary;
        if (summary === undefined) {
          // 摘要失敗仍記錄（退回工具 id）；record 本身失敗才由外層 catch 整筆略過
          try {
            summary = tool.auditSummary ? tool.auditSummary(input as never) : tool.id;
          } catch {
            summary = tool.id;
          }
        }
        auditStore.record(ctx.tenantId, { toolId: id, userId: ctx.userId, at: new Date().toISOString(), ok, summary, error: extra.error });
      } catch (err) {
        logger.warn({ err, toolId: id }, 'audit record failed (ignored)');
      }
    };

    const error = precheck(id, entry, input, ctx);
    if (error) {
      audit(false, { error: error.statusCode === 403 ? '權限不足' : '輸入驗證失敗' });
      throw error;
    }
    logger.debug({ toolId: id, tenantId: ctx.tenantId, userId: ctx.userId }, 'tool.invoke');
    try {
      const result = await tool.handler(input, ctx);
      let summary: string | undefined;
      try {
        summary = tool.auditSummary ? tool.auditSummary(input as never, result as never) : undefined;
      } catch {
        summary = undefined;
      }
      audit(true, { summary });
      return result;
    } catch (err) {
      audit(false, { error: (err as Error).message });
      throw err;
    }
  },
  /**
   * Agent 專用：列出「agentExposed 且 ctx.scopes 允許」的工具，映射為 LLMTool 供 LLM 自選。
   * 未標 agentExposed 的工具不會出現，是本層的安全邊界。動態來源與靜態同 id 時捨棄動態。
   */
  availableFor(ctx: ToolContext): LLMTool[] {
    const tools: LLMTool[] = [];
    const seen = new Set<string>();
    const push = (tool: ToolDef, dynamic: boolean): void => {
      if (!tool.agentExposed) return;
      if (!hasScopes(ctx.scopes, tool.scopes)) return;
      if (seen.has(tool.id)) {
        if (dynamic) logger.warn({ toolId: tool.id }, 'dynamic tool id collides with existing tool; ignored');
        return;
      }
      seen.add(tool.id);
      tools.push({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema });
    };
    for (const { tool } of registry.values()) push(tool, false);
    for (const tool of dynamicTools(ctx)) push(tool, true);
    return tools;
  },
};
```

- [ ] **Step 5：更新匯出與 OA 工具標記**

`server/src/modules/tools/index.ts` 改為：

```ts
/**
 * Tools 進入點：import 時副作用註冊所有工具，並對外提供 registry 與工具建構工具。
 * 上層一律從 '@/modules/tools' import，確保工具在被 invoke 前已完成註冊。
 */
import './oa.tools';
import './email.tools';

export {
  isWriteTool,
  registerTool,
  registerToolSource,
  toolRegistry,
  unregisterToolSource,
} from './tool.registry';
export { makeToolContext } from './tool.context';
export type { ToolContext, ToolDef, ToolEffect, ToolSource } from './tool.types';
```

在 `server/src/modules/tools/oa.tools.ts` 的四個 `registerTool({...})` 物件中各加一行（放在 `scopes:` 那一行之後）：

- `id: 'oa.submitForm'` → `effect: 'write',`
- `id: 'oa.getLeaveBalance'` → `effect: 'read',`
- `id: 'oa.listMyRequests'` → `effect: 'read',`
- `id: 'oa.getApprovalStatus'` → `effect: 'read',`

- [ ] **Step 6：確認測試通過、既有工具測試不壞**

Run: `cd server && npx jest tests/tool-source.test.ts tests/tool-registry.test.ts tests/tool-available.test.ts tests/audit-invoke.test.ts tests/scope-enforcement.test.ts tests/workflow-tools.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7：型別檢查與 commit**

Run: `cd server && npm run typecheck`
Expected: 無錯誤。

```bash
git add server/src/modules/tools server/tests/tool-source.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): Tool Registry 支援動態工具來源與讀寫標記

新增 ToolSource 介面（prepare + toolsFor）與 resolve／prepare／assertInvocable；
availableFor 與 invoke 合併靜態表與動態來源，同 id 時靜態優先。ToolDef 新增
effect（未標視為寫入）與 confirmTitle，OA 工具補標讀寫。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2：待確認動作的純函式模組

**Files:**
- Modify: `shared/src/index.ts`（檔尾追加型別）
- Create: `server/src/modules/conversation/pending-action.ts`
- Test: `server/tests/pending-action.test.ts`

**Interfaces:**
- Consumes: `ToolDef`（Task 1）
- Produces（`@hyagent/shared`）：`ConfirmCardField { label: string; value: string }`、`ConfirmCard { title: string; fields: ConfirmCardField[] }`、`PendingActionView { id: string; summary: ConfirmCard; expiresAt: string }`
- Produces（`pending-action.ts`）：
  - `PENDING_ACTION_TTL_MS = 600000`、`CARD_VALUE_MAX_CHARS = 500`
  - `interface PendingAction { id: string; toolId: string; input: Record<string, unknown>; summary: ConfirmCard; expiresAt: string }`
  - `buildConfirmCard(tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>, input: Record<string, unknown>): ConfirmCard`
  - `createPendingAction(tool: ToolDef, input: Record<string, unknown>, now?: number): PendingAction`
  - `isPendingActionExpired(action: PendingAction, now?: number): boolean`
  - `toPendingActionView(action: PendingAction): PendingActionView`
  - `isConfirmationText(text: string): boolean`

- [ ] **Step 1：寫失敗測試**

`server/tests/pending-action.test.ts`：

```ts
/** 待確認動作：卡片摘要、效期、對外視圖、確認詞判斷。 */
import type { ToolDef } from '@/modules/tools';
import {
  CARD_VALUE_MAX_CHARS,
  PENDING_ACTION_TTL_MS,
  buildConfirmCard,
  createPendingAction,
  isConfirmationText,
  isPendingActionExpired,
  toPendingActionView,
} from '@/modules/conversation/pending-action';

const tool: ToolDef = {
  id: 'mcp.rooms.rooms_book',
  description: '預約會議室',
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', title: '會議室' },
      date: { type: 'string', description: '日期 YYYY-MM-DD' },
      note: { type: 'string' },
      body: { type: 'string', title: '內文', 'x-display': 'html' },
      attendees: { type: 'array', title: '與會者' },
      meta: { type: 'object', title: '其他' },
    },
  },
  scopes: [],
  effect: 'write',
  handler: async () => undefined,
};

describe('buildConfirmCard', () => {
  it('標籤依 title → description → key 取用，順序依 schema，未知欄位接在後面', () => {
    const card = buildConfirmCard(tool, { extra: 'x', note: 'n', date: '2026-10-03', room: 'A' });
    expect(card.fields).toEqual([
      { label: '會議室', value: 'A' },
      { label: '日期 YYYY-MM-DD', value: '2026-10-03' },
      { label: 'note', value: 'n' },
      { label: 'extra', value: 'x' },
    ]);
  });

  it('標題取 confirmTitle，否則取 description', () => {
    expect(buildConfirmCard(tool, {}).title).toBe('預約會議室');
    expect(buildConfirmCard({ ...tool, confirmTitle: '確認預約' }, {}).title).toBe('確認預約');
  });

  it('x-display=html 會去除標籤；陣列以頓號串接；物件轉 JSON；null 省略', () => {
    const card = buildConfirmCard(tool, {
      body: '<p>您好，<b>明天</b>開會</p>',
      attendees: ['王', '李'],
      meta: { a: 1 },
      note: null,
    });
    expect(card.fields).toEqual([
      { label: '內文', value: '您好， 明天 開會' },
      { label: '與會者', value: '王、李' },
      { label: '其他', value: '{"a":1}' },
    ]);
  });

  it('超長值截斷並加刪節號', () => {
    const card = buildConfirmCard(tool, { room: 'x'.repeat(CARD_VALUE_MAX_CHARS + 50) });
    expect(card.fields[0].value).toHaveLength(CARD_VALUE_MAX_CHARS + 1);
    expect(card.fields[0].value.endsWith('…')).toBe(true);
  });

  it('數字與布林轉字串', () => {
    const card = buildConfirmCard(tool, { room: 3, note: false });
    expect(card.fields).toEqual([
      { label: '會議室', value: '3' },
      { label: 'note', value: 'false' },
    ]);
  });
});

describe('createPendingAction / 效期 / 視圖', () => {
  it('效期 10 分鐘、帶 uuid 與工具 id', () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    const a = createPendingAction(tool, { room: 'A' }, now);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.toolId).toBe('mcp.rooms.rooms_book');
    expect(Date.parse(a.expiresAt) - now).toBe(PENDING_ACTION_TTL_MS);
    expect(isPendingActionExpired(a, now + PENDING_ACTION_TTL_MS - 1)).toBe(false);
    expect(isPendingActionExpired(a, now + PENDING_ACTION_TTL_MS)).toBe(true);
  });

  it('對外視圖不含工具 id 與原始參數', () => {
    const view = toPendingActionView(createPendingAction(tool, { room: 'A' }));
    expect(Object.keys(view).sort()).toEqual(['expiresAt', 'id', 'summary']);
  });
});

describe('isConfirmationText', () => {
  it.each(['確認', 'OK', 'ok', '好，寄出', '好的，寄出', '幫我寄', '確認執行', '好', '同意', '確認。'])('「%s」是確認', (s) => {
    expect(isConfirmationText(s)).toBe(true);
  });
  it.each(['OK 謝謝先這樣', '確認一下我的假還有幾天', '不要，取消', '先不要確認', '', '改成下午'])('「%s」不是確認', (s) => {
    expect(isConfirmationText(s)).toBe(false);
  });
});
```

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/pending-action.test.ts`
Expected: FAIL，`Cannot find module '@/modules/conversation/pending-action'`。

- [ ] **Step 3：共用型別**

在 `shared/src/index.ts` 檔尾追加：

```ts
/** 寫入動作確認卡片的一列（給人看的標籤與值） */
export interface ConfirmCardField {
  label: string;
  value: string;
}

/** 寫入動作確認卡片 */
export interface ConfirmCard {
  title: string;
  fields: ConfirmCardField[];
}

/** 前端看到的待確認動作：不含工具 id 與原始參數，確認時只帶 id 回來 */
export interface PendingActionView {
  id: string;
  summary: ConfirmCard;
  expiresAt: string;
}
```

- [ ] **Step 4：實作模組**

`server/src/modules/conversation/pending-action.ts`：

```ts
/**
 * 待確認動作（純函式）：寫入工具被 LLM 提議時，存成 session.pendingAction，
 * 由使用者在確認卡片上確認後才由後端執行（見 pending-action.service）。
 *
 * 卡片摘要從工具的 inputSchema 推導：欄位 title → description → key 當標籤，
 * 讓自建 MCP 只要把 schema 寫好，卡片就能讀。
 */
import { randomUUID } from 'node:crypto';
import type { ConfirmCard, ConfirmCardField, PendingActionView } from '@hyagent/shared';
import type { ToolDef } from '@/modules/tools/tool.types';

export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;
export const CARD_VALUE_MAX_CHARS = 500;

export interface PendingAction {
  id: string;
  toolId: string;
  /** 已通過 Ajv 的參數；確認後原封不動執行 */
  input: Record<string, unknown>;
  summary: ConfirmCard;
  expiresAt: string;
}

interface PropSchema {
  title?: unknown;
  description?: unknown;
  'x-display'?: unknown;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  return s.length > CARD_VALUE_MAX_CHARS ? `${s.slice(0, CARD_VALUE_MAX_CHARS)}…` : s;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function formatValue(value: unknown, prop: PropSchema | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return truncate(prop?.['x-display'] === 'html' ? stripHtml(value) : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(isPrimitive)) return truncate(value.map(String).join('、'));
  return truncate(JSON.stringify(value));
}

function labelOf(key: string, prop: PropSchema | undefined): string {
  if (typeof prop?.title === 'string' && prop.title) return prop.title;
  if (typeof prop?.description === 'string' && prop.description) return prop.description;
  return key;
}

export function buildConfirmCard(
  tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>,
  input: Record<string, unknown>,
): ConfirmCard {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, PropSchema>;
  const known = Object.keys(props).filter((k) => k in input);
  const extra = Object.keys(input).filter((k) => !(k in props));
  const fields: ConfirmCardField[] = [];
  for (const key of [...known, ...extra]) {
    const value = formatValue(input[key], props[key]);
    if (value === undefined) continue;
    fields.push({ label: labelOf(key, props[key]), value });
  }
  return { title: tool.confirmTitle ?? tool.description, fields };
}

export function createPendingAction(tool: ToolDef, input: Record<string, unknown>, now = Date.now()): PendingAction {
  return {
    id: randomUUID(),
    toolId: tool.id,
    input,
    summary: buildConfirmCard(tool, input),
    expiresAt: new Date(now + PENDING_ACTION_TTL_MS).toISOString(),
  };
}

export function isPendingActionExpired(action: PendingAction, now = Date.now()): boolean {
  return Date.parse(action.expiresAt) <= now;
}

export function toPendingActionView(action: PendingAction): PendingActionView {
  return { id: action.id, summary: action.summary, expiresAt: action.expiresAt };
}

// 確認/取消語意判斷：取消優先於確認（例如「確認」被「不要，先不要確認」蓋過時，先擋取消詞）。
// 需「整句就是明確的確認」才算（避免『OK 謝謝先這樣』這類夾帶確認詞卻非確認意圖的訊息誤觸）。
const CONFIRM_RE =
  /^(好的?[，,]?\s*)?(請\s*)?(幫我\s*)?(確認寄出|確定寄出|確認執行|確定執行|確認|確定|寄出|送出|執行|同意寄出|同意|可以寄出?|可以|寄|好的?|OK|ok)$/;
const CANCEL_RE = /(不要|先不要|別|取消|不寄|暫停|改)/;

export function isConfirmationText(text: string): boolean {
  const s = text.trim().replace(/[。.,，!！~\s]+$/u, '');
  if (!s || CANCEL_RE.test(s)) return false;
  return CONFIRM_RE.test(s);
}
```

- [ ] **Step 5：確認測試通過**

Run: `cd server && npx jest tests/pending-action.test.ts`
Expected: PASS。

- [ ] **Step 6：Commit**

```bash
git add shared/src/index.ts server/src/modules/conversation/pending-action.ts server/tests/pending-action.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 新增待確認動作模組（確認卡片摘要與效期）

寫入工具被提議時存成 pendingAction：卡片欄位由 inputSchema 的 title／description
推導，HTML 內文去標籤、超長截斷；效期 10 分鐘；確認詞判斷自 agent 服務抽出並放寬
為通用用語。共用型別 PendingActionView 放 @hyagent/shared 供前台使用。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3：智慧代理改用通用確認機制，email 遷移

**Files:**
- Create: `server/src/modules/conversation/pending-action.service.ts`
- Modify: `server/src/modules/conversation/conversation.types.ts`
- Modify: `server/src/modules/conversation/agent-service.types.ts`
- Modify: `server/src/modules/conversation/agent.agent-service.ts`
- Modify: `server/src/modules/conversation/intent-router.ts:119-122`
- Modify: `server/src/modules/conversation/conversation.agent.ts:86-112`
- Modify: `server/src/modules/tools/email.tools.ts`
- Delete: `server/tests/email-propose-tool.test.ts`
- Rewrite: `server/tests/agent-email.test.ts`
- Modify: `server/tests/email-tool.test.ts`、`server/tests/agent-email-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolRegistry.resolve / prepare / assertInvocable`、`isWriteTool`；Task 2 的 `createPendingAction`、`isPendingActionExpired`、`toPendingActionView`、`isConfirmationText`、`PendingAction`
- Produces:
  - `Session.pendingAction?: PendingAction`（移除 `pendingEmail`）
  - `TurnResult.pendingAction?: PendingActionView`、`AgentTurnResult.pendingAction?: PendingActionView`
  - `type ExecuteOutcome = { ok: true; reply: string; result: unknown } | { ok: false; reply: string; code: 'FORBIDDEN' | 'FAILED' }`
  - `runConfirmedAction(session: Session, action: PendingAction): Promise<ExecuteOutcome>`（呼叫端須先清除 `session.pendingAction`）
  - `cancelPendingAction(session: Session): string`（回覆文字；呼叫端須確認有待確認動作）

- [ ] **Step 1：改寫 agent 確認測試（先失敗）**

刪除 `server/tests/email-propose-tool.test.ts`。

`server/tests/agent-email.test.ts` 整檔改為：

```ts
/** Agent 寫入確認流程（fake LLM，以 email.send 為例）：提議只建卡片不寄；確認才寄；取消、夾帶確認詞、過期皆不寄。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { createPendingAction } from '@/modules/conversation/pending-action';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...partial };
}
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}
const noLLM: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };

function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's-email',
    tenantId,
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我寄信給王經理' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function tenantWithEmail(name: string): string {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
  return t.id;
}

function pendingEmail(tenantId: string, now = Date.now()) {
  const tool = toolRegistry.resolve('email.send', makeToolContext({ tenantId, userId: 'kevin' }));
  return createPendingAction(tool, { to: 'boss@x.com', subject: '會議改期', html: '<p>x</p>' }, now);
}

describe('Agent 寫入確認流程（email.send）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('LLM 呼叫 email_send → 只建確認卡片、不寄，回傳 pendingAction 視圖', async () => {
    const tenantId = tenantWithEmail('agent-email-propose');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email_send', input: { to: 'boss@x.com', subject: '會議改期', html: '<p>...</p>' } }], stopReason: 'tool_use' }),
      res({ text: '我已擬好給 boss@x.com 的信，請確認。' }),
    ]);
    const session = makeSession(tenantId);
    const out = await agentAgentService.handleTurn(session, '幫我寄信給王經理', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction?.toolId).toBe('email.send');
    expect(out.pendingAction?.id).toBe(session.pendingAction?.id);
    expect(out.pendingAction?.summary.fields.map((f) => f.label)).toEqual(['收件人', '主旨', '內文']);
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string };
    expect(tr.content).toContain('"proposed":true');
  });

  it('提議時輸入不合法 → 回錯誤給 LLM、不建卡片', async () => {
    const tenantId = tenantWithEmail('agent-email-invalid');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email_send', input: { to: 'boss@x.com' } }], stopReason: 'tool_use' }),
      res({ text: '請提供主旨與內容。' }),
    ]);
    const session = makeSession(tenantId);
    await agentAgentService.handleTurn(session, '寄信', llm);
    expect(session.pendingAction).toBeUndefined();
  });

  it.each(['確認', 'OK', '好，寄出', '幫我寄', '好的，寄出'])('有待確認動作 + 「%s」→ 伺服器端寄出（LLM 不參與）', async (text) => {
    const tenantId = tenantWithEmail(`agent-email-confirm-${text}`);
    const session = makeSession(tenantId, { pendingAction: pendingEmail(tenantId) });
    const out = await agentAgentService.handleTurn(session, text, noLLM);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingAction).toBeUndefined();
    expect(out.reply).toContain('已完成');
  });

  it.each(['不要，取消', 'OK 謝謝先這樣', '確認一下我的假還有幾天'])('有待確認動作 + 「%s」→ 不寄、動作失效', async (text) => {
    const tenantId = tenantWithEmail(`agent-email-noconfirm-${text}`);
    const llm = scriptedLLM([res({ text: '好的。' })]);
    const session = makeSession(tenantId, { pendingAction: pendingEmail(tenantId) });
    await agentAgentService.handleTurn(session, text, llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
  });

  it('待確認動作已過期 + 「確認」→ 不寄，告知已失效', async () => {
    const tenantId = tenantWithEmail('agent-email-expired');
    const session = makeSession(tenantId, { pendingAction: pendingEmail(tenantId, Date.now() - 11 * 60 * 1000) });
    const out = await agentAgentService.handleTurn(session, '確認', noLLM);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
    expect(out.reply).toContain('失效');
  });

  it('確認時權限已被撤銷 → 不寄，回覆權限不足', async () => {
    const tenantId = tenantWithEmail('agent-email-revoked');
    const session = makeSession(tenantId, { pendingAction: pendingEmail(tenantId) });
    tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });
    const out = await agentAgentService.handleTurn(session, '確認', noLLM);

    expect(stubSentEmails).toHaveLength(0);
    expect(out.reply).toContain('權限');
  });

  it('Agent 傳給 LLM 的工具名符合 ^[a-zA-Z0-9_-]{1,64}$，且 email.send 以 email_send 暴露', async () => {
    const tenantId = tenantWithEmail('agent-toolname');
    let captured: { name: string }[] = [];
    const llm: LLMProvider = {
      name: 'fake',
      createMessage: async (p) => {
        captured = (p.tools ?? []) as { name: string }[];
        return res({ text: 'ok' });
      },
    };
    await agentAgentService.handleTurn(makeSession(tenantId), 'hi', llm);
    expect(captured.length).toBeGreaterThan(0);
    for (const tool of captured) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(captured.map((c) => c.name)).toContain('email_send');
    expect(captured.map((c) => c.name)).not.toContain('email_propose');
  });

  it('LLM 幻想不存在的工具名被擋', async () => {
    const tenantId = tenantWithEmail('agent-email-hallucinate');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email.send', input: { to: 'x@x.com', subject: 's', html: '<p>x</p>' } }], stopReason: 'tool_use' }),
      res({ text: '抱歉。' }),
    ]);
    const session = makeSession(tenantId);
    await agentAgentService.handleTurn(session, '直接幫我寄', llm);
    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string };
    expect(tr.content).toContain('工具不可用');
  });
});
```

`server/tests/email-tool.test.ts` 的第一個 `it` 改為：

```ts
  it('已註冊、標為寫入且暴露給 Agent（Agent 只能提議，執行需確認）', () => {
    expect(toolRegistry.has('email.send')).toBe(true);
    expect(toolRegistry.get('email.send').effect).toBe('write');
    const t = tenantStore.createTenant('email-tool-exposed');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    expect(toolRegistry.availableFor(ctx).map((x) => x.name)).toContain('email.send');
  });
```

並把檔頭註解改為 `/** email.send 工具：需 email:write；未授予 → 403；授予 → 走 stub 寄出。暴露給 Agent 但標為寫入（須確認）。 */`。

`server/tests/agent-email-routing.test.ts`：檔頭註解改為 `/** 有待確認動作時，路由強制回 agent（讓確認閘收到確認/取消輪）。 */`；在 import 區加 `import { createPendingAction } from '@/modules/conversation/pending-action';` 與 `import { makeToolContext, toolRegistry } from '@/modules/tools';`；第一個測試改為：

```ts
it('有 pendingAction → 路由回 agent（0 token）', async () => {
  const t = tenantStore.createTenant('email-route');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
  const tool = toolRegistry.resolve('email.send', makeToolContext({ tenantId: t.id, userId: 'kevin' }));
  const session = makeSession(t.id, {
    pendingAction: createPendingAction(tool, { to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
  });
  const r = await intentRouter.route(session, '確認');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false);
});
```

第二個測試的標題 `'無 pendingEmail → 不強制 agent（一般路由）'` 改為 `'無 pendingAction → 不強制 agent（一般路由）'`。

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/agent-email.test.ts tests/email-tool.test.ts tests/agent-email-routing.test.ts`
Expected: FAIL（`email_send` 不在工具清單、`pendingAction` 未設、email.send 沒有 effect）。

- [ ] **Step 3：型別**

`server/src/modules/conversation/conversation.types.ts`：
- import 區加入 `import type { PendingActionView } from '@hyagent/shared';` 與 `import type { PendingAction } from './pending-action';`
- `Session` 介面中把

```ts
  /** Agent 待使用者確認的寄信草稿；確認後由確認閘以 email.send 送出，非確認的 agent 輪一律清空。 */
  pendingEmail?: { to: string; subject: string; html: string };
```

替換為

```ts
  /** Agent 提議、待使用者確認的寫入動作；確認後由後端執行，非確認的下一輪、過期或新提議即失效。 */
  pendingAction?: PendingAction;
```

- `TurnResult` 介面最後加：

```ts
  /** 本回合產生的待確認寫入動作（前端畫確認卡片） */
  pendingAction?: PendingActionView;
```

`server/src/modules/conversation/agent-service.types.ts`：import 區把 `import type { ReportRef } from '@hyagent/shared';` 改為 `import type { PendingActionView, ReportRef } from '@hyagent/shared';`，`AgentTurnResult` 最後加：

```ts
  /** 本回合產生的待確認寫入動作（僅 agent 服務會帶） */
  pendingAction?: PendingActionView;
```

- [ ] **Step 4：執行／取消服務**

`server/src/modules/conversation/pending-action.service.ts`：

```ts
/**
 * 已確認動作的執行與取消（不經 LLM）。
 *
 * 一律以「當下」重新解析的權限執行：提議到確認之間權限可能已被撤銷。
 * 呼叫端必須在呼叫前清除 session.pendingAction（確認是一次性的，雙擊或重送不得執行第二次）。
 */
import { logger } from '@/lib/logger';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';
import type { PendingAction } from './pending-action';

export type ExecuteOutcome =
  | { ok: true; reply: string; result: unknown }
  | { ok: false; reply: string; code: 'FORBIDDEN' | 'FAILED' };

const RESULT_NOTE_MAX_CHARS = 500;

function resultNote(result: unknown): string {
  if (result === undefined) return '';
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return `\n（執行結果：${s.length > RESULT_NOTE_MAX_CHARS ? `${s.slice(0, RESULT_NOTE_MAX_CHARS)}…` : s}）`;
}

export async function runConfirmedAction(session: Session, action: PendingAction): Promise<ExecuteOutcome> {
  const ctx = makeToolContext({ tenantId: session.tenantId, userId: session.userId, locale: session.locale });
  const title = action.summary.title;
  let outcome: ExecuteOutcome;
  let transcript: string;
  try {
    // 動態來源（MCP）的工具要先備妥快取，否則 resolve 不到
    await toolRegistry.prepare(ctx);
    const result = await toolRegistry.invoke(action.toolId, action.input, ctx);
    outcome = { ok: true, reply: `已完成「${title}」。`, result };
    // 逐字稿附上結果摘要，讓後續對話（如「剛才的預約編號是多少」）有上下文；使用者看到的回覆維持簡潔
    transcript = outcome.reply + resultNote(result);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof AppError && err.statusCode === 403) {
      outcome = { ok: false, code: 'FORBIDDEN', reply: `無法執行「${title}」：你目前沒有此操作的權限。` };
    } else if (message.startsWith('unknown tool:')) {
      outcome = { ok: false, code: 'FAILED', reply: `無法執行「${title}」：相關服務目前無法使用，請稍後再試。` };
    } else {
      outcome = { ok: false, code: 'FAILED', reply: `執行「${title}」失敗：${message}` };
    }
    transcript = outcome.reply;
    logger.warn({ err, sessionId: session.id, toolId: action.toolId }, 'confirmed action failed');
  }
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: transcript }] });
  return outcome;
}

export function cancelPendingAction(session: Session): string {
  const action = session.pendingAction;
  session.pendingAction = undefined;
  const reply = action ? `已取消「${action.summary.title}」。` : '目前沒有待確認的動作。';
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return reply;
}
```

- [ ] **Step 5：改寫智慧代理服務**

`server/src/modules/conversation/agent.agent-service.ts` 整檔改為：

```ts
/**
 * Agent 服務：處理「跨多個工具、多步驟」的開放式任務。
 *
 * 與 Form/Knowledge 走固定劇本不同，Agent 把「該使用者有權限、且允許暴露給 Agent」的工具
 * （toolRegistry.availableFor，含 MCP 等動態來源）交給 LLM 自選，靠共用 tool-loop 多輪往返完成任務。
 * 安全：
 *  - dispatchTool 只放行 availableFor 清單內的工具；LLM 幻想出別的工具名一律擋下。
 *  - 寫入工具（effect 非 read）LLM 只能「提議」：存成 session.pendingAction 並回給前端確認卡片，
 *    使用者確認後才由後端執行（確認端點或本服務的打字確認閘），LLM 全程碰不到執行。
 *  - 工具錯誤回傳為 tool_result，讓 LLM 自行修正而非中斷整輪。
 * sticky=true：Agent 常是多輪任務，需點黏才不會在蒐集資訊途中被沖回 form。
 */
import type { LLMProvider, LLMTool } from '@/lib/llm/types';
import { languageDirective } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { isWriteTool, makeToolContext, toolRegistry } from '@/modules/tools';
import type { AgentService, AgentTurnResult, IntentDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import {
  createPendingAction,
  isConfirmationText,
  isPendingActionExpired,
  toPendingActionView,
} from './pending-action';
import { runConfirmedAction } from './pending-action.service';
import { runToolLoop } from './tool-loop';

/** Anthropic 上限 128、OpenAI 上限 64，取交集。 */
const LLM_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function buildSystemPrompt(userId: string, locale?: string, extraLines: string[] = []): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是公司 OA 系統的智慧代理，協助使用者完成需要操作公司系統的任務。${languageDirective(locale)}`,
    `今天日期是 ${today}；請把相對日期（明天、下週一等）換算成 YYYY-MM-DD。`,
    `目前登入使用者的識別碼是 ${userId}；查詢「自己」資料的工具會自動綁定此身分，不需要你提供或詢問使用者 id。`,
    ...extraLines,
    '工作方式：',
    '- 只能使用提供給你的工具；沒有合適工具時，據實說明目前無法完成，不要捏造結果或假裝已完成。',
    '- 需要時可連續呼叫多個工具，依回傳結果決定下一步，完成後用簡潔中文回覆使用者。',
    '- 工具回傳錯誤時，向使用者說明狀況或改用其他方式，不要重複無效呼叫。',
    '- 只處理與公司系統或知識庫相關的任務；純閒聊、與任何服務無關的問題請禮貌婉拒。',
    '- 寫入類工具（寄信、預約、建立或修改資料等）呼叫後不會立即執行：系統會把內容做成確認卡片給使用者。你要用一兩句話說明即將執行的內容並請使用者確認，切勿宣稱已完成。',
    '- 使用者問申請/簽核進度時：用 oa_listMyRequests 列出他的申請、oa_getApprovalStatus 查特定單號的關卡；如實轉述查詢結果，查無就說查無。要催辦時，用 email_send 擬催辦信（不確定收件人就先問使用者）。',
    '- 需要寄信時：呼叫 email_send 並帶上完整收件人、主旨、內文；系統會先請使用者確認才寄出。',
  ].join('\n');
}

/** 把 registry 的點命名轉成 LLM 合法名；不合法或撞名的工具不暴露（記警告），並回傳映回真實 id 的表。 */
function exposeTools(tools: LLMTool[]): { llmTools: LLMTool[]; idByLlmName: Map<string, string> } {
  const idByLlmName = new Map<string, string>();
  const llmTools: LLMTool[] = [];
  for (const t of tools) {
    const llmName = t.name.replace(/\./g, '_');
    if (!LLM_TOOL_NAME_RE.test(llmName) || idByLlmName.has(llmName)) {
      logger.warn({ toolId: t.name, llmName }, 'tool not exposed: invalid or colliding LLM name');
      continue;
    }
    idByLlmName.set(llmName, t.name);
    llmTools.push({ ...t, name: llmName });
  }
  return { llmTools, idByLlmName };
}

export const agentAgentService: AgentService = {
  id: 'agent',
  label: '智慧代理',
  description: '多步驟任務代理：跨工具規劃與執行（查詢、寄信、外部服務等），寫入動作經使用者確認',
  sticky: true,
  serviceScope: 'service:agent',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'agent.task',
        // 精準的「代寄信」動作片語（0-token 直接路由到 agent）；刻意用完整片語避免誤搶
        // （如「寄信給」不會命中「寄信的規定」這種問答）。開放式多步驟任務仍靠分類器判斷。
        keywords: [
          '寄信給', '幫我寄', '寄封信', '寄一封信', '發信給', '代寄',
          // 查簽核／催辦（完整片語，避免搶走「簽核規定是什麼」這類知識問句）
          '簽核進度', '簽到哪', '我的申請', '申請進度', '簽核狀態', '催辦',
        ],
        description:
          '需要操作公司系統/工具的任務：查詢並彙整資料、查自己申請的簽核進度、代擬並（經確認後）寄送通知信/催辦信 Email。',
      },
    ];
  },

  async handleTurn(session: Session, userText: string, llm: LLMProvider): Promise<AgentTurnResult> {
    const ctx = makeToolContext({
      tenantId: session.tenantId,
      userId: session.userId,
      locale: session.locale,
    });

    // 打字確認閘（確認卡片按鈕的備援）：只有未過期的待確認動作 + 整句即確認時才執行
    const pending = session.pendingAction;
    if (pending) {
      session.pendingAction = undefined; // 一次性：不論結果如何，這筆都不再有效
      if (isPendingActionExpired(pending)) {
        if (isConfirmationText(userText)) {
          const reply = `「${pending.summary.title}」已逾時失效，請重新提出需求。`;
          session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
          return { reply };
        }
      } else if (isConfirmationText(userText)) {
        const outcome = await runConfirmedAction(session, pending);
        logger.info({ sessionId: session.id, toolId: pending.toolId, ok: outcome.ok }, 'agent action confirmed by text');
        return { reply: outcome.reply };
      }
    }

    await toolRegistry.prepare(ctx);
    const { llmTools, idByLlmName } = exposeTools(toolRegistry.availableFor(ctx));

    const reply = await runToolLoop(llm, session, {
      system: buildSystemPrompt(session.userId, session.locale),
      tools: llmTools,
      dispatchTool: async (name, input) => {
        // 安全邊界：只放行 availableFor 清單內的工具（映回真實 id），LLM 幻想出別的名字一律擋下
        const realId = idByLlmName.get(name);
        if (!realId) {
          return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
        }
        try {
          const tool = toolRegistry.resolve(realId, ctx);
          if (isWriteTool(tool)) {
            // 寫入只提議：先跑與 invoke 相同的權限與輸入驗證，通過才建卡片，不執行
            toolRegistry.assertInvocable(realId, input, ctx);
            const action = createPendingAction(tool, input);
            session.pendingAction = action;
            return JSON.stringify({
              ok: true,
              proposed: true,
              card: action.summary,
              note: '已建立確認卡片，尚未執行。請向使用者簡述將執行的內容並請他確認；切勿宣稱已完成。',
            });
          }
          const result = await toolRegistry.invoke(realId, input, ctx);
          return JSON.stringify({ ok: true, result });
        } catch (err) {
          // 工具錯誤（權限/驗證/連接器/MCP）回傳給 LLM 自行修正，不中斷整輪
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    });

    logger.info({ sessionId: session.id, toolCount: llmTools.length }, 'agent turn complete');
    return {
      reply,
      ...(session.pendingAction ? { pendingAction: toPendingActionView(session.pendingAction) } : {}),
    };
  },
};
```

- [ ] **Step 6：路由與 runTurn**

`server/src/modules/conversation/intent-router.ts` 第 119–122 行改為：

```ts
    // 待確認的寫入動作：本輪強制回 agent，讓確認閘處理確認/取消
    if (session.pendingAction && enabledIds.has('agent')) {
      return { serviceId: 'agent', viaLLM: false };
    }
```

`server/src/modules/conversation/conversation.agent.ts` 的 `runTurn`：把

```ts
  const { reply, report } = await service.handleTurn(session, userText, llm);
```

改為

```ts
  const { reply, report, pendingAction } = await service.handleTurn(session, userText, llm);
```

並把回傳物件最後的 `...(report ? { report } : {}),` 之後加一行 `...(pendingAction ? { pendingAction } : {}),`。

- [ ] **Step 7：email 工具遷移**

`server/src/modules/tools/email.tools.ts` 整檔改為：

```ts
/**
 * Email 工具：把 EmailConnector.send 包成工具。scope email:write。
 * 暴露給 Agent 但標為寫入：Agent 呼叫時只會建立確認卡片，使用者確認後才由後端寄出。
 */
import { getConnector } from '@/lib/connectors';
import type { EmailSendInput, EmailSendResult } from '@/lib/email/types';
import { registerTool } from './tool.registry';

registerTool({
  id: 'email.send',
  description: '寄送一封 HTML 通知信給指定收件者。',
  confirmTitle: '寄送 Email',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', title: '收件人' },
      subject: { type: 'string', title: '主旨' },
      html: { type: 'string', title: '內文', 'x-display': 'html' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  agentExposed: true,
  effect: 'write',
  audit: true,
  auditSummary: (input: EmailSendInput) => `收件人 ${input.to}｜主旨 ${input.subject}`,
  handler: (input: EmailSendInput): Promise<EmailSendResult> => getConnector('email').send(input),
});
```

- [ ] **Step 8：清查殘留引用**

Run: `cd .. && grep -rn "pendingEmail\|email\.propose\|email_propose\|isEmailConfirmation" server/src server/tests client/src sdk/src admin/src docs/*.md INTEGRATION.md README.md`
Expected: 無輸出。若有，依本任務的新命名（`pendingAction`、`email_send`）修正。

- [ ] **Step 9：跑相關測試與全套後端測試**

Run: `cd server && npx jest tests/agent-email.test.ts tests/email-tool.test.ts tests/agent-email-routing.test.ts tests/agent-service.test.ts tests/agent-routing.test.ts`
Expected: PASS。

Run: `cd server && npm test`
Expected: 全部 PASS。若有其他測試斷言 `email.propose` 或舊的回覆字串「已寄出」，改為新行為（`email_send`／「已完成」）。

- [ ] **Step 10：型別檢查與 commit**

Run: `cd server && npm run typecheck`
Expected: 無錯誤。

```bash
git add -A server/src server/tests shared/src
git commit -m "$(cat <<'EOF'
refactor(agent): 寫入工具改走通用確認機制，email 遷移

寫入工具（effect 非 read）在 agent 只建 pendingAction 並回傳確認卡片視圖，
確認後由後端以當下權限執行；過期、取消或非確認輪即失效。email.propose 與
pendingEmail 移除，email.send 改為暴露給 Agent 的寫入工具。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4：確認／取消端點

**Files:**
- Modify: `server/src/modules/conversation/conversation.schema.ts`
- Modify: `server/src/modules/conversation/conversation.service.ts`
- Modify: `server/src/modules/conversation/conversation.controller.ts`
- Modify: `server/src/modules/conversation/conversation.routes.ts`
- Modify: `server/src/modules/docs/openapi.ts`
- Test: `server/tests/conversation-actions.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `runConfirmedAction`、`cancelPendingAction`；Task 2 的 `isPendingActionExpired`
- Produces:
  - `actionParamSchema`（`id`: uuid、`actionId`: uuid）
  - `interface ActionTurnResult extends TurnResult { actionOk: boolean }`
  - `conversationService.confirmAction(tenantId, userId, id, actionId): Promise<ActionTurnResult>`
  - `conversationService.cancelAction(tenantId, userId, id, actionId): TurnResult`
  - HTTP：`POST /api/conversations/:id/actions/:actionId/confirm`、`.../cancel`，回 `{ data: ActionTurnResult | TurnResult }`；錯誤 `409 ACTION_NOT_FOUND`、`409 ACTION_EXPIRED`、`403 FORBIDDEN`

- [ ] **Step 1：寫失敗測試**

`server/tests/conversation-actions.test.ts`：

```ts
/** 確認卡片端點：確認才執行、一次性、過期/不符 409、權限撤銷 403、取消不執行。 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { createPendingAction } from '@/modules/conversation/pending-action';
import { makeToolContext, registerTool, toolRegistry } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const calls: unknown[] = [];

registerTool({
  id: 'test.actionWrite',
  description: '測試寫入',
  confirmTitle: '測試動作',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', title: '備註' } },
    required: ['note'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  agentExposed: true,
  effect: 'write',
  handler: async (input) => {
    calls.push(input);
    return { done: true };
  },
});

async function loginToken(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

async function seedPending(token: string, now = Date.now()): Promise<{ convId: string; actionId: string }> {
  const start = await request(app).post('/api/conversations').set('Authorization', `Bearer ${token}`).send({});
  expect(start.status).toBe(201);
  const convId = start.body.data.id as string;
  const session = conversationStore.get(convId, 'default', 'kevin');
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: '要執行嗎？' }] });
  const tool = toolRegistry.resolve('test.actionWrite', makeToolContext({ tenantId: 'default', userId: 'kevin' }));
  session.pendingAction = createPendingAction(tool, { note: 'hello' }, now);
  conversationStore.save(session);
  return { convId, actionId: session.pendingAction.id };
}

function confirm(token: string, convId: string, actionId: string) {
  return request(app).post(`/api/conversations/${convId}/actions/${actionId}/confirm`).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  calls.length = 0;
  tenantStore.updateTenant('default', { grantedScopes: ['email:write'] });
});

describe('確認卡片端點', () => {
  it('確認 → 執行一次、回覆已完成、清除待確認動作', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain('已完成「測試動作」');
    expect(res.body.data.actionOk).toBe(true);
    expect(calls).toEqual([{ note: 'hello' }]);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('同時送出兩次確認 → 只執行一次，另一次 409', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const [a, b] = await Promise.all([confirm(token, convId, actionId), confirm(token, convId, actionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
  });

  it('actionId 不符 → 409 ACTION_NOT_FOUND、不執行', async () => {
    const token = await loginToken();
    const { convId } = await seedPending(token);
    const res = await confirm(token, convId, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTION_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('已過期 → 409 ACTION_EXPIRED、不執行、清除', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token, Date.now() - 11 * 60 * 1000);
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTION_EXPIRED');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('確認前權限被撤銷 → 403、不執行', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    tenantStore.updateTenant('default', { grantedScopes: [] });
    const res = await confirm(token, convId, actionId);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('取消 → 200、不執行、清除', async () => {
    const token = await loginToken();
    const { convId, actionId } = await seedPending(token);
    const res = await request(app)
      .post(`/api/conversations/${convId}/actions/${actionId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain('已取消「測試動作」');
    expect(calls).toHaveLength(0);
    expect(conversationStore.get(convId, 'default', 'kevin').pendingAction).toBeUndefined();
  });

  it('未帶 token → 401', async () => {
    const res = await request(app).post('/api/conversations/00000000-0000-4000-8000-000000000000/actions/00000000-0000-4000-8000-000000000000/confirm');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/conversation-actions.test.ts`
Expected: FAIL，端點回 404。

- [ ] **Step 3：schema、service、controller、routes**

`conversation.schema.ts` 在 `idParamSchema` 定義之後加：

```ts
export const actionParamSchema = idParamSchema.extend({
  actionId: z.string().uuid(),
});
```

`conversation.service.ts`：
- import 區加入：

```ts
import { isPendingActionExpired } from './pending-action';
import { cancelPendingAction, runConfirmedAction } from './pending-action.service';
```

- 在 `UpdateFieldsResult` 介面之後加：

```ts
export interface ActionTurnResult extends TurnResult {
  /** 確認後的執行結果是否成功（失敗時 reply 帶原因） */
  actionOk: boolean;
}
```

- 在 `conversationService` 物件中、`submit` 方法之後加入：

```ts
  /**
   * 確認卡片按「確認」（不經 LLM）：比對動作 id 與效期，先清除再執行（一次性，擋雙擊與重送），
   * 執行時重新解析權限；權限已撤銷回 403。
   */
  async confirmAction(tenantId: string, userId: string, id: string, actionId: string): Promise<ActionTurnResult> {
    const session = conversationStore.get(id, tenantId, userId);
    const action = session.pendingAction;
    if (!action || action.id !== actionId) {
      throw new AppError(409, 'ACTION_NOT_FOUND', '這個動作已不存在或已處理過');
    }
    session.pendingAction = undefined;
    if (isPendingActionExpired(action)) {
      conversationStore.save(session);
      throw new AppError(409, 'ACTION_EXPIRED', '這個動作已逾時失效，請重新提出');
    }
    conversationStore.save(session);
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '確認' }] });
    const outcome = await runConfirmedAction(session, action);
    conversationStore.save(session);
    if (!outcome.ok && outcome.code === 'FORBIDDEN') throw AppError.forbidden(outcome.reply);
    return {
      reply: outcome.reply,
      status: session.status,
      values: session.values,
      submission: session.submission,
      suggestions: [],
      actionOk: outcome.ok,
    };
  },

  /** 確認卡片按「取消」：清除待確認動作，不執行。 */
  cancelAction(tenantId: string, userId: string, id: string, actionId: string): TurnResult {
    const session = conversationStore.get(id, tenantId, userId);
    if (!session.pendingAction || session.pendingAction.id !== actionId) {
      throw new AppError(409, 'ACTION_NOT_FOUND', '這個動作已不存在或已處理過');
    }
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '取消' }] });
    const reply = cancelPendingAction(session);
    conversationStore.save(session);
    return { reply, status: session.status, values: session.values, submission: session.submission, suggestions: [] };
  },
```

`conversation.controller.ts`：在 `conversationController` 物件的 `submit` 方法之後加入：

```ts
  /** 確認卡片「確認」（不經 LLM） */
  async confirmAction(req: Request, res: Response): Promise<void> {
    const turn = await conversationService.confirmAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      String(req.params.actionId),
    );
    res.status(200).json({ data: turn });
  },

  /** 確認卡片「取消」 */
  async cancelAction(req: Request, res: Response): Promise<void> {
    const turn = conversationService.cancelAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      String(req.params.actionId),
    );
    res.status(200).json({ data: turn });
  },
```

`conversation.routes.ts`：import 區把 schema 匯入補上 `actionParamSchema`；在 `/:id/cancel` 路由之後加：

```ts
// 寫入動作確認卡片（不經 LLM）：確認才由後端執行；取消即作廢
router.post(
  '/:id/actions/:actionId/confirm',
  validate({ params: actionParamSchema }),
  asyncHandler(conversationController.confirmAction),
);

router.post(
  '/:id/actions/:actionId/cancel',
  validate({ params: actionParamSchema }),
  asyncHandler(conversationController.cancelAction),
);
```

- [ ] **Step 4：OpenAPI**

`server/src/modules/docs/openapi.ts` 在 `"/api/conversations/{id}/submit": {...},` 之後加：

```ts
    "/api/conversations/{id}/actions/{actionId}/confirm": {
      post: {
        tags: ["conversations"],
        summary: "確認執行待確認的寫入動作（不經 LLM）",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "actionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "已執行（data.actionOk 表示成功與否）" },
          "403": { description: "權限已撤銷" },
          "409": { description: "ACTION_NOT_FOUND 或 ACTION_EXPIRED" },
        },
      },
    },
    "/api/conversations/{id}/actions/{actionId}/cancel": {
      post: {
        tags: ["conversations"],
        summary: "取消待確認的寫入動作",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "actionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "已取消" },
          "409": { description: "ACTION_NOT_FOUND" },
        },
      },
    },
```

- [ ] **Step 5：確認測試通過**

Run: `cd server && npx jest tests/conversation-actions.test.ts`
Expected: PASS。

- [ ] **Step 6：型別檢查與 commit**

Run: `cd server && npm run typecheck`
Expected: 無錯誤。

```bash
git add server/src/modules/conversation server/src/modules/docs/openapi.ts server/tests/conversation-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(conversation): 新增寫入動作確認與取消端點

POST /conversations/:id/actions/:actionId/confirm|cancel，不經 LLM。先清除再執行
擋雙擊與重送；過期或 id 不符回 409，權限撤銷回 403。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5：MCP server 登記資料（型別、store、資料表）

**Files:**
- Create: `server/src/modules/mcp/mcp.types.ts`
- Create: `server/src/modules/mcp/mcp.store.ts`
- Create: `server/db/migrations/0019_mcp_servers.sql`
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/index.ts`
- Modify: `server/src/modules/admin/admin.controller.ts:224`（租戶刪除級聯）
- Test: `server/tests/mcp-store.test.ts`

**Interfaces:**
- Produces（`mcp.types.ts`）：
  - `MCP_SERVER_ID_RE = /^[a-z0-9-]{1,32}$/`、`MCP_DEFAULT_TIMEOUT_MS = 20000`
  - `interface McpToolOverride { disabled?: boolean; requireConfirm?: boolean; cardTitle?: string }`
  - `interface McpServerConfig { id; name; url; ownerTenantId: string | null; description: string; keywords: string[]; timeoutMs: number; enabled: boolean; toolOverrides: Record<string, McpToolOverride>; auth: { mode: 'hyagent-jwt' }; createdAt: string; updatedAt?: string }`
  - `type McpServerCreateInput`、`type McpServerPatch`
- Produces（`mcp.store.ts`）：`mcpStore.{list, get, listVisibleTo, belongsTo, create, update, remove, purgeTenant, clear}`、`initMcpStore(): Promise<void>`

- [ ] **Step 1：寫失敗測試**

`server/tests/mcp-store.test.ts`：

```ts
/** MCP server 登記 store（file 後端）：建立驗證、可見性（共用/專屬/停用）、更新、刪除、租戶級聯。 */
import { mcpStore } from '@/modules/mcp/mcp.store';

afterEach(() => mcpStore.clear());

describe('mcpStore', () => {
  it('建立：補預設值', () => {
    const s = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://localhost:4100/mcp' });
    expect(s).toMatchObject({
      id: 'rooms',
      ownerTenantId: null,
      description: '',
      keywords: [],
      timeoutMs: 20000,
      enabled: true,
      toolOverrides: {},
      auth: { mode: 'hyagent-jwt' },
    });
    expect(mcpStore.get('rooms')?.name).toBe('會議室');
  });

  it.each(['Rooms', 'rooms_x', 'rooms.x', '', 'a'.repeat(33)])('serverId「%s」不合法 → 400', (id) => {
    expect(() => mcpStore.create({ id, name: 'x', url: 'http://x/mcp' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('重複 id → 409', () => {
    mcpStore.create({ id: 'rooms', name: 'x', url: 'http://x/mcp' });
    expect(() => mcpStore.create({ id: 'rooms', name: 'y', url: 'http://y/mcp' })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('可見性：共用給所有租戶、專屬只給擁有者、停用者不列出', () => {
    mcpStore.create({ id: 'shared', name: 's', url: 'http://s/mcp' });
    mcpStore.create({ id: 'only-a', name: 'a', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    mcpStore.create({ id: 'off', name: 'o', url: 'http://o/mcp', enabled: false });
    expect(mcpStore.listVisibleTo('tenant-a').map((s) => s.id).sort()).toEqual(['only-a', 'shared']);
    expect(mcpStore.listVisibleTo('tenant-b').map((s) => s.id)).toEqual(['shared']);
    expect(mcpStore.belongsTo(mcpStore.get('off')!, 'tenant-b')).toBe(true);
    expect(mcpStore.belongsTo(mcpStore.get('only-a')!, 'tenant-b')).toBe(false);
  });

  it('更新：合併欄位並記錄 updatedAt；查無 → 404', () => {
    mcpStore.create({ id: 'rooms', name: 'x', url: 'http://x/mcp' });
    const s = mcpStore.update('rooms', { keywords: ['會議室'], toolOverrides: { rooms_book: { cardTitle: '預約' } } });
    expect(s.keywords).toEqual(['會議室']);
    expect(s.toolOverrides.rooms_book.cardTitle).toBe('預約');
    expect(s.updatedAt).toBeTruthy();
    expect(() => mcpStore.update('none', { name: 'z' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('刪除與租戶級聯', () => {
    mcpStore.create({ id: 'a1', name: 'a', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    mcpStore.create({ id: 'shared', name: 's', url: 'http://s/mcp' });
    expect(mcpStore.remove('shared')).toBe(true);
    expect(mcpStore.remove('shared')).toBe(false);
    mcpStore.purgeTenant('tenant-a');
    expect(mcpStore.list()).toEqual([]);
  });
});
```

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/mcp-store.test.ts`
Expected: FAIL，`Cannot find module '@/modules/mcp/mcp.store'`。

- [ ] **Step 3：型別**

`server/src/modules/mcp/mcp.types.ts`：

```ts
/**
 * MCP server 登記資料。由平台管理員於後台登記；ownerTenantId 為 null 代表共用，
 * 有值代表該租戶專屬（其他租戶看不到、也無法被授權）。
 */
export const MCP_SERVER_ID_RE = /^[a-z0-9-]{1,32}$/;
export const MCP_DEFAULT_TIMEOUT_MS = 20_000;

export interface McpToolOverride {
  /** 不暴露此工具 */
  disabled?: boolean;
  /** 強制視為寫入（需使用者確認） */
  requireConfirm?: boolean;
  /** 確認卡片標題 */
  cardTitle?: string;
}

export interface McpServerConfig {
  /** serverId：小寫英數與連字號，不可含 _ 或 .（LLM 工具名 mcp_<serverId>_<tool> 才能唯一切分） */
  id: string;
  name: string;
  /** Streamable HTTP 端點 */
  url: string;
  ownerTenantId: string | null;
  /** 能力描述：進 agent 路由意圖與系統提示詞 */
  description: string;
  /** 路由關鍵字（0-token 命中 agent） */
  keywords: string[];
  timeoutMs: number;
  enabled: boolean;
  /** 以 MCP 工具名為 key */
  toolOverrides: Record<string, McpToolOverride>;
  /** 預留 'user-oauth'（非 v1） */
  auth: { mode: 'hyagent-jwt' };
  createdAt: string;
  updatedAt?: string;
}

export type McpServerCreateInput = Pick<McpServerConfig, 'id' | 'name' | 'url'> &
  Partial<Pick<McpServerConfig, 'ownerTenantId' | 'description' | 'keywords' | 'timeoutMs' | 'enabled' | 'toolOverrides'>>;

export type McpServerPatch = Partial<Omit<McpServerCreateInput, 'id'>>;
```

- [ ] **Step 4：store**

`server/src/modules/mcp/mcp.store.ts`：

```ts
/**
 * MCP server 登記 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND），寫法同 webhook.store。
 * db 後端：每 server 一列（data jsonb 整包）；開機由 initMcpStore() 載回。
 * 不存任何憑證：呼叫身分由後端每請求簽發 JWT（見 mcp.identity）。
 */
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_SERVER_ID_RE,
  type McpServerConfig,
  type McpServerCreateInput,
  type McpServerPatch,
} from './mcp.types';

const STORE_FILE = dataFile('oa-agent-mcp-servers.json');
const servers = new Map<string, McpServerConfig>();
const writeQueue = new DbWriteQueue('mcp-servers');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...servers.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist mcp servers');
  }
}

function upsertToDb(s: McpServerConfig): void {
  const data = JSON.parse(JSON.stringify(s)) as Prisma.InputJsonValue;
  const row = { id: s.id, ownerTenantId: s.ownerTenantId, data, createdAt: new Date(s.createdAt) };
  writeQueue.enqueue(async (db) => {
    await db.mcpServerRow.upsert({ where: { id: row.id }, create: row, update: { ownerTenantId: row.ownerTenantId, data } });
  });
}

function deleteFromDb(where: { id: string } | { ownerTenantId: string }): void {
  writeQueue.enqueue(async (db) => {
    await db.mcpServerRow.deleteMany({ where });
  });
}

function save(s: McpServerConfig): void {
  servers.set(s.id, s);
  if (env.DATA_BACKEND === 'db') upsertToDb(s);
  else persistFile();
}

// file 後端：模組載入即同步還原
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as McpServerConfig[];
      for (const s of raw) servers.set(s.id, s);
      logger.info({ count: servers.size }, 'mcp servers restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore mcp servers; starting empty');
  }
}

/** db 後端的開機載入；file 後端為 no-op。必須在開始服務請求前 await。 */
export async function initMcpStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.mcpServerRow.findMany();
  for (const r of rows) {
    const s = r.data as unknown as McpServerConfig;
    servers.set(s.id, s);
  }
  logger.info({ count: servers.size }, 'mcp servers restored from db');
}

export const mcpStore = {
  list(): McpServerConfig[] {
    return [...servers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  get(id: string): McpServerConfig | undefined {
    return servers.get(id);
  },

  /** 此 server 是否屬於此租戶可見範圍（共用或其專屬），不看啟用狀態——授權驗證用。 */
  belongsTo(s: McpServerConfig, tenantId: string): boolean {
    return s.ownerTenantId === null || s.ownerTenantId === tenantId;
  },

  /** 此租戶可用的 server：已啟用，且共用或屬於該租戶。 */
  listVisibleTo(tenantId: string): McpServerConfig[] {
    return this.list().filter((s) => s.enabled && this.belongsTo(s, tenantId));
  },

  create(input: McpServerCreateInput): McpServerConfig {
    if (!MCP_SERVER_ID_RE.test(input.id)) {
      throw AppError.badRequest(`serverId 只允許小寫英數與連字號、1–32 字：${input.id}`);
    }
    if (servers.has(input.id)) throw AppError.conflict(`serverId 已存在：${input.id}`);
    const s: McpServerConfig = {
      id: input.id,
      name: input.name,
      url: input.url,
      ownerTenantId: input.ownerTenantId ?? null,
      description: input.description ?? '',
      keywords: input.keywords ?? [],
      timeoutMs: input.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
      enabled: input.enabled ?? true,
      toolOverrides: input.toolOverrides ?? {},
      auth: { mode: 'hyagent-jwt' },
      createdAt: new Date().toISOString(),
    };
    save(s);
    return s;
  },

  update(id: string, patch: McpServerPatch): McpServerConfig {
    const cur = servers.get(id);
    if (!cur) throw AppError.notFound(`MCP server 不存在：${id}`);
    const next: McpServerConfig = { ...cur, ...patch, id: cur.id, auth: cur.auth, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
    save(next);
    return next;
  },

  remove(id: string): boolean {
    if (!servers.delete(id)) return false;
    if (env.DATA_BACKEND === 'db') deleteFromDb({ id });
    else persistFile();
    return true;
  },

  /** 刪租戶級聯：移除該租戶專屬的 server */
  purgeTenant(tenantId: string): void {
    for (const [id, s] of servers) {
      if (s.ownerTenantId === tenantId) servers.delete(id);
    }
    if (env.DATA_BACKEND === 'db') deleteFromDb({ ownerTenantId: tenantId });
    else persistFile();
  },

  /** 測試用：清空 */
  clear(): void {
    servers.clear();
    if (env.DATA_BACKEND !== 'db') persistFile();
  },
};
```

- [ ] **Step 5：資料表與 Prisma**

`server/db/migrations/0019_mcp_servers.sql`：

```sql
-- 0019: MCP server 登記（後端 MCP client）。
-- 與 server/prisma/schema.prisma 的 McpServerRow 對應；經 Supabase SQL Editor 套用，必須早於帶此版本部署。
-- 每 server 一列；data = McpServerConfig 整包。owner_tenant_id 為 null 表示共用。
create table if not exists mcp_servers (
  id               text primary key,
  owner_tenant_id  text,
  data             jsonb not null,
  created_at       timestamptz not null
);

create index if not exists mcp_servers_owner_tenant_idx on mcp_servers (owner_tenant_id);
```

`server/prisma/schema.prisma` 在 `model WebhookRow {...}` 之後加：

```prisma
model McpServerRow {
  id            String   @id
  ownerTenantId String?  @map("owner_tenant_id")
  /// 整個 McpServerConfig（url / description / keywords / toolOverrides…）
  data          Json
  createdAt     DateTime @map("created_at")

  @@index([ownerTenantId])
  @@map("mcp_servers")
}
```

Run: `cd server && npm run db:generate`
Expected: `Generated Prisma Client`（只產生 client，不連資料庫）。

- [ ] **Step 6：開機載入與租戶級聯**

`server/src/index.ts`：import 區加 `import { initMcpStore } from '@/modules/mcp/mcp.store';`，並在 `Promise.all([...])` 陣列中 `initWebhookStore(),` 之後加 `initMcpStore(),`。

`server/src/modules/admin/admin.controller.ts`：import 區加 `import { mcpStore } from '@/modules/mcp/mcp.store';`，在 `webhookStore.purgeTenant(id);` 之後加 `mcpStore.purgeTenant(id);`。

- [ ] **Step 7：確認測試通過、型別檢查、commit**

Run: `cd server && npx jest tests/mcp-store.test.ts && npm run typecheck`
Expected: PASS，型別無錯誤。

```bash
git add server/src/modules/mcp server/db/migrations/0019_mcp_servers.sql server/prisma/schema.prisma server/src/index.ts server/src/modules/admin/admin.controller.ts server/tests/mcp-store.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 新增 MCP server 登記資料與 store

McpServerConfig（共用或租戶專屬、能力描述、路由關鍵字、逾時、工具覆寫）；
store 支援 file／db 雙後端，新增 mcp_servers 資料表（0019，需手動先套）；
刪除租戶時級聯移除其專屬 server。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6：呼叫身分 JWT 與 JWKS

**Files:**
- Modify: `server/src/config/env.ts`
- Modify: `server/tests/setup-env.ts`
- Create: `server/src/modules/mcp/mcp.identity.ts`
- Create: `server/src/modules/mcp/mcp.routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/mcp-identity.test.ts`

**Interfaces:**
- Produces:
  - `interface McpCaller { tenantId: string; userId: string; scopes: string[] }`
  - `MCP_TOKEN_ISSUER = 'hyagent'`、`MCP_TOKEN_LIFETIME_SECONDS = 60`、`MCP_SYSTEM_SUBJECT = 'hyagent-system'`
  - `configureMcpSigningKey(pem: string | null): void`（`null` = 改回讀環境變數；測試用）
  - `isMcpSigningEnabled(): boolean`
  - `signMcpToken(serverId: string, caller: McpCaller | 'system', nowMs?: number): string`
  - `mcpJwks(): { keys: Record<string, unknown>[] }`
  - `mcpPublicRouter`（`GET /.well-known/hyagent-mcp-jwks.json`）

- [ ] **Step 1：寫失敗測試**

`server/tests/mcp-identity.test.ts`：

```ts
/** MCP 呼叫 JWT：ES256 可用 JWKS 驗章、claims 正確、scope 只帶本 server、未設金鑰即停用。 */
import { createPublicKey, verify } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { configureMcpSigningKey, isMcpSigningEnabled, mcpJwks, signMcpToken } from '@/modules/mcp/mcp.identity';

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => configureMcpSigningKey(null));

describe('MCP 呼叫身分', () => {
  it('未設金鑰 → 停用、簽發丟錯、JWKS 空', () => {
    expect(isMcpSigningEnabled()).toBe(false);
    expect(() => signMcpToken('rooms', 'system')).toThrow('MCP_SIGNING_KEY');
    expect(mcpJwks().keys).toEqual([]);
  });

  it('非 EC P-256 金鑰 → 設定時丟錯', () => {
    expect(() => configureMcpSigningKey(generateHyAgentKeyPair('RS256').privateKeyPem)).toThrow('ES256');
  });

  it('簽發的 token 可用 JWKS 公鑰驗章，claims 正確', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const now = Date.parse('2026-10-03T00:00:00Z');
    const token = signMcpToken('rooms', { tenantId: 't1', userId: 'kevin', scopes: ['service:agent', 'mcp:rooms', 'mcp:rooms:admin', 'mcp:other'] }, now);
    const [h, p, s] = token.split('.');
    const header = decode(h);
    const payload = decode(p);
    const jwk = mcpJwks().keys[0] as { kid: string };
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: jwk.kid });
    expect(payload).toMatchObject({
      iss: 'hyagent',
      aud: 'rooms',
      sub: 'kevin',
      tenant: 't1',
      scopes: ['mcp:rooms', 'mcp:rooms:admin'],
      iat: now / 1000,
      exp: now / 1000 + 60,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    expect(verify('SHA256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('系統呼叫的 sub 為 hyagent-system、無租戶、無 scope', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const payload = decode(signMcpToken('rooms', 'system').split('.')[1]);
    expect(payload.sub).toBe('hyagent-system');
    expect(payload.tenant).toBeUndefined();
    expect(payload.scopes).toEqual([]);
  });

  it('每次簽發 jti 不同', () => {
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const a = decode(signMcpToken('rooms', 'system').split('.')[1]).jti;
    const b = decode(signMcpToken('rooms', 'system').split('.')[1]).jti;
    expect(a).not.toBe(b);
  });

  it('JWKS 端點：啟用時回公鑰、未啟用 404', async () => {
    const app = createApp();
    expect((await request(app).get('/.well-known/hyagent-mcp-jwks.json')).status).toBe(404);
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
    const res = await request(app).get('/.well-known/hyagent-mcp-jwks.json');
    expect(res.status).toBe(200);
    expect(res.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});
```

- [ ] **Step 2：確認測試失敗**

Run: `cd server && npx jest tests/mcp-identity.test.ts`
Expected: FAIL，`Cannot find module '@/modules/mcp/mcp.identity'`。

- [ ] **Step 3：環境變數**

`server/src/config/env.ts` 的 `envSchema` 中，`OA_API_KEY` 那一行之後加：

```ts
  // MCP 呼叫簽章私鑰（ES256 / PKCS#8 PEM，可用 \n 跳脫換行）；未設＝MCP 功能整體停用
  MCP_SIGNING_KEY: z.string().default(''),
  // 換鑰過渡：上一把公鑰（SPKI PEM），仍列在 JWKS 讓 MCP server 驗得過換鑰前簽的 token
  MCP_PREVIOUS_PUBLIC_KEY: z.string().default(''),
```

`server/tests/setup-env.ts` 檔尾加：

```ts
// MCP 簽章固定關閉：本機 .env 可能有 MCP_SIGNING_KEY；需要的測試以 configureMcpSigningKey 注入
process.env.MCP_SIGNING_KEY ??= '';
process.env.MCP_PREVIOUS_PUBLIC_KEY ??= '';
```

- [ ] **Step 4：實作身分模組與路由**

`server/src/modules/mcp/mcp.identity.ts`：

```ts
/**
 * MCP 呼叫身分：後端每個 HTTP 請求簽一張短效 ES256 JWT，MCP server 以 JWKS 驗章。
 *
 * 與 SSO 的 Identity Assertion 方向相反：這裡是 HyAgent 簽、MCP server 驗，故私鑰在 HyAgent。
 * 簽章重用 lib/assertion 的 JOSE 工具（ES256 需 ieee-p1363 格式）。
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { env } from '@/config/env';
import { ALGORITHMS, encodeJson, keyArg } from '@/lib/assertion/jose';
import { computeKid, detectAlgorithm, exportPublicJwk } from '@/lib/assertion/keygen';

export const MCP_TOKEN_ISSUER = 'hyagent';
export const MCP_TOKEN_LIFETIME_SECONDS = 60;
export const MCP_SYSTEM_SUBJECT = 'hyagent-system';

export interface McpCaller {
  tenantId: string;
  userId: string;
  scopes: string[];
}

interface SigningKey {
  privateKey: KeyObject;
  kid: string;
  jwks: Record<string, unknown>[];
}

/** undefined＝尚未載入；null＝未設定（停用） */
let loaded: SigningKey | null | undefined;

function unescapePem(pem: string): string {
  return pem.replace(/\\n/g, '\n');
}

function publicJwk(key: KeyObject): Record<string, unknown> {
  return { ...exportPublicJwk(key), kid: computeKid(key), alg: 'ES256', use: 'sig' };
}

function load(pem: string, previousPublicPem: string): SigningKey | null {
  if (!pem.trim()) return null;
  const privateKey = createPrivateKey(unescapePem(pem));
  const publicKey = createPublicKey(privateKey);
  if (detectAlgorithm(publicKey) !== 'ES256') throw new Error('MCP_SIGNING_KEY 必須是 EC P-256（ES256）私鑰');
  const jwks = [publicJwk(publicKey)];
  if (previousPublicPem.trim()) jwks.push(publicJwk(createPublicKey(unescapePem(previousPublicPem))));
  return { privateKey, kid: computeKid(publicKey), jwks };
}

function signingKey(): SigningKey | null {
  if (loaded === undefined) loaded = load(env.MCP_SIGNING_KEY, env.MCP_PREVIOUS_PUBLIC_KEY);
  return loaded;
}

/** 測試用：注入私鑰；null 改回讀環境變數。 */
export function configureMcpSigningKey(pem: string | null): void {
  loaded = pem === null ? undefined : load(pem, '');
}

export function isMcpSigningEnabled(): boolean {
  return signingKey() !== null;
}

export function signMcpToken(serverId: string, caller: McpCaller | 'system', nowMs = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error('MCP 簽章金鑰未設定（MCP_SIGNING_KEY）');
  const iat = Math.floor(nowMs / 1000);
  const base = { iss: MCP_TOKEN_ISSUER, aud: serverId, iat, exp: iat + MCP_TOKEN_LIFETIME_SECONDS, jti: randomUUID() };
  const own = `mcp:${serverId}`;
  const payload =
    caller === 'system'
      ? { ...base, sub: MCP_SYSTEM_SUBJECT, scopes: [] as string[] }
      : {
          ...base,
          sub: caller.userId,
          tenant: caller.tenantId,
          // 只帶與本 server 有關的 scope：其他權限不是 MCP server 該知道的事
          scopes: caller.scopes.filter((s) => s === own || s.startsWith(`${own}:`)),
        };
  const signingInput = `${encodeJson({ alg: 'ES256', typ: 'JWT', kid: key.kid })}.${encodeJson(payload)}`;
  const signature = sign(ALGORITHMS.ES256.hash, Buffer.from(signingInput), keyArg(key.privateKey, ALGORITHMS.ES256));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function mcpJwks(): { keys: Record<string, unknown>[] } {
  return { keys: signingKey()?.jwks ?? [] };
}
```

`server/src/modules/mcp/mcp.routes.ts`：

```ts
/** MCP 公開路由：JWKS（MCP server 驗呼叫 JWT 用），不需登入。 */
import { Router } from 'express';
import { mcpJwks } from './mcp.identity';

export const mcpPublicRouter = Router();

mcpPublicRouter.get('/.well-known/hyagent-mcp-jwks.json', (_req, res) => {
  const jwks = mcpJwks();
  if (jwks.keys.length === 0) {
    res.status(404).json({ error: { code: 'MCP_DISABLED', message: 'MCP 簽章未啟用' } });
    return;
  }
  res.set('Cache-Control', 'public, max-age=300').json(jwks);
});
```

`server/src/app.ts`：import 區加 `import { mcpPublicRouter } from '@/modules/mcp/mcp.routes';`，在 `app.use('/api/auth', authRouter);` 之前加：

```ts
  // MCP 呼叫 JWT 的公鑰（MCP server 驗章用；公開、不需登入）
  app.use(mcpPublicRouter);
```

- [ ] **Step 5：確認測試通過、型別檢查、commit**

Run: `cd server && npx jest tests/mcp-identity.test.ts && npm run typecheck`
Expected: PASS，型別無錯誤。

```bash
git add server/src/config/env.ts server/tests/setup-env.ts server/src/modules/mcp/mcp.identity.ts server/src/modules/mcp/mcp.routes.ts server/src/app.ts server/tests/mcp-identity.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 新增 MCP 呼叫身分 JWT 與 JWKS 端點

後端以 MCP_SIGNING_KEY（ES256）每請求簽發 60 秒 JWT（aud=serverId、sub=userId、
tenant、僅帶本 server 的 scope、隨機 jti），公鑰經 /.well-known/hyagent-mcp-jwks.json
公開；未設金鑰時 MCP 功能停用。支援換鑰過渡公鑰。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7：`mcp/kit`（MCP 端驗證套件與範例 server）

**Files:**
- Create: `mcp/kit/package.json`、`mcp/kit/tsconfig.json`、`mcp/kit/README.md`
- Create: `mcp/kit/src/verify.ts`、`mcp/kit/src/middleware.ts`、`mcp/kit/src/app.ts`、`mcp/kit/src/index.ts`
- Create: `mcp/kit/examples/rooms/server.ts`
- Test: `mcp/kit/tests/verify.test.ts`
- Modify: 根 `package.json`（workspaces、scripts）

**Interfaces:**
- Produces（`@hyagent/mcp-kit`）：
  - `interface HyAgentCaller { tenantId: string; userId: string; scopes: string[]; jti: string; system: boolean }`
  - `class HyAgentAuthError extends Error { readonly reason: string }`
  - `interface JwksDocument { keys: Array<Record<string, unknown>> }`
  - `createHyAgentVerifier(opts: { jwksUrl: string; audience: string; issuer?: string; clockSkewSeconds?: number; fetchJwks?: (url: string) => Promise<JwksDocument>; rejectReplay?: boolean; now?: () => number }): HyAgentVerifier`，`HyAgentVerifier { verify(token: string): Promise<HyAgentCaller> }`
  - `requireHyAgent(verifier): express.RequestHandler`（成功時設 `req.auth = { token, clientId: 'hyagent', scopes, extra: { caller } }`）
  - `callerFrom(extra: { authInfo?: AuthInfo }): HyAgentCaller`
  - `createMcpHttpApp(opts: { name: string; version: string; verifier: HyAgentVerifier; register(server: McpServer): void }): express.Express`（`POST /mcp` 無狀態、`GET /healthz`）

- [ ] **Step 1：建立 workspace**

`mcp/kit/package.json`：

```json
{
  "name": "@hyagent/mcp-kit",
  "version": "0.1.0",
  "private": true,
  "description": "自建 MCP server 驗證 HyAgent 呼叫身分（ES256 JWT + JWKS）與無狀態 Streamable HTTP app。",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "example:rooms": "tsx examples/rooms/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.31.0",
    "express": "^4.21.1",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`mcp/kit/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*", "examples/**/*", "tests/**/*"]
}
```

> 刻意不設 `"type": "module"`：與 server 同為 CommonJS，server 的 jest（CJS）與 `tsc`（NodeNext）才能直接引用 kit 原始碼；kit 內部相對 import 不帶副檔名。

根 `package.json`：`workspaces` 陣列在 `"sdk",` 之後加 `"mcp/kit",`；`scripts.typecheck` 結尾加 ` && npm run typecheck -w mcp/kit`；`scripts.test` 結尾加 ` && npm run test -w mcp/kit`。

Run: `npm install`
Expected: 成功；`node_modules/@hyagent/mcp-kit` 為指向 `mcp/kit` 的連結。

- [ ] **Step 2：寫失敗測試**

`mcp/kit/tests/verify.test.ts`：

```ts
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHyAgentVerifier, HyAgentAuthError } from '../src';

const NOW = Date.parse('2026-10-03T00:00:00Z');

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' } };
}

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

function token(privateKey: KeyObject, kid: string, claims: Record<string, unknown> = {}): string {
  const iat = Math.floor(NOW / 1000);
  const payload = { iss: 'hyagent', aud: 'rooms', sub: 'kevin', tenant: 't1', scopes: ['mcp:rooms'], iat, exp: iat + 60, jti: randomUUID(), ...claims };
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid })}.${b64(payload)}`;
  const sig = sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

function verifierFor(keys: Record<string, unknown>[], extra: Partial<Parameters<typeof createHyAgentVerifier>[0]> = {}) {
  let fetches = 0;
  const v = createHyAgentVerifier({
    jwksUrl: 'http://hyagent/.well-known/hyagent-mcp-jwks.json',
    audience: 'rooms',
    fetchJwks: async () => {
      fetches += 1;
      return { keys };
    },
    now: () => NOW,
    ...extra,
  });
  return { v, fetches: () => fetches };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof HyAgentAuthError ? err.reason : `other:${(err as Error).message}`;
  }
}

describe('createHyAgentVerifier', () => {
  const k = keypair('k1');

  it('合法 token → 回呼叫者', async () => {
    const { v } = verifierFor([k.jwk]);
    await expect(v.verify(token(k.privateKey, 'k1'))).resolves.toMatchObject({
      tenantId: 't1',
      userId: 'kevin',
      scopes: ['mcp:rooms'],
      system: false,
    });
  });

  it('系統呼叫 → system=true、userId 空', async () => {
    const { v } = verifierFor([k.jwk]);
    const caller = await v.verify(token(k.privateKey, 'k1', { sub: 'hyagent-system', tenant: undefined, scopes: [] }));
    expect(caller).toMatchObject({ system: true, userId: '', tenantId: '' });
  });

  it.each([
    ['bad_audience', { aud: 'other' }],
    ['bad_issuer', { iss: 'evil' }],
    ['expired', { iat: Math.floor(NOW / 1000) - 200, exp: Math.floor(NOW / 1000) - 100 }],
    ['not_yet_valid', { iat: Math.floor(NOW / 1000) + 100, exp: Math.floor(NOW / 1000) + 160 }],
    ['lifetime_too_long', { exp: Math.floor(NOW / 1000) + 3600 }],
  ])('%s', async (expected, claims) => {
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(k.privateKey, 'k1', claims)))).toBe(expected);
  });

  it('簽章被竄改 → bad_signature', async () => {
    const { v } = verifierFor([k.jwk]);
    const t = token(k.privateKey, 'k1');
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64({ iss: 'hyagent', aud: 'rooms', sub: 'admin', iat: 0, exp: 60, jti: 'x' })}.${s}`;
    expect(await reason(v.verify(forged))).toBe('bad_signature');
  });

  it('別把金鑰簽的 → bad_signature', async () => {
    const other = keypair('k1');
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(other.privateKey, 'k1')))).toBe('bad_signature');
  });

  it('未知 kid → 重抓 JWKS 一次後仍無 → unknown_kid', async () => {
    const { v, fetches } = verifierFor([k.jwk]);
    expect(await reason(v.verify(token(k.privateKey, 'nope')))).toBe('unknown_kid');
    expect(fetches()).toBe(1);
  });

  it('格式錯誤 → malformed', async () => {
    const { v } = verifierFor([k.jwk]);
    expect(await reason(v.verify('abc'))).toBe('malformed');
    expect(await reason(v.verify('a.b.c'))).toBe('malformed');
  });

  it('rejectReplay：同一 jti 第二次 → replayed', async () => {
    const { v } = verifierFor([k.jwk], { rejectReplay: true });
    const t = token(k.privateKey, 'k1');
    await v.verify(t);
    expect(await reason(v.verify(t))).toBe('replayed');
  });

  it('JWKS 快取：連續驗證只抓一次', async () => {
    const { v, fetches } = verifierFor([k.jwk]);
    await v.verify(token(k.privateKey, 'k1'));
    await v.verify(token(k.privateKey, 'k1'));
    expect(fetches()).toBe(1);
  });
});
```

Run: `npm run test -w mcp/kit`
Expected: FAIL，`Cannot find module '../src'`。

- [ ] **Step 3：實作驗證**

`mcp/kit/src/verify.ts`：

```ts
/**
 * 驗證 HyAgent 呼叫 MCP server 時帶的 ES256 JWT。
 * 規則與 HyAgent 端 mcp.identity 一致：iss=hyagent、aud=本 server 的 serverId、效期 ≤ 300 秒。
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

export interface HyAgentCaller {
  tenantId: string;
  userId: string;
  scopes: string[];
  jti: string;
  /** HyAgent 的系統呼叫（如 listTools），不代表任何使用者 */
  system: boolean;
}

export class HyAgentAuthError extends Error {
  constructor(readonly reason: string) {
    super(`HyAgent 呼叫驗證失敗：${reason}`);
    this.name = 'HyAgentAuthError';
  }
}

export interface JwksDocument {
  keys: Array<Record<string, unknown>>;
}

export interface VerifierOptions {
  /** HyAgent 後端的 /.well-known/hyagent-mcp-jwks.json */
  jwksUrl: string;
  /** 本 MCP server 在 HyAgent 登記的 serverId */
  audience: string;
  issuer?: string;
  clockSkewSeconds?: number;
  fetchJwks?: (url: string) => Promise<JwksDocument>;
  /** 拒絕重複的 jti（單一程序內有效） */
  rejectReplay?: boolean;
  now?: () => number;
}

export interface HyAgentVerifier {
  verify(token: string): Promise<HyAgentCaller>;
}

const MAX_LIFETIME_SECONDS = 300;
const JWKS_REFETCH_MIN_INTERVAL_MS = 30_000;
const SYSTEM_SUBJECT = 'hyagent-system';

async function defaultFetchJwks(url: string): Promise<JwksDocument> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS 取得失敗：HTTP ${res.status}`);
  return (await res.json()) as JwksDocument;
}

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

export function createHyAgentVerifier(opts: VerifierOptions): HyAgentVerifier {
  const issuer = opts.issuer ?? 'hyagent';
  const skew = opts.clockSkewSeconds ?? 15;
  const now = opts.now ?? Date.now;
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  let keys = new Map<string, KeyObject>();
  let lastFetch = Number.NEGATIVE_INFINITY;
  const seenJti = new Map<string, number>();

  async function refresh(): Promise<void> {
    const doc = await fetchJwks(opts.jwksUrl);
    const next = new Map<string, KeyObject>();
    for (const jwk of doc.keys) {
      if (typeof jwk.kid === 'string' && jwk.kty === 'EC' && jwk.crv === 'P-256') {
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
      }
    }
    keys = next;
    lastFetch = now();
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    let key = keys.get(kid);
    // 未知 kid 可能是 HyAgent 剛換鑰：限頻重抓一次
    if (!key && now() - lastFetch >= JWKS_REFETCH_MIN_INTERVAL_MS) {
      await refresh();
      key = keys.get(kid);
    }
    if (!key) throw new HyAgentAuthError('unknown_kid');
    return key;
  }

  return {
    async verify(token: string): Promise<HyAgentCaller> {
      const parts = token.split('.');
      if (parts.length !== 3) throw new HyAgentAuthError('malformed');
      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = decodePart(parts[0]);
        payload = decodePart(parts[1]);
      } catch {
        throw new HyAgentAuthError('malformed');
      }
      if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new HyAgentAuthError('bad_header');

      const key = await keyFor(header.kid);
      const ok = verifySignature(
        'SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      );
      if (!ok) throw new HyAgentAuthError('bad_signature');

      if (payload.iss !== issuer) throw new HyAgentAuthError('bad_issuer');
      if (payload.aud !== opts.audience) throw new HyAgentAuthError('bad_audience');
      const { iat, exp, sub, jti } = payload;
      if (typeof iat !== 'number' || typeof exp !== 'number' || typeof sub !== 'string' || typeof jti !== 'string') {
        throw new HyAgentAuthError('bad_claims');
      }
      if (exp - iat > MAX_LIFETIME_SECONDS) throw new HyAgentAuthError('lifetime_too_long');
      const nowSec = Math.floor(now() / 1000);
      if (nowSec > exp + skew) throw new HyAgentAuthError('expired');
      if (iat > nowSec + skew) throw new HyAgentAuthError('not_yet_valid');

      if (opts.rejectReplay) {
        for (const [seen, until] of seenJti) if (until < now()) seenJti.delete(seen);
        if (seenJti.has(jti)) throw new HyAgentAuthError('replayed');
        seenJti.set(jti, (exp + skew) * 1000);
      }

      const system = sub === SYSTEM_SUBJECT;
      return {
        tenantId: typeof payload.tenant === 'string' ? payload.tenant : '',
        userId: system ? '' : sub,
        scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((s): s is string => typeof s === 'string') : [],
        jti,
        system,
      };
    },
  };
}
```

`mcp/kit/src/middleware.ts`：

```ts
/** Express middleware：驗 Bearer JWT，把呼叫者放進 req.auth，MCP SDK 會轉成工具 handler 的 extra.authInfo。 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { HyAgentAuthError, type HyAgentCaller, type HyAgentVerifier } from './verify';

export function requireHyAgent(verifier: HyAgentVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    try {
      const caller = await verifier.verify(token);
      (req as Request & { auth?: AuthInfo }).auth = { token, clientId: 'hyagent', scopes: caller.scopes, extra: { caller } };
      next();
    } catch (err) {
      res.status(401).json({ error: err instanceof HyAgentAuthError ? err.reason : 'verify_failed' });
    }
  };
}

/** 工具 handler 內取得呼叫者：`const caller = callerFrom(extra)`。 */
export function callerFrom(extra: { authInfo?: AuthInfo }): HyAgentCaller {
  const caller = extra.authInfo?.extra?.caller as HyAgentCaller | undefined;
  if (!caller) throw new HyAgentAuthError('no_caller');
  return caller;
}
```

`mcp/kit/src/app.ts`：

```ts
/** 無狀態 Streamable HTTP MCP app：每個請求新建 server + transport，前面掛 HyAgent 驗證。 */
import express, { type Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireHyAgent } from './middleware';
import type { HyAgentVerifier } from './verify';

export interface McpHttpAppOptions {
  name: string;
  version: string;
  verifier: HyAgentVerifier;
  /** 在這裡 server.registerTool(...)；每個請求都會呼叫一次 */
  register(server: McpServer): void;
}

export function createMcpHttpApp(opts: McpHttpAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/mcp', requireHyAgent(opts.verifier), async (req, res) => {
    const server = new McpServer({ name: opts.name, version: opts.version });
    opts.register(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return app;
}
```

`mcp/kit/src/index.ts`：

```ts
export { createHyAgentVerifier, HyAgentAuthError } from './verify';
export type { HyAgentCaller, HyAgentVerifier, JwksDocument, VerifierOptions } from './verify';
export { callerFrom, requireHyAgent } from './middleware';
export { createMcpHttpApp } from './app';
export type { McpHttpAppOptions } from './app';
```

- [ ] **Step 4：確認測試通過**

Run: `npm run test -w mcp/kit && npm run typecheck -w mcp/kit`
Expected: PASS，型別無錯誤。

- [ ] **Step 5：範例 server 與 README**

`mcp/kit/examples/rooms/server.ts`：

```ts
/**
 * 範例：會議室 MCP server（一讀一寫）。示範：
 *  - 欄位一律寫 describe（會成為 HyAgent 確認卡片的標籤）
 *  - 讀工具標 readOnlyHint: true；寫工具不標（HyAgent 視為寫入、需使用者確認）
 *  - 回傳直接回答問題，不要丟整張表讓模型推
 * 執行：HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=rooms PORT=4100 npm run example:rooms -w mcp/kit
 */
import { z } from 'zod';
import { callerFrom, createHyAgentVerifier, createMcpHttpApp } from '../../src';

const ROOMS = ['大會議室 A', '小會議室 B', '視訊室 C'] as const;
const FREE: Record<(typeof ROOMS)[number], string[]> = {
  '大會議室 A': ['09:00-10:00', '14:00-16:00'],
  '小會議室 B': ['10:00-12:00', '15:00-17:00'],
  '視訊室 C': ['13:00-14:00'],
};
const bookings: { id: string; room: string; date: string; start: string; end: string; title: string; by: string }[] = [];

function inPeriod(slot: string, period: 'morning' | 'afternoon' | 'all'): boolean {
  const startHour = Number(slot.slice(0, 2));
  if (period === 'morning') return startHour < 12;
  if (period === 'afternoon') return startHour >= 12;
  return true;
}

const verifier = createHyAgentVerifier({
  jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
  audience: process.env.MCP_SERVER_ID ?? 'rooms',
  rejectReplay: true,
});

const app = createMcpHttpApp({
  name: 'rooms',
  version: '0.1.0',
  verifier,
  register(server) {
    server.registerTool(
      'rooms_availability',
      {
        title: '查詢會議室空檔',
        description: '查詢指定日期、時段（上午／下午／整天）各會議室的空閒時段；有指定會議室時只回該間。',
        inputSchema: {
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('日期（YYYY-MM-DD）'),
          period: z.enum(['morning', 'afternoon', 'all']).default('all').describe('時段'),
          room: z.enum(ROOMS).optional().describe('會議室'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ date, period, room }) => {
        const rooms = room ? [room] : [...ROOMS];
        const available = rooms
          .map((r) => ({ room: r, slots: FREE[r].filter((s) => inPeriod(s, period)) }))
          .filter((r) => r.slots.length > 0);
        const data = { date, period, available, anyAvailable: available.length > 0 };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      },
    );

    server.registerTool(
      'rooms_book',
      {
        title: '預約會議室',
        description: '預約指定會議室的時段。時段必須在該會議室的空閒時段內。',
        inputSchema: {
          room: z.enum(ROOMS).describe('會議室'),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('日期（YYYY-MM-DD）'),
          start: z.string().regex(/^\d{2}:\d{2}$/).describe('開始時間（HH:MM）'),
          end: z.string().regex(/^\d{2}:\d{2}$/).describe('結束時間（HH:MM）'),
          title: z.string().min(1).describe('會議名稱'),
        },
      },
      async ({ room, date, start, end, title }, extra) => {
        const caller = callerFrom(extra);
        const fits = FREE[room].some((slot) => {
          const [s, e] = slot.split('-');
          return start >= s && end <= e && start < end;
        });
        if (!fits) {
          return { isError: true, content: [{ type: 'text', text: `${room} 在 ${date} ${start}-${end} 沒有空` }] };
        }
        const booking = { id: `B-${bookings.length + 1}`, room, date, start, end, title, by: caller.userId };
        bookings.push(booking);
        return { content: [{ type: 'text', text: JSON.stringify(booking) }], structuredContent: booking };
      },
    );
  },
});

const port = Number(process.env.PORT ?? 4100);
app.listen(port, () => console.log(`rooms MCP server on http://localhost:${port}/mcp`));
```

`mcp/kit/README.md`：

````markdown
# @hyagent/mcp-kit

自建 MCP server 讓 HyAgent 的智慧代理呼叫時使用。提供：

- `createHyAgentVerifier`：驗 HyAgent 每請求簽發的 ES256 JWT（JWKS 取自 HyAgent 後端）。
- `createMcpHttpApp`：無狀態 Streamable HTTP app，已掛好驗證；工具 handler 用 `callerFrom(extra)` 取得呼叫者（`tenantId`、`userId`、`scopes`）。

## 寫一個工具的規範

1. **每個欄位都要 `.describe('...')`**：會成為 HyAgent 確認卡片的欄位標籤。
2. **唯讀工具標 `annotations: { readOnlyHint: true }`**；沒標的一律被 HyAgent 視為寫入，使用者確認後才會執行。
3. **回傳直接回答問題**：例如回「某時段是否有空」，不要丟整張表讓模型推論（模型會讀錯）。
4. **失敗回 `isError: true`** 並在文字裡說明原因，HyAgent 會讓 AI 如實轉述。
5. **用 `callerFrom(extra)` 做二次權限檢查與稽核**：知道是誰、替哪個租戶操作。

## 範例

```bash
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
MCP_SERVER_ID=rooms PORT=4100 npm run example:rooms -w mcp/kit
```

在 HyAgent 後台「MCP 服務」登記 `serverId=rooms`、URL `http://localhost:4100/mcp`，並把 `mcp:rooms` 授予要使用的部門或帳號。
````

- [ ] **Step 6：commit**

```bash
git add mcp/kit package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(mcp-kit): 新增自建 MCP server 的驗證套件與範例

createHyAgentVerifier 驗 ES256 JWT（JWKS 快取、未知 kid 限頻重抓、aud／iss／效期／
防重送）；createMcpHttpApp 提供無狀態 Streamable HTTP app 並把呼叫者帶進工具
handler。附會議室範例（一讀一寫）與撰寫規範。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8：MCP 連線管理

**Files:**
- Modify: `server/package.json`（`dependencies` 加 `"@modelcontextprotocol/sdk": "1.31.0"`；`devDependencies` 加 `"@hyagent/mcp-kit": "*"`）
- Modify: `server/jest.config.js`（`moduleNameMapper`）
- Create: `server/tests/helpers/mcp-fixture.ts`
- Create: `server/src/modules/mcp/mcp.connection.ts`
- Test: `server/tests/mcp-connection.test.ts`

**Interfaces:**
- Consumes: Task 5 `McpServerConfig`；Task 6 `signMcpToken`、`McpCaller`、`configureMcpSigningKey`、`mcpJwks`；Task 7 kit
- Produces:
  - `MCP_TOOLS_TTL_MS = 600000`、`MCP_LIST_TIMEOUT_MS = 10000`、`MCP_RESULT_MAX_CHARS = 16000`
  - `interface McpRemoteTool { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }`
  - `type McpConnectionState = 'idle' | 'ok' | 'unreachable' | 'auth_failed'`
  - `interface McpServerStatus { state: McpConnectionState; lastError?: string; lastOkAt?: string; toolsFetchedAt?: string; retryAt?: string }`
  - `class McpToolCallError extends Error`
  - `normalizeToolResult(res: { structuredContent?: unknown; content?: unknown }): unknown`
  - `class McpConnection { config: McpServerConfig; status(): McpServerStatus; cachedTools(): McpRemoteTool[] | undefined; listTools(opts?: { force?: boolean }): Promise<McpRemoteTool[]>; callTool(name: string, args: Record<string, unknown>, caller: McpCaller): Promise<unknown>; close(): Promise<void> }`
  - `mcpConnections.{ get(config): McpConnection; peek(id): McpConnection | undefined; drop(id): Promise<void>; closeAll(): Promise<void> }`
  - 測試 fixture：`startMcpFixture(serverId: string, opts?: { slowMs?: number; jwks?: () => { keys: Record<string, unknown>[] } }): Promise<McpFixture>`，`McpFixture { url; calls: { tool: string; args: unknown; caller: HyAgentCaller }[]; bookings: { room: string; caller: HyAgentCaller }[]; close(): Promise<void> }`

- [ ] **Step 1：依賴與 jest 對應**

`server/package.json` 依 Interfaces 加入兩個依賴，然後：

Run: `npm install`
Expected: 成功。

`server/jest.config.js` 的 `moduleNameMapper` 加一列：

```js
    '^@hyagent/mcp-kit$': '<rootDir>/../mcp/kit/src/index.ts',
```

- [ ] **Step 2：確認 MCP SDK 能在 jest（CJS）中載入**

建立暫時檔 `server/tests/mcp-sdk-load.test.ts`：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpApp } from '@hyagent/mcp-kit';

it('MCP SDK 與 kit 可在 jest 載入', () => {
  expect(typeof Client).toBe('function');
  expect(typeof StreamableHTTPClientTransport).toBe('function');
  expect(typeof createMcpHttpApp).toBe('function');
});
```

Run: `cd server && npx jest tests/mcp-sdk-load.test.ts`
Expected: PASS。

若失敗訊息是某個 ESM-only 依賴無法 `require`（例如 `pkce-challenge`，只有 client 的 OAuth 流程會用到），在 `server/jest.config.js` 的 `moduleNameMapper` 加 `'^pkce-challenge$': '<rootDir>/tests/helpers/pkce-challenge-stub.ts'`，並建立該檔：

```ts
/** 測試替身：MCP SDK 的 OAuth 流程才會用到 pkce-challenge（ESM-only），本專案不走該流程。 */
export default async function pkceChallenge(): Promise<{ code_verifier: string; code_challenge: string }> {
  throw new Error('pkce-challenge stub：測試環境不支援 MCP OAuth 流程');
}
```

重跑直到 PASS，然後刪除 `server/tests/mcp-sdk-load.test.ts`。

- [ ] **Step 3：測試 fixture**

`server/tests/helpers/mcp-fixture.ts`：

```ts
/**
 * 測試用 MCP server：以 @hyagent/mcp-kit 組成，用後端自己的 JWKS 驗章（不走網路抓 JWKS）。
 * 記錄每次呼叫的工具、參數與呼叫者，供斷言「身分有傳到」「寫入只在確認後發生」。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { callerFrom, createHyAgentVerifier, createMcpHttpApp, type HyAgentCaller } from '@hyagent/mcp-kit';
import { mcpJwks } from '@/modules/mcp/mcp.identity';

export interface McpFixture {
  url: string;
  calls: { tool: string; args: unknown; caller: HyAgentCaller }[];
  bookings: { room: string; caller: HyAgentCaller }[];
  close(): Promise<void>;
}

export async function startMcpFixture(
  serverId: string,
  opts: { slowMs?: number; jwks?: () => { keys: Record<string, unknown>[] } } = {},
): Promise<McpFixture> {
  const calls: McpFixture['calls'] = [];
  const bookings: McpFixture['bookings'] = [];
  const verifier = createHyAgentVerifier({
    jwksUrl: 'http://unused.invalid/jwks',
    audience: serverId,
    fetchJwks: async () => (opts.jwks ?? mcpJwks)(),
    rejectReplay: true,
  });
  const app = createMcpHttpApp({
    name: `fixture-${serverId}`,
    version: '0.0.1',
    verifier,
    register(server) {
      server.registerTool(
        'rooms_availability',
        {
          title: '查詢會議室空檔',
          description: '查詢某會議室某日是否有空',
          inputSchema: { date: z.string().describe('日期'), room: z.string().describe('會議室') },
          annotations: { readOnlyHint: true },
        },
        async (args, extra) => {
          calls.push({ tool: 'rooms_availability', args, caller: callerFrom(extra) });
          const data = { room: args.room, date: args.date, free: ['14:00-16:00'] };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        },
      );
      server.registerTool(
        'rooms_book',
        {
          title: '預約會議室',
          description: '預約會議室',
          inputSchema: { room: z.string().describe('會議室'), date: z.string().describe('日期') },
        },
        async (args, extra) => {
          const caller = callerFrom(extra);
          calls.push({ tool: 'rooms_book', args, caller });
          bookings.push({ room: args.room, caller });
          const data = { bookingId: `B-${bookings.length}` };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        },
      );
      server.registerTool(
        'slow_tool',
        { description: '很慢的工具', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, opts.slowMs ?? 0));
          return { content: [{ type: 'text', text: 'done' }] };
        },
      );
      server.registerTool(
        'broken_tool',
        { description: '一定失敗', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => ({ isError: true, content: [{ type: 'text', text: '下游系統錯誤' }] }),
      );
    },
  });
  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    bookings,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 4：寫失敗測試**

`server/tests/mcp-connection.test.ts`：

```ts
/** MCP 連線：listTools 快取、身分傳遞、結果正規化、逾時不視為斷線、斷線退避、驗證失敗狀態。 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { McpConnection, McpToolCallError, normalizeToolResult, MCP_RESULT_MAX_CHARS } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey, mcpJwks } from '@/modules/mcp/mcp.identity';
import type { McpServerConfig } from '@/modules/mcp/mcp.types';
import { startMcpFixture, type McpFixture } from './helpers/mcp-fixture';

function config(url: string, partial: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'rooms', name: '會議室', url, ownerTenantId: null, description: '', keywords: [],
    timeoutMs: 20000, enabled: true, toolOverrides: {}, auth: { mode: 'hyagent-jwt' },
    createdAt: new Date().toISOString(), ...partial,
  };
}

const caller = { tenantId: 't1', userId: 'kevin', scopes: ['mcp:rooms', 'service:agent'] };
let fixture: McpFixture;
let conn: McpConnection | undefined;

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  fixture = await startMcpFixture('rooms', { slowMs: 500 });
});

afterEach(async () => {
  await conn?.close();
  conn = undefined;
  await fixture.close();
  configureMcpSigningKey(null);
});

describe('McpConnection', () => {
  it('listTools：回工具與標註，狀態 ok，第二次走快取', async () => {
    conn = new McpConnection(config(fixture.url));
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['broken_tool', 'rooms_availability', 'rooms_book', 'slow_tool']);
    expect(tools.find((t) => t.name === 'rooms_availability')?.annotations?.readOnlyHint).toBe(true);
    expect(conn.status().state).toBe('ok');
    expect(conn.cachedTools()).toBe(tools);
    expect(await conn.listTools()).toBe(tools);
  });

  it('callTool：身分傳到 MCP server、回 structuredContent', async () => {
    conn = new McpConnection(config(fixture.url));
    const out = await conn.callTool('rooms_availability', { date: '2026-10-03', room: 'A' }, caller);
    expect(out).toEqual({ room: 'A', date: '2026-10-03', free: ['14:00-16:00'] });
    expect(fixture.calls[0].caller).toMatchObject({ tenantId: 't1', userId: 'kevin', scopes: ['mcp:rooms'], system: false });
  });

  it('工具回 isError → McpToolCallError，連線狀態仍 ok', async () => {
    conn = new McpConnection(config(fixture.url));
    await expect(conn.callTool('broken_tool', {}, caller)).rejects.toThrow('下游系統錯誤');
    expect(conn.status().state).toBe('ok');
  });

  it('逾時 → McpToolCallError，但不把 server 標成斷線', async () => {
    conn = new McpConnection(config(fixture.url, { timeoutMs: 100 }));
    await conn.listTools(); // 先建立正常連線，狀態才會是 ok
    await expect(conn.callTool('slow_tool', {}, caller)).rejects.toBeInstanceOf(McpToolCallError);
    expect(conn.status().state).toBe('ok');
  });

  it('server 關閉 → unreachable、設定 retryAt、退避期間快速失敗且不暴露工具', async () => {
    conn = new McpConnection(config(fixture.url));
    await conn.listTools();
    await fixture.close();
    await conn.close();
    await expect(conn.listTools({ force: true })).rejects.toBeTruthy();
    const st = conn.status();
    expect(st.state).toBe('unreachable');
    expect(st.retryAt).toBeTruthy();
    expect(conn.cachedTools()).toBeUndefined();
    await expect(conn.listTools()).rejects.toThrow('暫時無法連線');
    fixture = await startMcpFixture('rooms');
  });

  it('MCP 端只認得舊公鑰（後端已換鑰）→ auth_failed', async () => {
    await fixture.close();
    const staleJwks = mcpJwks(); // beforeEach 那把的公鑰
    configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem); // 後端換成新鑰
    fixture = await startMcpFixture('rooms', { jwks: () => staleJwks });
    conn = new McpConnection(config(fixture.url));
    await expect(conn.listTools()).rejects.toBeTruthy();
    expect(conn.status().state).toBe('auth_failed');
  });
});

describe('normalizeToolResult', () => {
  it('優先 structuredContent，否則串接 text', () => {
    expect(normalizeToolResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(normalizeToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  });

  it('超過上限截斷並註明', () => {
    const out = normalizeToolResult({ content: [{ type: 'text', text: 'x'.repeat(MCP_RESULT_MAX_CHARS + 10) }] }) as string;
    expect(out.startsWith('x'.repeat(MCP_RESULT_MAX_CHARS))).toBe(true);
    expect(out).toContain('已截斷');
  });
});
```

Run: `cd server && npx jest tests/mcp-connection.test.ts`
Expected: FAIL，`Cannot find module '@/modules/mcp/mcp.connection'`。

- [ ] **Step 5：實作連線模組**

`server/src/modules/mcp/mcp.connection.ts`：

```ts
/**
 * MCP 連線：每個 server 一條，延遲建立、跨租戶共用（身分在請求上、不在連線上）。
 *
 * 身分：用 AsyncLocalStorage 把當次呼叫者帶進 transport 的自訂 fetch，每個 HTTP 請求
 * 都以當下呼叫者簽一張新的 JWT（listTools 等系統呼叫用 'system'）。
 * 故障：連線層錯誤標 unreachable／auth_failed 並指數退避，退避期間該 server 的工具不暴露；
 * 單一工具逾時或回 isError 不影響 server 狀態。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@/lib/logger';
import { signMcpToken, type McpCaller } from './mcp.identity';
import type { McpServerConfig } from './mcp.types';

export const MCP_TOOLS_TTL_MS = 10 * 60 * 1000;
export const MCP_LIST_TIMEOUT_MS = 10_000;
export const MCP_RESULT_MAX_CHARS = 16_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type McpConnectionState = 'idle' | 'ok' | 'unreachable' | 'auth_failed';

export interface McpServerStatus {
  state: McpConnectionState;
  lastError?: string;
  lastOkAt?: string;
  toolsFetchedAt?: string;
  retryAt?: string;
}

export class McpToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolCallError';
  }
}

const callerStore = new AsyncLocalStorage<McpCaller | 'system'>();

function truncateText(s: string): string {
  return s.length > MCP_RESULT_MAX_CHARS ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…（結果過長，已截斷）` : s;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: unknown })?.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export function normalizeToolResult(res: { structuredContent?: unknown; content?: unknown }): unknown {
  if (res.structuredContent !== undefined) {
    const s = JSON.stringify(res.structuredContent);
    return s.length > MCP_RESULT_MAX_CHARS ? truncateText(s) : res.structuredContent;
  }
  return truncateText(textOf(res.content));
}

function isTimeout(err: unknown): boolean {
  return (err as { code?: unknown }).code === ErrorCode.RequestTimeout;
}

function isAuthFailure(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  const e = err as Error;
  return code === 401 || code === 403 || e?.name === 'UnauthorizedError' || /\b(401|403)\b/.test(String(e?.message));
}

export class McpConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: McpRemoteTool[] | undefined;
  private toolsAt = 0;
  private failures = 0;
  private st: McpServerStatus = { state: 'idle' };

  constructor(
    public config: McpServerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  status(): McpServerStatus {
    return { ...this.st };
  }

  /** 只有連線正常時回快取；斷線或退避中回 undefined（工具暫不暴露）。 */
  cachedTools(): McpRemoteTool[] | undefined {
    return this.st.state === 'ok' ? this.tools : undefined;
  }

  async listTools(opts: { force?: boolean } = {}): Promise<McpRemoteTool[]> {
    if (!opts.force) {
      if (this.tools && this.st.state === 'ok' && this.now() - this.toolsAt < MCP_TOOLS_TTL_MS) return this.tools;
      this.assertNotBackingOff();
    }
    try {
      const client = await this.ensureClient();
      const res = await callerStore.run('system', () => client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS }));
      this.tools = res.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations,
      }));
      this.toolsAt = this.now();
      this.markOk();
      this.st.toolsFetchedAt = new Date(this.toolsAt).toISOString();
      return this.tools;
    } catch (err) {
      await this.markFailed(err);
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, caller: McpCaller): Promise<unknown> {
    this.assertNotBackingOff();
    let res: { isError?: boolean; structuredContent?: unknown; content?: unknown };
    try {
      const client = await this.ensureClient();
      res = await callerStore.run(caller, () =>
        client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs }),
      );
      this.markOk();
    } catch (err) {
      if (isTimeout(err)) throw new McpToolCallError(`${this.config.name} 回應逾時，請稍後再試`);
      await this.markFailed(err);
      throw new McpToolCallError(`${this.config.name} 暫時無法使用：${(err as Error).message}`);
    }
    if (res.isError) throw new McpToolCallError(textOf(res.content) || `${this.config.name} 回傳錯誤`);
    return normalizeToolResult(res);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }

  private assertNotBackingOff(): void {
    if (this.st.retryAt && this.now() < Date.parse(this.st.retryAt)) {
      throw new McpToolCallError(`${this.config.name} 暫時無法連線`);
    }
  }

  private readonly signedFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${signMcpToken(this.config.id, callerStore.getStore() ?? 'system')}`);
    return fetch(url, { ...init, headers });
  };

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: 'hyagent', version: '1.2.0' });
        const transport = new StreamableHTTPClientTransport(new URL(this.config.url), { fetch: this.signedFetch });
        await callerStore.run('system', () => client.connect(transport, { timeout: MCP_LIST_TIMEOUT_MS }));
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private markOk(): void {
    this.failures = 0;
    this.st = { ...this.st, state: 'ok', lastOkAt: new Date(this.now()).toISOString(), lastError: undefined, retryAt: undefined };
  }

  private async markFailed(err: unknown): Promise<void> {
    this.failures += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.st = {
      ...this.st,
      state: isAuthFailure(err) ? 'auth_failed' : 'unreachable',
      lastError: (err as Error).message,
      retryAt: new Date(this.now() + delay).toISOString(),
    };
    logger.warn({ err, serverId: this.config.id, state: this.st.state }, 'mcp server call failed');
    await this.close();
  }
}

const pool = new Map<string, McpConnection>();

export const mcpConnections = {
  /** 取得連線；URL 或逾時變更時重建，其餘欄位（名稱、覆寫）就地更新。 */
  get(config: McpServerConfig): McpConnection {
    const cur = pool.get(config.id);
    if (cur && cur.config.url === config.url && cur.config.timeoutMs === config.timeoutMs) {
      cur.config = config;
      return cur;
    }
    if (cur) void cur.close();
    const next = new McpConnection(config);
    pool.set(config.id, next);
    return next;
  },
  peek(id: string): McpConnection | undefined {
    return pool.get(id);
  },
  async drop(id: string): Promise<void> {
    const c = pool.get(id);
    pool.delete(id);
    await c?.close();
  },
  async closeAll(): Promise<void> {
    await Promise.all([...pool.keys()].map((id) => this.drop(id)));
  },
};
```

- [ ] **Step 6：確認測試通過**

Run: `cd server && npx jest tests/mcp-connection.test.ts`
Expected: PASS。

若「逾時」測試失敗是因為 SDK 的逾時錯誤 `code` 不是 `ErrorCode.RequestTimeout`：在測試中印出 `(err as {code}).code` 與 `message`，把 `isTimeout` 改為比對實際的 code（不要放寬成比對任意訊息），再重跑。

- [ ] **Step 7：型別檢查與 commit**

Run: `cd server && npm run typecheck`
Expected: 無錯誤。

```bash
git add server/package.json package-lock.json server/jest.config.js server/tests/helpers server/src/modules/mcp/mcp.connection.ts server/tests/mcp-connection.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 新增 MCP 連線管理

每 server 一條延遲建立的連線，以 AsyncLocalStorage 讓每個 HTTP 請求依當下呼叫者
簽 JWT；工具清單快取 10 分鐘、逾時、結果正規化與截斷；連線失敗標 unreachable／
auth_failed 並指數退避，退避期間工具不暴露。測試以 mcp-kit 組成 fixture server。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9：MCP 工具來源、路由意圖與 scope 目錄

**Files:**
- Create: `server/src/modules/mcp/mcp.tool-source.ts`
- Create: `server/src/modules/mcp/mcp.intents.ts`
- Create: `server/src/modules/mcp/register.ts`
- Modify: `server/src/modules/tools/index.ts`
- Modify: `server/src/modules/conversation/agent.agent-service.ts`
- Modify: `server/src/modules/authz/scope-catalog.ts`
- Test: `server/tests/mcp-tool-source.test.ts`

**Interfaces:**
- Consumes: Task 1 `ToolSource`、`registerToolSource`；Task 5 `mcpStore`；Task 6 `isMcpSigningEnabled`；Task 8 `mcpConnections`、`McpRemoteTool`、`McpConnection`
- Produces:
  - `LLM_TOOL_NAME_RE`、`mcpScopeId(serverId)`、`mcpToolId(serverId, toolName)`、`mcpLlmName(serverId, toolName)`
  - `effectForTool(remote: McpRemoteTool, override?: McpToolOverride): ToolEffect`
  - `type McpToolProblem = 'name_invalid'`、`toolProblem(serverId, remote): McpToolProblem | undefined`
  - `toToolDef(config, remote, conn: Pick<McpConnection, 'callTool'>): ToolDef | undefined`
  - `interface McpToolRow { name: string; title?: string; llmName: string; effect: ToolEffect; disabled: boolean; problem?: McpToolProblem }`、`describeServerTools(config, remotes): McpToolRow[]`
  - `mcpToolSource: ToolSource`（id `'mcp'`）
  - `mcpIntentsFor(tenantId, userId): IntentDescriptor[]`、`mcpPromptLines(tenantId, userId): string[]`

- [ ] **Step 1：寫失敗測試**

`server/tests/mcp-tool-source.test.ts`：

```ts
/** MCP 工具來源：讀寫判定、命名、覆寫、租戶隔離、scope 目錄、agent 意圖。 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { assertGrantableScopes, tenantGrantableScopes } from '@/modules/authz/scope-catalog';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { mcpConnections, type McpConnection, type McpRemoteTool } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { describeServerTools, effectForTool, mcpToolSource, toToolDef } from '@/modules/mcp/mcp.tool-source';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { toolRegistry } from '@/modules/tools';

const read: McpRemoteTool = { name: 'rooms_availability', title: '查空檔', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { date: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const write: McpRemoteTool = { name: 'rooms_book', title: '預約會議室', inputSchema: { type: 'object', properties: { room: { type: 'string' } } } };

function stubConnection(tools: McpRemoteTool[]): McpConnection {
  return {
    cachedTools: () => tools,
    status: () => ({ state: 'ok', toolsFetchedAt: 'fixed' }),
    listTools: async () => tools,
    callTool: jest.fn(async () => ({ ok: true })),
  } as unknown as McpConnection;
}

beforeEach(() => configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem));
afterEach(() => {
  mcpStore.clear();
  configureMcpSigningKey(null);
  jest.restoreAllMocks();
});

describe('讀寫判定與轉換', () => {
  it('readOnlyHint=true → read；未標 → write；requireConfirm 覆寫 → write', () => {
    expect(effectForTool(read)).toBe('read');
    expect(effectForTool(write)).toBe('write');
    expect(effectForTool(read, { requireConfirm: true })).toBe('write');
  });

  it('toToolDef：id、scope、標題、移除 $schema；停用回 undefined', () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp', toolOverrides: { rooms_book: { cardTitle: '確認預約' } } });
    const conn = stubConnection([]);
    const def = toToolDef(config, write, conn)!;
    expect(def).toMatchObject({ id: 'mcp.rooms.rooms_book', scopes: ['mcp:rooms'], effect: 'write', agentExposed: true, confirmTitle: '確認預約', audit: true });
    expect(toToolDef(config, read, conn)!.inputSchema.$schema).toBeUndefined();
    const disabled = mcpStore.update('rooms', { toolOverrides: { rooms_book: { disabled: true } } });
    expect(toToolDef(disabled, write, conn)).toBeUndefined();
  });

  it('工具名不合法或過長 → 不暴露，describeServerTools 標 name_invalid', () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const bad: McpRemoteTool = { name: 'has space', inputSchema: { type: 'object' } };
    const long: McpRemoteTool = { name: 'x'.repeat(60), inputSchema: { type: 'object' } };
    expect(toToolDef(config, bad, stubConnection([]))).toBeUndefined();
    expect(toToolDef(config, long, stubConnection([]))).toBeUndefined();
    const rows = describeServerTools(config, [read, bad]);
    expect(rows[0]).toMatchObject({ name: 'rooms_availability', llmName: 'mcp_rooms_rooms_availability', effect: 'read', disabled: false });
    expect(rows[1].problem).toBe('name_invalid');
  });

  it('handler 帶呼叫者身分呼叫 connection', async () => {
    const config = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://x/mcp' });
    const conn = stubConnection([]);
    await toToolDef(config, read, conn)!.handler({ date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
    expect(conn.callTool).toHaveBeenCalledWith('rooms_availability', { date: 'd' }, { tenantId: 't', userId: 'u', scopes: ['mcp:rooms'] });
  });
});

describe('租戶隔離', () => {
  it('專屬 server 只對擁有租戶且有 scope 者出現', () => {
    mcpStore.create({ id: 'only-a', name: 'A 專屬', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    const ids = (tenantId: string, scopes: string[]) => mcpToolSource.toolsFor({ tenantId, userId: 'u', scopes }).map((t) => t.id);
    expect(ids('tenant-a', ['mcp:only-a'])).toEqual(['mcp.only-a.rooms_availability']);
    expect(ids('tenant-a', [])).toEqual([]);
    expect(ids('tenant-b', ['mcp:only-a'])).toEqual([]);
  });

  it('scope 目錄：專屬 server 只列給擁有租戶；他租戶授予直接拒絕', () => {
    const a = tenantStore.createTenant('mcp-scope-a');
    const b = tenantStore.createTenant('mcp-scope-b');
    mcpStore.create({ id: 'only-a', name: 'A 專屬', url: 'http://a/mcp', ownerTenantId: a.id });
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    expect(tenantGrantableScopes(a.id).map((s) => s.id)).toEqual(expect.arrayContaining(['mcp:only-a', 'mcp:shared']));
    expect(tenantGrantableScopes(b.id).map((s) => s.id)).not.toContain('mcp:only-a');
    expect(() => assertGrantableScopes(['mcp:only-a'], a.id)).not.toThrow();
    expect(() => assertGrantableScopes(['mcp:only-a'], b.id)).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => assertGrantableScopes(['mcp:none'], a.id)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('未設簽章金鑰 → 沒有任何 MCP 工具', () => {
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    configureMcpSigningKey(null);
    expect(mcpToolSource.toolsFor({ tenantId: 't', userId: 'u', scopes: ['mcp:shared'] })).toEqual([]);
  });
});

describe('registry 整合與 agent 意圖', () => {
  it('來源已註冊：availableFor 看得到 MCP 工具', () => {
    mcpStore.create({ id: 'shared', name: '共用', url: 'http://s/mcp' });
    jest.spyOn(mcpConnections, 'get').mockReturnValue(stubConnection([read]));
    const names = toolRegistry.availableFor({ tenantId: 't', userId: 'u', scopes: ['mcp:shared'] }).map((t) => t.name);
    expect(names).toContain('mcp.shared.rooms_availability');
  });

  it('agent intents 帶入使用者有權限的 MCP server 描述與關鍵字', () => {
    const t = tenantStore.createTenant('mcp-intents');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'mcp:rooms'] });
    mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://r/mcp', description: '查詢與預約會議室', keywords: ['會議室', '預約'] });
    mcpStore.create({ id: 'erp', name: 'ERP', url: 'http://e/mcp', description: '查庫存', keywords: ['庫存'] });
    const session = { tenantId: t.id, userId: 'kevin' } as Session;
    const intents = agentAgentService.intents(session);
    expect(intents).toContainEqual({ id: 'agent.mcp.rooms', keywords: ['會議室', '預約'], description: '查詢與預約會議室' });
    expect(intents.map((i) => i.id)).not.toContain('agent.mcp.erp');
  });
});
```

Run: `cd server && npx jest tests/mcp-tool-source.test.ts`
Expected: FAIL，`Cannot find module '@/modules/mcp/mcp.tool-source'`。

- [ ] **Step 2：工具來源**

`server/src/modules/mcp/mcp.tool-source.ts`：

```ts
/**
 * MCP 工具來源：把「此租戶可見、此使用者有 mcp:<serverId>」的 server 工具轉成 ToolDef。
 * 讀寫判定：覆寫 requireConfirm → write；readOnlyHint=true → read；其餘一律 write（安全預設）。
 * ToolDef 依（server 設定版本, 工具清單抓取時間）快取，避免每次 invoke 重編 Ajv。
 */
import { logger } from '@/lib/logger';
import type { ToolContext, ToolDef, ToolEffect, ToolSource } from '@/modules/tools/tool.types';
import { mcpConnections, type McpConnection, type McpRemoteTool } from './mcp.connection';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import type { McpServerConfig, McpToolOverride } from './mcp.types';

/** Anthropic 上限 128、OpenAI 上限 64，取交集。 */
export const LLM_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function mcpScopeId(serverId: string): string {
  return `mcp:${serverId}`;
}

export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

export function mcpLlmName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`;
}

export function effectForTool(remote: McpRemoteTool, override?: McpToolOverride): ToolEffect {
  if (override?.requireConfirm) return 'write';
  return remote.annotations?.readOnlyHint === true ? 'read' : 'write';
}

export type McpToolProblem = 'name_invalid';

export function toolProblem(serverId: string, remote: McpRemoteTool): McpToolProblem | undefined {
  return TOOL_NAME_RE.test(remote.name) && LLM_TOOL_NAME_RE.test(mcpLlmName(serverId, remote.name)) ? undefined : 'name_invalid';
}

/** 移除 $schema / $id：避免 Ajv 因 meta-schema 版本或 id 重複而編譯失敗。 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return { type: 'object', ...rest };
}

const warned = new Set<string>();

export function toToolDef(
  config: McpServerConfig,
  remote: McpRemoteTool,
  conn: Pick<McpConnection, 'callTool'>,
): ToolDef | undefined {
  const override = config.toolOverrides[remote.name];
  if (override?.disabled) return undefined;
  if (toolProblem(config.id, remote)) {
    const key = `${config.id}/${remote.name}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn({ serverId: config.id, tool: remote.name }, 'mcp tool name invalid for LLM; not exposed');
    }
    return undefined;
  }
  return {
    id: mcpToolId(config.id, remote.name),
    description: remote.description ?? remote.title ?? remote.name,
    confirmTitle: override?.cardTitle ?? remote.title,
    inputSchema: normalizeSchema(remote.inputSchema),
    scopes: [mcpScopeId(config.id)],
    agentExposed: true,
    effect: effectForTool(remote, override),
    audit: true,
    auditSummary: () => `${config.name}｜${remote.title ?? remote.name}`,
    handler: (input, ctx) =>
      conn.callTool(remote.name, input as Record<string, unknown>, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        scopes: ctx.scopes,
      }),
  };
}

export interface McpToolRow {
  name: string;
  title?: string;
  llmName: string;
  effect: ToolEffect;
  disabled: boolean;
  problem?: McpToolProblem;
}

/** 後台用：列出 server 的工具與判定結果。 */
export function describeServerTools(config: McpServerConfig, remotes: McpRemoteTool[]): McpToolRow[] {
  return remotes.map((r) => {
    const override = config.toolOverrides[r.name];
    const problem = toolProblem(config.id, r);
    return {
      name: r.name,
      title: r.title,
      llmName: mcpLlmName(config.id, r.name),
      effect: effectForTool(r, override),
      disabled: override?.disabled === true,
      ...(problem ? { problem } : {}),
    };
  });
}

/** 此 ctx 可用的 server：簽章已啟用、租戶可見、使用者有 mcp:<id>。 */
function usableServers(ctx: ToolContext): McpServerConfig[] {
  if (!isMcpSigningEnabled()) return [];
  return mcpStore.listVisibleTo(ctx.tenantId).filter((c) => ctx.scopes.includes(mcpScopeId(c.id)));
}

const defCache = new Map<string, { stamp: string; defs: ToolDef[] }>();

export const mcpToolSource: ToolSource = {
  id: 'mcp',

  async prepare(ctx) {
    await Promise.all(
      usableServers(ctx).map(async (config) => {
        try {
          await mcpConnections.get(config).listTools();
        } catch {
          // 狀態已記在 connection（unreachable / auth_failed），工具暫不暴露
        }
      }),
    );
  },

  toolsFor(ctx) {
    const out: ToolDef[] = [];
    for (const config of usableServers(ctx)) {
      const conn = mcpConnections.get(config);
      const remotes = conn.cachedTools();
      if (!remotes) continue;
      const stamp = `${config.updatedAt ?? config.createdAt}|${conn.status().toolsFetchedAt ?? ''}`;
      let cached = defCache.get(config.id);
      if (!cached || cached.stamp !== stamp) {
        const defs = remotes
          .map((r) => toToolDef(config, r, conn))
          .filter((d): d is ToolDef => d !== undefined);
        cached = { stamp, defs };
        defCache.set(config.id, cached);
      }
      out.push(...cached.defs);
    }
    return out;
  },
};
```

> 注意：測試中 `stubConnection` 的 `status()` 固定回 `toolsFetchedAt: 'fixed'`，而 `mcpStore.update` 會更新 `updatedAt`，所以 stamp 仍會變、快取會失效，測試不受快取影響。

- [ ] **Step 3：意圖、註冊與 agent 修改**

`server/src/modules/mcp/mcp.intents.ts`：

```ts
/** agent 服務的 MCP 段落：路由意圖（關鍵字 + 分類器描述）與系統提示詞。只列使用者有權限的 server。 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { IntentDescriptor } from '@/modules/conversation/agent-service.types';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import { mcpScopeId } from './mcp.tool-source';
import type { McpServerConfig } from './mcp.types';

function usableFor(tenantId: string, userId: string): McpServerConfig[] {
  if (!isMcpSigningEnabled()) return [];
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  return mcpStore.listVisibleTo(tenantId).filter((c) => scopes.has(mcpScopeId(c.id)));
}

export function mcpIntentsFor(tenantId: string, userId: string): IntentDescriptor[] {
  return usableFor(tenantId, userId).map((c) => ({
    id: `agent.mcp.${c.id}`,
    keywords: c.keywords,
    description: c.description || c.name,
  }));
}

export function mcpPromptLines(tenantId: string, userId: string): string[] {
  const servers = usableFor(tenantId, userId);
  if (servers.length === 0) return [];
  return ['已連接的外部服務（透過工具使用）：', ...servers.map((c) => `- ${c.name}：${c.description || '（未提供描述）'}`)];
}
```

`server/src/modules/mcp/register.ts`：

```ts
/** 副作用：把 MCP 工具來源註冊進 Tool Registry（由 '@/modules/tools' 進入點 import）。 */
import { registerToolSource } from '@/modules/tools/tool.registry';
import { mcpToolSource } from './mcp.tool-source';

registerToolSource(mcpToolSource);
```

`server/src/modules/tools/index.ts`：在 `import './email.tools';` 之後加 `import '@/modules/mcp/register';`。

`server/src/modules/conversation/agent.agent-service.ts`：
- import 區加 `import { mcpIntentsFor, mcpPromptLines } from '@/modules/mcp/mcp.intents';`
- `intents(): IntentDescriptor[] {` 改為 `intents(session: Session): IntentDescriptor[] {`，並把 `return [ {...agent.task...} ];` 改為 `return [ {...agent.task...}, ...mcpIntentsFor(session.tenantId, session.userId) ];`（`agent.task` 物件內容不變）。
- `handleTurn` 中 `system: buildSystemPrompt(session.userId, session.locale),` 改為 `system: buildSystemPrompt(session.userId, session.locale, mcpPromptLines(session.tenantId, session.userId)),`。

- [ ] **Step 4：scope 目錄**

`server/src/modules/authz/scope-catalog.ts`：
- import 區加 `import { mcpStore } from '@/modules/mcp/mcp.store';`
- 在 `formScopeId` 函式之後加：

```ts
/** MCP server scope：mcp:<serverId>。 */
export function mcpServerScopeId(serverId: string): string {
  return `mcp:${serverId}`;
}

/** 此租戶可授予的 MCP scope：共用 server 與該租戶專屬 server（不看啟用狀態，停用時仍可預先授權）。 */
function tenantMcpScopeIds(tenantId: string): Set<string> {
  return new Set(mcpStore.list().filter((s) => mcpStore.belongsTo(s, tenantId)).map((s) => mcpServerScopeId(s.id)));
}
```

- `assertGrantableScopes` 中，`validLabelIds` 宣告之後加 `const validMcpIds = tenantId ? tenantMcpScopeIds(tenantId) : new Set<string>();`，並把 `ok` 改為：

```ts
  const ok = (id: string): boolean =>
    GRANTABLE_SCOPE_IDS.has(id) || validFormIds.has(id) || validLabelIds.has(id) || validMcpIds.has(id);
```

- `tenantGrantableScopes` 中，`labels` 宣告之後加：

```ts
  const mcp: ScopeDef[] = mcpStore
    .list()
    .filter((s) => mcpStore.belongsTo(s, tenantId))
    .map((s) => ({
      id: mcpServerScopeId(s.id),
      label: s.name,
      description: s.description || `使用外部服務「${s.name}」`,
      base: false,
    }));
```

並把 `return [...GRANTABLE_SCOPES, ...forms, ...labels];` 改為 `return [...GRANTABLE_SCOPES, ...forms, ...labels, ...mcp];`。

- [ ] **Step 5：確認測試通過與全套回歸**

Run: `cd server && npx jest tests/mcp-tool-source.test.ts`
Expected: PASS。

Run: `cd server && npm test && npm run typecheck`
Expected: 全部 PASS、型別無錯誤。若 `admin-policy.test.ts` 等斷言 `tenantGrantableScopes` 的精確長度而失敗，表示有測試殘留的 MCP server：確認新測試都有 `afterEach(() => mcpStore.clear())`。

- [ ] **Step 6：commit**

```bash
git add server/src/modules/mcp server/src/modules/tools/index.ts server/src/modules/conversation/agent.agent-service.ts server/src/modules/authz/scope-catalog.ts server/tests/mcp-tool-source.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): MCP 工具接入 Tool Registry 與智慧代理

MCP 工具來源依租戶歸屬與 mcp:<serverId> 把工具轉成 ToolDef（讀寫判定、覆寫、
命名檢查、移除 $schema）；agent 意圖與提示詞帶入可用 server 的描述與關鍵字；
scope 目錄加入 mcp:<id>，專屬 server 只能授予其租戶。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10：後台 MCP 管理 API

**Files:**
- Create: `server/src/modules/mcp/mcp.admin.schema.ts`
- Create: `server/src/modules/mcp/mcp.admin.controller.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`
- Test: `server/tests/mcp-admin.test.ts`

**Interfaces:**
- Consumes: Task 5 `mcpStore`；Task 8 `mcpConnections`；Task 9 `describeServerTools`；Task 6 `isMcpSigningEnabled`
- Produces（HTTP，皆需 `requireAdmin`）：
  - `GET /api/admin/mcp-servers` → `{ data: { signingEnabled: boolean; servers: McpServerView[] } }`
  - `POST /api/admin/mcp-servers` → `201 { data: McpServerView }`
  - `PATCH /api/admin/mcp-servers/:serverId` → `{ data: McpServerView }`
  - `DELETE /api/admin/mcp-servers/:serverId` → `204`
  - `POST /api/admin/mcp-servers/:serverId/refresh` → `{ data: McpServerView }`（連線失敗也回 200，狀態在 `status`）
  - `McpServerView = { config: McpServerConfig; status: McpServerStatus; tools: McpToolRow[] }`

- [ ] **Step 1：寫失敗測試**

`server/tests/mcp-admin.test.ts`：

```ts
/** 後台 MCP API：CRUD、輸入驗證、擁有租戶需存在、重新整理工具清單、需管理金鑰。 */
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { startMcpFixture, type McpFixture } from './helpers/mcp-fixture';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
let fixture: McpFixture;

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  fixture = await startMcpFixture('rooms');
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await fixture.close();
  mcpStore.clear();
  configureMcpSigningKey(null);
});

describe('後台 MCP API', () => {
  it('未帶管理金鑰 → 401', async () => {
    expect((await request(app).get('/api/admin/mcp-servers')).status).toBe(401);
  });

  it('建立 → 列表 → 重新整理看到工具與讀寫判定 → 修改 → 刪除', async () => {
    const created = await request(app).post('/api/admin/mcp-servers').set(admin).send({
      id: 'rooms', name: '會議室', url: fixture.url, description: '查詢與預約會議室', keywords: ['會議室'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.config.id).toBe('rooms');

    const list = await request(app).get('/api/admin/mcp-servers').set(admin);
    expect(list.body.data.signingEnabled).toBe(true);
    expect(list.body.data.servers.map((s: { config: { id: string } }) => s.config.id)).toEqual(['rooms']);

    const refreshed = await request(app).post('/api/admin/mcp-servers/rooms/refresh').set(admin);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.status.state).toBe('ok');
    const tools = refreshed.body.data.tools as { name: string; effect: string }[];
    expect(tools.find((t) => t.name === 'rooms_availability')?.effect).toBe('read');
    expect(tools.find((t) => t.name === 'rooms_book')?.effect).toBe('write');

    const patched = await request(app).patch('/api/admin/mcp-servers/rooms').set(admin).send({
      toolOverrides: { rooms_availability: { requireConfirm: true } },
    });
    expect(patched.status).toBe(200);
    expect((patched.body.data.tools as { name: string; effect: string }[]).find((t) => t.name === 'rooms_availability')?.effect).toBe('write');

    expect((await request(app).delete('/api/admin/mcp-servers/rooms').set(admin)).status).toBe(204);
    expect(mcpStore.get('rooms')).toBeUndefined();
  });

  it.each([
    [{ id: 'Bad_ID', name: 'x', url: 'http://x/mcp' }],
    [{ id: 'ok', name: '', url: 'http://x/mcp' }],
    [{ id: 'ok', name: 'x', url: 'ftp://x/mcp' }],
    [{ id: 'ok', name: 'x', url: 'http://x/mcp', timeoutMs: 10 }],
  ])('輸入不合法 → 4xx：%j', async (body) => {
    const res = await request(app).post('/api/admin/mcp-servers').set(admin).send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('擁有租戶不存在 → 400；存在 → 建立成功', async () => {
    const bad = await request(app).post('/api/admin/mcp-servers').set(admin).send({ id: 'x1', name: 'x', url: fixture.url, ownerTenantId: 'no-such-tenant' });
    expect(bad.status).toBe(400);
    const t = tenantStore.createTenant('mcp-admin-owner');
    const ok = await request(app).post('/api/admin/mcp-servers').set(admin).send({ id: 'x2', name: 'x', url: fixture.url, ownerTenantId: t.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.config.ownerTenantId).toBe(t.id);
  });

  it('server 連不上：重新整理仍回 200，狀態 unreachable', async () => {
    await request(app).post('/api/admin/mcp-servers').set(admin).send({ id: 'down', name: '掛掉', url: 'http://127.0.0.1:1/mcp' });
    const res = await request(app).post('/api/admin/mcp-servers/down/refresh').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.data.status.state).toBe('unreachable');
    expect(res.body.data.tools).toEqual([]);
  });

  it('修改或刪除不存在的 server → 404', async () => {
    expect((await request(app).patch('/api/admin/mcp-servers/none').set(admin).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/admin/mcp-servers/none').set(admin)).status).toBe(404);
  });
});
```

Run: `cd server && npx jest tests/mcp-admin.test.ts`
Expected: FAIL，端點回 404。

- [ ] **Step 2：schema 與 controller**

`server/src/modules/mcp/mcp.admin.schema.ts`：

```ts
import { z } from 'zod';
import { MCP_SERVER_ID_RE } from './mcp.types';

const toolOverride = z
  .object({
    disabled: z.boolean().optional(),
    requireConfirm: z.boolean().optional(),
    cardTitle: z.string().trim().max(60).optional(),
  })
  .strict();

const fields = {
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), '只接受 http(s) URL'),
  ownerTenantId: z.string().trim().min(1).nullable(),
  description: z.string().trim().max(500),
  keywords: z.array(z.string().trim().min(1).max(20)).max(20),
  timeoutMs: z.number().int().min(1000).max(120_000),
  enabled: z.boolean(),
  toolOverrides: z.record(z.string(), toolOverride),
};

export const createMcpServerSchema = z
  .object({
    id: z.string().regex(MCP_SERVER_ID_RE, 'serverId 只允許小寫英數與連字號、1–32 字'),
    name: fields.name,
    url: fields.url,
    ownerTenantId: fields.ownerTenantId.optional(),
    description: fields.description.optional(),
    keywords: fields.keywords.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    enabled: fields.enabled.optional(),
    toolOverrides: fields.toolOverrides.optional(),
  })
  .strict();

export const patchMcpServerSchema = z
  .object({
    name: fields.name.optional(),
    url: fields.url.optional(),
    ownerTenantId: fields.ownerTenantId.optional(),
    description: fields.description.optional(),
    keywords: fields.keywords.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    enabled: fields.enabled.optional(),
    toolOverrides: fields.toolOverrides.optional(),
  })
  .strict();

export const mcpServerParamSchema = z.object({ serverId: z.string().regex(MCP_SERVER_ID_RE) });

export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type PatchMcpServerInput = z.infer<typeof patchMcpServerSchema>;
```

`server/src/modules/mcp/mcp.admin.controller.ts`：

```ts
/** 後台 MCP 服務管理（平台管理員）。工具清單只讀快取；「重新整理」才實際連線。 */
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import type { CreateMcpServerInput, PatchMcpServerInput } from './mcp.admin.schema';
import { mcpConnections, type McpServerStatus } from './mcp.connection';
import { isMcpSigningEnabled } from './mcp.identity';
import { mcpStore } from './mcp.store';
import { describeServerTools, type McpToolRow } from './mcp.tool-source';
import type { McpServerConfig } from './mcp.types';

export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolRow[];
}

function view(config: McpServerConfig): McpServerView {
  const conn = mcpConnections.peek(config.id);
  return {
    config,
    status: conn?.status() ?? { state: 'idle' },
    tools: describeServerTools(config, conn?.cachedTools() ?? []),
  };
}

function assertOwnerExists(ownerTenantId: string | null | undefined): void {
  if (ownerTenantId && !tenantStore.getTenant(ownerTenantId)) {
    throw AppError.badRequest(`擁有租戶不存在：${ownerTenantId}`);
  }
}

function serverOr404(id: string): McpServerConfig {
  const config = mcpStore.get(id);
  if (!config) throw AppError.notFound(`MCP server 不存在：${id}`);
  return config;
}

export const mcpAdminController = {
  list(_req: Request, res: Response): void {
    res.json({ data: { signingEnabled: isMcpSigningEnabled(), servers: mcpStore.list().map(view) } });
  },

  create(req: Request, res: Response): void {
    const input = req.body as CreateMcpServerInput;
    assertOwnerExists(input.ownerTenantId);
    res.status(201).json({ data: view(mcpStore.create(input)) });
  },

  async update(req: Request, res: Response): Promise<void> {
    const id = String(req.params.serverId);
    const before = serverOr404(id);
    const patch = req.body as PatchMcpServerInput;
    assertOwnerExists(patch.ownerTenantId);
    const after = mcpStore.update(id, patch);
    if (after.url !== before.url || after.timeoutMs !== before.timeoutMs) await mcpConnections.drop(id);
    res.json({ data: view(after) });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const id = String(req.params.serverId);
    if (!mcpStore.remove(id)) throw AppError.notFound(`MCP server 不存在：${id}`);
    await mcpConnections.drop(id);
    res.status(204).end();
  },

  /** 測試連線／重新整理工具清單：失敗也回 200，原因在 status。 */
  async refresh(req: Request, res: Response): Promise<void> {
    const config = serverOr404(String(req.params.serverId));
    if (!isMcpSigningEnabled()) throw AppError.badRequest('MCP 簽章金鑰未設定（MCP_SIGNING_KEY），無法連線');
    try {
      await mcpConnections.get(config).listTools({ force: true });
    } catch {
      // 狀態已記在 connection
    }
    res.json({ data: view(config) });
  },
};
```

- [ ] **Step 3：掛路由**

`server/src/modules/admin/admin.routes.ts`：import 區加

```ts
import { mcpAdminController } from '@/modules/mcp/mcp.admin.controller';
import { createMcpServerSchema, mcpServerParamSchema, patchMcpServerSchema } from '@/modules/mcp/mcp.admin.schema';
```

在 `router.get('/skills', ...)` 之後加：

```ts
// MCP 服務（平台層）：登記、修改、刪除、重新整理工具清單
router.get('/mcp-servers', asyncHandler(mcpAdminController.list));
router.post('/mcp-servers', validate({ body: createMcpServerSchema }), asyncHandler(mcpAdminController.create));
router.patch(
  '/mcp-servers/:serverId',
  validate({ params: mcpServerParamSchema, body: patchMcpServerSchema }),
  asyncHandler(mcpAdminController.update),
);
router.delete('/mcp-servers/:serverId', validate({ params: mcpServerParamSchema }), asyncHandler(mcpAdminController.remove));
router.post('/mcp-servers/:serverId/refresh', validate({ params: mcpServerParamSchema }), asyncHandler(mcpAdminController.refresh));
```

- [ ] **Step 4：確認測試通過、型別檢查、commit**

Run: `cd server && npx jest tests/mcp-admin.test.ts && npm run typecheck`
Expected: PASS，型別無錯誤。

```bash
git add server/src/modules/mcp/mcp.admin.schema.ts server/src/modules/mcp/mcp.admin.controller.ts server/src/modules/admin/admin.routes.ts server/tests/mcp-admin.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): 新增 MCP 服務管理 API

平台管理員可登記、修改、刪除 MCP server，並重新整理工具清單（顯示讀寫判定、
覆寫與命名問題）；擁有租戶必須存在；URL 或逾時變更時重建連線。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11：端到端整合測試（讀取與寫入確認）

**Files:**
- Test: `server/tests/mcp-e2e.test.ts`

**Interfaces:**
- Consumes: Task 3 `agentAgentService`、`runConfirmedAction`；Task 5 `mcpStore`；Task 6 `configureMcpSigningKey`；Task 8 fixture、`mcpConnections`

- [ ] **Step 1：寫測試**

`server/tests/mcp-e2e.test.ts`：

```ts
/**
 * 端到端：假 LLM 依劇本呼叫 MCP 工具，走真正的 agent、registry、MCP 連線、JWT 與 kit 驗章。
 *  - 讀取：直接執行，MCP 端收到正確身分。
 *  - 寫入：只建確認卡片，MCP 端沒有任何寫入；確認後才寫入，身分正確。
 *  - MCP server 掛掉：這一輪照常完成，LLM 收到錯誤字串。
 */
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { runConfirmedAction } from '@/modules/conversation/pending-action.service';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { configureMcpSigningKey } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { startMcpFixture, type McpFixture } from './helpers/mcp-fixture';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...partial };
}
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

let fixture: McpFixture;
let tenantId: string;

function session(): Session {
  return {
    id: 's-mcp', tenantId, userId: 'kevin', formId: '', values: {}, status: 'collecting',
    activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    createdAt: new Date().toISOString(),
  };
}

function toolResults(s: Session): string[] {
  return s.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b as { content: string }).content);
}

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  fixture = await startMcpFixture('rooms-e2e');
  const t = tenantStore.createTenant(`mcp-e2e-${Date.now()}`);
  tenantId = t.id;
  tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent', 'mcp:rooms-e2e'] });
  mcpStore.create({ id: 'rooms-e2e', name: '會議室', url: fixture.url, ownerTenantId: tenantId, description: '查詢與預約會議室' });
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await fixture.close();
  mcpStore.clear();
  configureMcpSigningKey(null);
});

describe('MCP 端到端', () => {
  it('讀取：直接執行，MCP 端收到使用者身分', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_availability', input: { date: '2026-10-04', room: 'A' } }], stopReason: 'tool_use' }),
      res({ text: 'A 會議室 14:00-16:00 有空。' }),
    ]);
    const s = session();
    const out = await agentAgentService.handleTurn(s, '明天 A 會議室有空嗎', llm);

    expect(out.reply).toContain('14:00-16:00');
    expect(out.pendingAction).toBeUndefined();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].caller).toMatchObject({ tenantId, userId: 'kevin', scopes: ['mcp:rooms-e2e'] });
    expect(toolResults(s)[0]).toContain('"free":["14:00-16:00"]');
  });

  it('寫入：先只建卡片；確認後才寫入，身分正確', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_book', input: { room: 'A', date: '2026-10-04' } }], stopReason: 'tool_use' }),
      res({ text: '將為你預約 A 會議室，請確認。' }),
    ]);
    const s = session();
    const out = await agentAgentService.handleTurn(s, '幫我訂明天的 A 會議室', llm);

    expect(fixture.bookings).toHaveLength(0);
    expect(out.pendingAction?.summary).toEqual({
      title: '預約會議室',
      fields: [{ label: '會議室', value: 'A' }, { label: '日期', value: '2026-10-04' }],
    });

    const action = s.pendingAction!;
    s.pendingAction = undefined;
    const outcome = await runConfirmedAction(s, action);
    expect(outcome.ok).toBe(true);
    expect(fixture.bookings).toHaveLength(1);
    expect(fixture.bookings[0].caller).toMatchObject({ tenantId, userId: 'kevin' });
  });

  it('MCP server 掛掉：這一輪照常完成，LLM 收到錯誤', async () => {
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'mcp_rooms-e2e_rooms_availability', input: { date: '2026-10-04', room: 'A' } }], stopReason: 'tool_use' }),
      res({ text: '會議室系統暫時無法使用。' }),
    ]);
    const s = session();
    // 先讓連線快取工具，再關掉 server
    await agentAgentService.handleTurn(session(), 'warm up', scriptedLLM([res({ text: 'ok' })]));
    await fixture.close();
    await mcpConnections.peek('rooms-e2e')?.close();

    const out = await agentAgentService.handleTurn(s, '明天 A 會議室有空嗎', llm);
    expect(out.reply).toBe('會議室系統暫時無法使用。');
    expect(toolResults(s)[0]).toContain('"ok":false');
    fixture = await startMcpFixture('rooms-e2e');
  });
});
```

- [ ] **Step 2：跑測試**

Run: `cd server && npx jest tests/mcp-e2e.test.ts`
Expected: PASS。若「掛掉」案例中 LLM 名稱不在工具清單（連線在 prepare 時已失敗而不暴露），`tool_result` 會是 `工具不可用`，同樣包含 `"ok":false`，斷言仍成立。

- [ ] **Step 3：全套測試與 commit**

Run: `cd server && npm test`
Expected: 全部 PASS。

```bash
git add server/tests/mcp-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(mcp): 新增 MCP 端到端整合測試

以假 LLM 走真正的 agent、registry、MCP 連線、JWT 與 kit 驗章，涵蓋讀取直接執行、
寫入需確認後才執行、server 掛掉時對話照常完成。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12：後台「MCP 服務」頁

**Files:**
- Create: `admin/src/pages/mcpForm.util.ts`
- Create: `admin/src/pages/mcpForm.util.test.ts`
- Create: `admin/src/pages/McpServersPage.tsx`
- Modify: `admin/src/api.ts`
- Modify: `admin/src/App.tsx`
- Modify: `admin/src/components/AppLayout.tsx`

**Interfaces:**
- Consumes: Task 10 HTTP API
- Produces:
  - `admin/src/api.ts`：型別 `McpServerConfig`、`McpServerStatus`、`McpToolRow`、`McpServerView`、`McpServerListView`；`api.listMcpServers()`、`api.createMcpServer(input)`、`api.updateMcpServer(id, patch)`、`api.deleteMcpServer(id)`、`api.refreshMcpServer(id)`
  - `mcpForm.util.ts`：`interface McpServerFormValues { id: string; name: string; url: string; ownerTenantId: string; description: string; keywords: string; timeoutSeconds: string; enabled: boolean }`、`emptyMcpForm(): McpServerFormValues`、`toFormValues(config): McpServerFormValues`、`validateMcpForm(values, isNew: boolean): string[]`、`toPayload(values): McpServerPayload`、`parseKeywords(text: string): string[]`、`statusLabel(state): string`

- [ ] **Step 1：寫失敗測試**

`admin/src/pages/mcpForm.util.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { emptyMcpForm, parseKeywords, statusLabel, toPayload, validateMcpForm } from './mcpForm.util';

describe('mcpForm.util', () => {
  it('parseKeywords：逗號、頓號、換行分隔，去空白與重複', () => {
    expect(parseKeywords('會議室, 預約、空檔\n會議室,, ')).toEqual(['會議室', '預約', '空檔']);
  });

  it('validateMcpForm：新增時檢查 serverId，URL 必須 http(s)，逾時 1–120 秒', () => {
    const ok = { ...emptyMcpForm(), id: 'rooms', name: '會議室', url: 'http://localhost:4100/mcp' };
    expect(validateMcpForm(ok, true)).toEqual([]);
    expect(validateMcpForm({ ...ok, id: 'Rooms_1' }, true)).toContain('serverId 只允許小寫英數與連字號（1–32 字）');
    expect(validateMcpForm({ ...ok, id: 'Rooms_1' }, false)).toEqual([]);
    expect(validateMcpForm({ ...ok, name: ' ' }, true)).toContain('請填寫名稱');
    expect(validateMcpForm({ ...ok, url: 'ftp://x' }, true)).toContain('URL 必須以 http:// 或 https:// 開頭');
    expect(validateMcpForm({ ...ok, timeoutSeconds: '0' }, true)).toContain('逾時須為 1–120 秒');
  });

  it('toPayload：空擁有租戶轉 null、秒轉毫秒、關鍵字轉陣列', () => {
    const p = toPayload({ ...emptyMcpForm(), id: 'rooms', name: '會議室', url: 'http://x/mcp', keywords: '會議室、預約', timeoutSeconds: '30' });
    expect(p).toEqual({
      name: '會議室', url: 'http://x/mcp', ownerTenantId: null, description: '', keywords: ['會議室', '預約'], timeoutMs: 30000, enabled: true,
    });
  });

  it('statusLabel', () => {
    expect(statusLabel('ok')).toBe('正常');
    expect(statusLabel('unreachable')).toBe('連不上');
    expect(statusLabel('auth_failed')).toBe('驗證失敗');
    expect(statusLabel('idle')).toBe('尚未連線');
  });
});
```

Run: `cd admin && npx vitest run src/pages/mcpForm.util.test.ts`
Expected: FAIL，找不到模組。

- [ ] **Step 2：工具函式**

`admin/src/pages/mcpForm.util.ts`：

```ts
/** MCP 服務表單：純函式（驗證、轉換），與畫面分離以便測試。 */
import type { McpServerConfig, McpServerStatus } from '../api';

export interface McpServerFormValues {
  id: string;
  name: string;
  url: string;
  /** 空字串＝共用 */
  ownerTenantId: string;
  description: string;
  /** 以逗號、頓號或換行分隔 */
  keywords: string;
  timeoutSeconds: string;
  enabled: boolean;
}

export interface McpServerPayload {
  name: string;
  url: string;
  ownerTenantId: string | null;
  description: string;
  keywords: string[];
  timeoutMs: number;
  enabled: boolean;
}

const SERVER_ID_RE = /^[a-z0-9-]{1,32}$/;

export function emptyMcpForm(): McpServerFormValues {
  return { id: '', name: '', url: '', ownerTenantId: '', description: '', keywords: '', timeoutSeconds: '20', enabled: true };
}

export function toFormValues(c: McpServerConfig): McpServerFormValues {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    ownerTenantId: c.ownerTenantId ?? '',
    description: c.description,
    keywords: c.keywords.join('、'),
    timeoutSeconds: String(Math.round(c.timeoutMs / 1000)),
    enabled: c.enabled,
  };
}

export function parseKeywords(text: string): string[] {
  return [...new Set(text.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean))];
}

export function validateMcpForm(v: McpServerFormValues, isNew: boolean): string[] {
  const errors: string[] = [];
  if (isNew && !SERVER_ID_RE.test(v.id)) errors.push('serverId 只允許小寫英數與連字號（1–32 字）');
  if (!v.name.trim()) errors.push('請填寫名稱');
  if (!/^https?:\/\//.test(v.url.trim())) errors.push('URL 必須以 http:// 或 https:// 開頭');
  const sec = Number(v.timeoutSeconds);
  if (!Number.isInteger(sec) || sec < 1 || sec > 120) errors.push('逾時須為 1–120 秒');
  return errors;
}

export function toPayload(v: McpServerFormValues): McpServerPayload {
  return {
    name: v.name.trim(),
    url: v.url.trim(),
    ownerTenantId: v.ownerTenantId.trim() || null,
    description: v.description.trim(),
    keywords: parseKeywords(v.keywords),
    timeoutMs: Number(v.timeoutSeconds) * 1000,
    enabled: v.enabled,
  };
}

export function statusLabel(state: McpServerStatus['state']): string {
  return { ok: '正常', unreachable: '連不上', auth_failed: '驗證失敗', idle: '尚未連線' }[state];
}
```

- [ ] **Step 3：API 型別與方法**

`admin/src/api.ts`：在 `export interface SkillLibraryView {...}` 之後加：

```ts
export interface McpToolOverride {
  disabled?: boolean;
  requireConfirm?: boolean;
  cardTitle?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  ownerTenantId: string | null;
  description: string;
  keywords: string[];
  timeoutMs: number;
  enabled: boolean;
  toolOverrides: Record<string, McpToolOverride>;
  createdAt: string;
  updatedAt?: string;
}

export interface McpServerStatus {
  state: 'idle' | 'ok' | 'unreachable' | 'auth_failed';
  lastError?: string;
  lastOkAt?: string;
  toolsFetchedAt?: string;
}

export interface McpToolRow {
  name: string;
  title?: string;
  llmName: string;
  effect: 'read' | 'write';
  disabled: boolean;
  problem?: 'name_invalid';
}

export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolRow[];
}

export interface McpServerListView {
  signingEnabled: boolean;
  servers: McpServerView[];
}
```

在 `api` 物件中 `listSkills: ...` 之後加：

```ts
  listMcpServers: () => req<McpServerListView>('GET', '/admin/mcp-servers'),
  createMcpServer: (input: Partial<McpServerConfig> & Pick<McpServerConfig, 'id' | 'name' | 'url'>) =>
    req<McpServerView>('POST', '/admin/mcp-servers', input),
  updateMcpServer: (id: string, patch: Partial<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>>) =>
    req<McpServerView>('PATCH', `/admin/mcp-servers/${encodeURIComponent(id)}`, patch),
  deleteMcpServer: (id: string) => req<void>('DELETE', `/admin/mcp-servers/${encodeURIComponent(id)}`),
  refreshMcpServer: (id: string) => req<McpServerView>('POST', `/admin/mcp-servers/${encodeURIComponent(id)}/refresh`),
```

> 先確認 `req` 對 204（無 body）的處理：讀 `admin/src/api.ts` 中 `req` 函式，若它無條件 `res.json()`，在 `req` 中加入 `if (res.status === 204) return undefined as T;`（放在解析 body 之前）。

- [ ] **Step 4：頁面**

`admin/src/pages/McpServersPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { api, UnauthorizedError, type McpServerListView, type McpServerView, type Tenant } from '../api';
import { useAuth } from '../auth';
import { emptyMcpForm, statusLabel, toFormValues, toPayload, validateMcpForm, type McpServerFormValues } from './mcpForm.util';

/**
 * MCP 服務（平台層）：登記自建 MCP server、測試連線、檢視工具讀寫判定並覆寫。
 * 授權在各租戶的權限分頁授予 mcp:<serverId>。
 */
export default function McpServersPage() {
  const [view, setView] = useState<McpServerListView | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ isNew: boolean; values: McpServerFormValues } | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate('/login');
        return;
      }
      setErr(e instanceof Error ? e.message : String(e));
    },
    [logout, navigate],
  );

  const load = useCallback(async () => {
    try {
      const [v, ts] = await Promise.all([api.listMcpServers(), api.listTenants()]);
      setView(v);
      setTenants(ts);
      setErr(null);
    } catch (e) {
      handle(e);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  function replaceServer(next: McpServerView) {
    setView((v) => (v ? { ...v, servers: v.servers.map((s) => (s.config.id === next.config.id ? next : s)) } : v));
  }

  async function save() {
    if (!editing) return;
    const errors = validateMcpForm(editing.values, editing.isNew);
    setFormErrors(errors);
    if (errors.length > 0) return;
    try {
      const payload = toPayload(editing.values);
      if (editing.isNew) await api.createMcpServer({ id: editing.values.id, ...payload });
      else await api.updateMcpServer(editing.values.id, payload);
      setEditing(null);
      await load();
    } catch (e) {
      handle(e);
    }
  }

  async function refresh(id: string) {
    setBusyId(id);
    try {
      replaceServer(await api.refreshMcpServer(id));
    } catch (e) {
      handle(e);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`確定刪除 MCP 服務「${id}」？已授予的 mcp:${id} 權限將失去作用。`)) return;
    try {
      await api.deleteMcpServer(id);
      await load();
    } catch (e) {
      handle(e);
    }
  }

  async function setOverride(server: McpServerView, tool: string, patch: { disabled?: boolean; requireConfirm?: boolean; cardTitle?: string }) {
    const cur = server.config.toolOverrides[tool] ?? {};
    try {
      replaceServer(
        await api.updateMcpServer(server.config.id, {
          toolOverrides: { ...server.config.toolOverrides, [tool]: { ...cur, ...patch } },
        }),
      );
    } catch (e) {
      handle(e);
    }
  }

  const tenantName = (id: string | null) => (id ? (tenants.find((t) => t.id === id)?.name ?? id) : '共用');

  return (
    <AppLayout crumb="平台" title="MCP 服務">
      {err && <div className="card"><div className="empty">{err}</div></div>}
      {view && !view.signingEnabled && (
        <div className="card"><div className="empty">尚未設定 MCP_SIGNING_KEY：MCP 功能停用中，AI 不會呼叫任何 MCP 工具。</div></div>
      )}
      {!view && !err && <div className="card"><div className="empty">載入中…</div></div>}

      {view && (
        <div className="card">
          <div className="card-head">
            <h3>已登記的服務</h3>
            <button type="button" className="btn primary" onClick={() => { setFormErrors([]); setEditing({ isNew: true, values: emptyMcpForm() }); }}>
              新增 MCP 服務
            </button>
          </div>
          {view.servers.length === 0 && <div className="empty">尚未登記任何 MCP 服務</div>}
          {view.servers.map((s) => (
            <section key={s.config.id} className="mcp-server">
              <header>
                <strong>{s.config.name}</strong> <code>{s.config.id}</code>
                <span className="tag">{tenantName(s.config.ownerTenantId)}</span>
                <span className="tag">{s.config.enabled ? '啟用' : '停用'}</span>
                <span className="tag" title={s.status.lastError}>{statusLabel(s.status.state)}</span>
              </header>
              <div className="muted">{s.config.url}</div>
              {s.status.lastError && <div className="muted">最後錯誤：{s.status.lastError}</div>}
              <div className="actions">
                <button type="button" className="btn" disabled={busyId === s.config.id} onClick={() => void refresh(s.config.id)}>
                  {busyId === s.config.id ? '連線中…' : '測試連線／重新整理'}
                </button>
                <button type="button" className="btn" onClick={() => { setFormErrors([]); setEditing({ isNew: false, values: toFormValues(s.config) }); }}>編輯</button>
                <button type="button" className="btn danger" onClick={() => void remove(s.config.id)}>刪除</button>
              </div>
              {s.tools.length > 0 && (
                <table className="table">
                  <thead>
                    <tr><th>工具</th><th>判定</th><th>停用</th><th>強制確認</th><th>卡片標題</th><th>問題</th></tr>
                  </thead>
                  <tbody>
                    {s.tools.map((t) => (
                      <tr key={t.name} className={t.problem ? 'row-error' : undefined}>
                        <td>{t.title ?? t.name}<div className="muted"><code>{t.name}</code></div></td>
                        <td>{t.effect === 'read' ? '唯讀' : '寫入（需確認）'}</td>
                        <td>
                          <input type="checkbox" checked={t.disabled} onChange={(e) => void setOverride(s, t.name, { disabled: e.target.checked })} />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={s.config.toolOverrides[t.name]?.requireConfirm === true}
                            onChange={(e) => void setOverride(s, t.name, { requireConfirm: e.target.checked })}
                          />
                        </td>
                        <td>
                          {t.effect === 'write' && (
                            <input
                              key={`${s.config.id}/${t.name}/${s.config.toolOverrides[t.name]?.cardTitle ?? ''}`}
                              defaultValue={s.config.toolOverrides[t.name]?.cardTitle ?? ''}
                              placeholder={t.title ?? t.name}
                              maxLength={60}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next !== (s.config.toolOverrides[t.name]?.cardTitle ?? '')) {
                                  void setOverride(s, t.name, { cardTitle: next || undefined });
                                }
                              }}
                            />
                          )}
                        </td>
                        <td>{t.problem === 'name_invalid' ? '名稱不合法或過長，不會給 AI 使用' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}

      {editing && (
        <div className="card">
          <h3>{editing.isNew ? '新增 MCP 服務' : `編輯：${editing.values.id}`}</h3>
          {formErrors.length > 0 && <ul className="form-errors">{formErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="form-grid">
            <label>serverId
              <input value={editing.values.id} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, id: e.target.value } })} />
            </label>
            <label>名稱
              <input value={editing.values.name} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, name: e.target.value } })} />
            </label>
            <label>URL（Streamable HTTP）
              <input value={editing.values.url} placeholder="https://rooms.example.com/mcp" onChange={(e) => setEditing({ ...editing, values: { ...editing.values, url: e.target.value } })} />
            </label>
            <label>擁有租戶
              <select value={editing.values.ownerTenantId} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, ownerTenantId: e.target.value } })}>
                <option value="">共用（所有租戶皆可被授權）</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}（專屬）</option>)}
              </select>
            </label>
            <label>能力描述（AI 路由與提示詞會用到）
              <textarea value={editing.values.description} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, description: e.target.value } })} />
            </label>
            <label>路由關鍵字（逗號或頓號分隔）
              <input value={editing.values.keywords} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, keywords: e.target.value } })} />
            </label>
            <label>逾時（秒）
              <input value={editing.values.timeoutSeconds} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, timeoutSeconds: e.target.value } })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={editing.values.enabled} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, enabled: e.target.checked } })} />
              啟用
            </label>
          </div>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void save()}>儲存</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
```

> 樣式：沿用既有 class（`card`、`btn`、`table`、`tag`、`muted`、`empty`）。若 `admin/src/index.css` 沒有 `mcp-server`、`row-error`、`form-grid`、`form-errors`、`actions`、`card-head` 的定義，在檔尾加：

```css
.mcp-server { border-top: 1px solid var(--border-color, #e5e7eb); padding: 1rem 0; }
.mcp-server header { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
.form-grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.form-grid label { display: flex; flex-direction: column; gap: .25rem; }
.form-grid label.checkbox { flex-direction: row; align-items: center; }
.form-errors { color: #b91c1c; }
.row-error td { color: #b91c1c; }
```

- [ ] **Step 5：路由與導覽**

`admin/src/App.tsx`：import 區加 `import McpServersPage from './pages/McpServersPage';`；在 `path="/skills"` 的 `<Route ... />` 之後、`<Route path="*" ...>` 之前加：

```tsx
          <Route
            path="/mcp-servers"
            element={
              <RequireAuth>
                <McpServersPage />
              </RequireAuth>
            }
          />
```

`admin/src/components/AppLayout.tsx`：在「平台」區的 Skill Library `nav-item` 之後加：

```tsx
          <div
            className={`nav-item${loc.pathname === "/mcp-servers" ? " active" : ""}`}
            onClick={() => go("/mcp-servers")}
            role="button"
            tabIndex={0}
          >
            <IconTenants className="nav-ico" />
            MCP 服務
          </div>
```

（`onTenants` 只在 `/` 與 `/tenants*` 成立，不需修改。）

- [ ] **Step 6：測試、型別、commit**

Run: `cd admin && npx vitest run src/pages/mcpForm.util.test.ts && npm run typecheck`
Expected: PASS，型別無錯誤。

```bash
git add admin/src
git commit -m "$(cat <<'EOF'
feat(admin): 新增平台層「MCP 服務」管理頁

登記、編輯、刪除 MCP server，測試連線並列出工具讀寫判定，可逐一停用或強制確認；
未設簽章金鑰時顯示停用提示。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13：Web 前台確認卡片

**Files:**
- Create: `client/src/ConfirmActionCard.tsx`
- Create: `client/src/ConfirmActionCard.test.tsx`
- Modify: `client/src/api.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/i18n.ts`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: Task 4 HTTP API；`PendingActionView`（`@hyagent/shared`）
- Produces:
  - `TurnData.pendingAction?: PendingActionView`、`TurnData.actionOk?: boolean`
  - `api.confirmAction(userId, convId, actionId): Promise<TurnData>`、`api.cancelAction(userId, convId, actionId): Promise<TurnData>`
  - `ConfirmActionCard` props：`{ action: PendingActionView; onConfirm(): Promise<{ ok: boolean; reply: string }>; onCancel(): Promise<{ reply: string }> }`；根元素 `data-phase` 為 `ready | busy | done | failed | cancelled | expired`

- [ ] **Step 1：寫失敗測試**

`client/src/ConfirmActionCard.test.tsx`：

```tsx
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import './i18n';
import { ConfirmActionCard } from './ConfirmActionCard';
import { ApiError } from './api';
import type { PendingActionView } from '@hyagent/shared';

const action: PendingActionView = {
  id: 'a1',
  summary: { title: '預約會議室', fields: [{ label: '會議室', value: 'A' }, { label: '日期', value: '2026-10-04' }] },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function card() {
  return screen.getByTestId('confirm-action-card');
}

describe('ConfirmActionCard', () => {
  it('顯示標題與欄位', () => {
    render(<ConfirmActionCard action={action} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('預約會議室')).toBeInTheDocument();
    expect(screen.getByText('會議室')).toBeInTheDocument();
    expect(screen.getByText('2026-10-04')).toBeInTheDocument();
    expect(card()).toHaveAttribute('data-phase', 'ready');
  });

  it('確認成功 → done，按鈕消失；只呼叫一次', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'done'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('action-confirm')).not.toBeInTheDocument();
  });

  it('確認但執行失敗（ok=false）→ failed', async () => {
    render(<ConfirmActionCard action={action} onConfirm={vi.fn().mockResolvedValue({ ok: false, reply: '失敗' })} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'failed'));
  });

  it('409 ACTION_EXPIRED → expired', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('已逾時', 409, 'ACTION_EXPIRED'));
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'expired'));
  });

  it('其他錯誤 → failed，顯示錯誤訊息', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('沒有權限', 403, 'FORBIDDEN'));
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByText('沒有權限')).toBeInTheDocument();
  });

  it('取消 → cancelled', async () => {
    const onCancel = vi.fn().mockResolvedValue({ reply: '已取消' });
    render(<ConfirmActionCard action={action} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('action-cancel'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'cancelled'));
  });

  it('已過效期 → 一開始就是 expired，沒有按鈕', () => {
    render(<ConfirmActionCard action={{ ...action, expiresAt: new Date(Date.now() - 1000).toISOString() }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(card()).toHaveAttribute('data-phase', 'expired');
    expect(screen.queryByTestId('action-confirm')).not.toBeInTheDocument();
  });
});
```

Run: `cd client && npx vitest run src/ConfirmActionCard.test.tsx`
Expected: FAIL，找不到模組。

- [ ] **Step 2：API**

`client/src/api.ts`：
- 從 `@hyagent/shared` 的型別 import 中加入 `PendingActionView`（與既有 `ReportRef` 同一個 import 陳述式），並加到檔案中重新匯出型別的清單（與 `ReportRef` 並列）。
- `TurnData` 介面最後加：

```ts
  /** 本回合產生的待確認寫入動作（畫確認卡片） */
  pendingAction?: PendingActionView;
  /** 確認端點回傳：執行是否成功 */
  actionOk?: boolean;
```

- 在 `submit(...)` 方法之後加：

```ts
  /** 確認卡片「確認」：不經 LLM，後端重檢權限後執行 */
  confirmAction(userId: string, convId: string, actionId: string): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/actions/${actionId}/confirm`, {
      method: 'POST',
      headers: headers(userId),
    });
  },

  /** 確認卡片「取消」 */
  cancelAction(userId: string, convId: string, actionId: string): Promise<TurnData> {
    return request<TurnData>(`${BASE}/${convId}/actions/${actionId}/cancel`, {
      method: 'POST',
      headers: headers(userId),
    });
  },
```

- [ ] **Step 3：i18n**

`client/src/i18n.ts`：在 `zhHant` 物件的 `report: {...},` 之後加：

```ts
  action: {
    confirm: "確認執行",
    cancel: "取消",
    running: "執行中…",
    done: "已完成",
    failed: "執行失敗",
    cancelled: "已取消",
    expired: "已失效，請重新提出",
  },
```

在 `en` 物件的 `report: {...},` 之後加：

```ts
  action: {
    confirm: "Confirm",
    cancel: "Cancel",
    running: "Running…",
    done: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
    expired: "Expired. Please ask again.",
  },
```

- [ ] **Step 4：元件**

`client/src/ConfirmActionCard.tsx`：

```tsx
/**
 * 寫入動作確認卡片：AI 提議的寫入（寄信、預約…）在這裡由使用者確認後才執行。
 * 一次性：按下後立刻鎖住，不論成功失敗都不再顯示按鈕（避免雙擊重送）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingActionView } from '@hyagent/shared';
import { ApiError } from './api';

type Phase = 'ready' | 'busy' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface ConfirmActionCardProps {
  action: PendingActionView;
  onConfirm(): Promise<{ ok: boolean; reply: string }>;
  onCancel(): Promise<{ reply: string }>;
}

export function ConfirmActionCard({ action, onConfirm, onCancel }: ConfirmActionCardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(() => (Date.parse(action.expiresAt) <= Date.now() ? 'expired' : 'ready'));
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'confirm' | 'cancel') {
    if (phase !== 'ready') return;
    setPhase('busy');
    try {
      if (kind === 'confirm') {
        const r = await onConfirm();
        setPhase(r.ok ? 'done' : 'failed');
      } else {
        await onCancel();
        setPhase('cancelled');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'ACTION_EXPIRED') {
        setPhase('expired');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }

  const statusText: Partial<Record<Phase, string>> = {
    busy: t('action.running'),
    done: t('action.done'),
    failed: t('action.failed'),
    cancelled: t('action.cancelled'),
    expired: t('action.expired'),
  };

  return (
    <div className="confirm-card" data-testid="confirm-action-card" data-phase={phase}>
      <div className="confirm-card-title">{action.summary.title}</div>
      <dl className="confirm-card-fields">
        {action.summary.fields.map((f) => (
          <div key={f.label} className="confirm-card-field">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {phase === 'ready' || phase === 'busy' ? (
        <div className="confirm-card-actions">
          <button type="button" className="confirm-card-primary" data-testid="action-confirm" disabled={phase === 'busy'} onClick={() => void run('confirm')}>
            {phase === 'busy' ? t('action.running') : t('action.confirm')}
          </button>
          <button type="button" data-testid="action-cancel" disabled={phase === 'busy'} onClick={() => void run('cancel')}>
            {t('action.cancel')}
          </button>
        </div>
      ) : (
        <div className="confirm-card-status" role="status">
          {statusText[phase]}
          {error && <div className="confirm-card-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
```

`client/src/index.css` 檔尾加：

```css
/* 寫入動作確認卡片 */
.confirm-card {
  margin-top: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--card-bg);
}
.confirm-card-title { font-weight: 600; margin-bottom: 0.5rem; }
.confirm-card-fields { display: grid; gap: 0.25rem; margin: 0 0 0.75rem; }
.confirm-card-field { display: grid; grid-template-columns: minmax(4rem, max-content) 1fr; gap: 0.75rem; }
.confirm-card-field dt { opacity: 0.7; }
.confirm-card-field dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.confirm-card-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.confirm-card-actions button { min-height: 2.5rem; padding: 0 1rem; border-radius: 0.5rem; }
.confirm-card-primary { background: var(--primary-color); color: white; border: none; }
.confirm-card-status { opacity: 0.8; }
.confirm-card-error { color: #b91c1c; margin-top: 0.25rem; }
```

- [ ] **Step 5：接進 App**

`client/src/App.tsx`：
- import 區加 `import { ConfirmActionCard } from './ConfirmActionCard';`，並在既有從 `./api` 匯入的型別清單加 `type PendingActionView`。
- 訊息型別（含 `reportId` 欄位的那個介面）加欄位：

```ts
  /** 本則回覆附帶的待確認寫入動作（確認卡片） */
  pendingAction?: PendingActionView;
```

- `pushMsg` 改為：

```ts
  function pushMsg(role: Role, text: string, suggestions?: string[], reportId?: string, pendingAction?: PendingActionView) {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role, text, suggestions, reportId, pendingAction, at: Date.now() },
    ]);
  }
```

- `applyTurn` 中 `if (data.reply) pushMsg('agent', data.reply, data.suggestions, data.report?.id);` 改為：

```ts
    if (data.reply) pushMsg('agent', data.reply, data.suggestions, data.report?.id, data.pendingAction);
```

- 在 `handleCancel` 函式之前加：

```ts
  // 確認卡片：不經 LLM，直接打確認／取消端點；回覆另以一則訊息顯示
  async function confirmPendingAction(action: PendingActionView): Promise<{ ok: boolean; reply: string }> {
    if (!convId) throw new Error('no conversation');
    const turn = await api.confirmAction(userId, convId, action.id);
    if (turn.reply) pushMsg('agent', turn.reply);
    return { ok: turn.actionOk === true, reply: turn.reply ?? '' };
  }

  async function cancelPendingAction(action: PendingActionView): Promise<{ reply: string }> {
    if (!convId) throw new Error('no conversation');
    const turn = await api.cancelAction(userId, convId, action.id);
    if (turn.reply) pushMsg('agent', turn.reply);
    return { reply: turn.reply ?? '' };
  }
```

- 在訊息氣泡內容（`m.text` 所在的 `div`）之後、`<span className="msg-meta">` 之前加：

```tsx
                  {m.pendingAction && (
                    <ConfirmActionCard
                      action={m.pendingAction}
                      onConfirm={() => confirmPendingAction(m.pendingAction!)}
                      onCancel={() => cancelPendingAction(m.pendingAction!)}
                    />
                  )}
```

- [ ] **Step 6：測試、型別、commit**

Run: `cd client && npx vitest run src/ConfirmActionCard.test.tsx && npm test && npm run typecheck`
Expected: 全部 PASS，型別無錯誤。

```bash
git add client/src
git commit -m "$(cat <<'EOF'
feat(client): 新增寫入動作確認卡片

AI 提議寫入時在回覆下方顯示卡片（標題與欄位），按確認或取消直接打不經 LLM 的
端點；一次性鎖定防雙擊，已失效、失敗、取消各有狀態顯示。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14：文件與設定

**Files:**
- Modify: `INTEGRATION.md`
- Modify: `DEPLOY.zeabur.md`
- Modify: `server/.env.example`
- Modify: `docs/superpowers/specs/2026-07-08-tool-registry-target-architecture-design.md`
- Modify: `README.md`（文件地圖）

- [ ] **Step 1：`.env.example`**

`server/.env.example` 在 `# DATA_ENCRYPTION_KEY=` 那段之後加：

```bash
# MCP（後端呼叫自建 MCP server）：呼叫身分 JWT 的 ES256 私鑰（PKCS#8 PEM，換行可寫成 \n）。
# 未設＝MCP 功能整體停用。產生方式：
#   node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ec',{namedCurve:'P-256'});console.log(k.privateKey.export({type:'pkcs8',format:'pem'}).replace(/\n/g,'\\n'))"
# MCP_SIGNING_KEY=
# 換鑰過渡：上一把的公鑰（SPKI PEM），讓 MCP server 仍驗得過換鑰前簽的 token
# MCP_PREVIOUS_PUBLIC_KEY=
```

- [ ] **Step 2：部署文件**

`DEPLOY.zeabur.md` 的「server 服務」環境變數表，在 `JWT_ACCESS_SECRET` 那一列之後加兩列（欄位依該表：變數｜必填｜範例 / 說明）：

```markdown
| `MCP_SIGNING_KEY`    | 視需要   | 要讓 AI 呼叫自建 MCP 服務時必填：ES256 私鑰（PKCS#8 PEM，換行寫成 `\n`）。未設＝MCP 功能停用。產生方式見 `server/.env.example` |
| `MCP_PREVIOUS_PUBLIC_KEY` | 選填 | 換鑰過渡期填上一把的公鑰（SPKI PEM），過渡結束後移除 |
```

並在「先決條件」段落的 DDL 清單中加一項：`server/db/migrations/0019_mcp_servers.sql`（`DATA_BACKEND=db` 時，帶此版本部署前先在 Supabase SQL Editor 套用）。

- [ ] **Step 3：整合文件**

`INTEGRATION.md` 文件末尾加一章：

````markdown
## 自建 MCP 服務（讓 AI 呼叫外部系統）

HyAgent 的智慧代理可以呼叫我們自建的 MCP server。整體流程：

1. **寫 MCP server**：用 [`mcp/kit`](mcp/kit/README.md)（`createMcpHttpApp` + `createHyAgentVerifier`），照 README 的規範寫工具（欄位要有描述、唯讀工具標 `readOnlyHint`）。範例在 `mcp/kit/examples/rooms/`。
2. **部署**：MCP server 要能連到 HyAgent 後端的 `GET /.well-known/hyagent-mcp-jwks.json`（驗章用），HyAgent 後端要能連到 MCP server 的 `/mcp`。
3. **登記**：後台「MCP 服務」→ 新增，填 `serverId`、URL、擁有租戶（共用或某租戶專屬）、能力描述與路由關鍵字，按「測試連線」確認工具清單與讀寫判定。
4. **授權**：在租戶的權限分頁，把 `mcp:<serverId>` 授予要使用的部門或帳號（也需要 `service:agent`）。

### 身分與安全

- HyAgent 每個請求都簽一張 60 秒的 ES256 JWT：`aud` 為 `serverId`、`sub` 為使用者、`tenant` 為租戶、`scopes` 只含 `mcp:<serverId>` 相關項。MCP server 用 `callerFrom(extra)` 取得，可自行做二次權限檢查與稽核。
- 唯讀工具（`readOnlyHint: true`）AI 會直接呼叫；**其餘一律視為寫入**：AI 只能提議，使用者在確認卡片按「確認」後才由後端執行。後台可對單一工具強制確認或停用。
- 後端未設 `MCP_SIGNING_KEY` 時，MCP 功能整體停用。

### 前台整合（自製 UI）

對話 API 的回應若帶 `pendingAction`（`{ id, summary: { title, fields[] }, expiresAt }`），請畫成確認卡片：

- 確認：`POST /api/conversations/:id/actions/:actionId/confirm` → `data.reply`、`data.actionOk`
- 取消：`POST /api/conversations/:id/actions/:actionId/cancel`
- `409 ACTION_EXPIRED`：已逾時（10 分鐘），請使用者重新提出；`409 ACTION_NOT_FOUND`：已處理過；`403`：權限已撤銷。
- 沒有畫卡片的舊前台，使用者打「確認」也能執行（打字備援）。
````

- [ ] **Step 4：設計文件註記**

`docs/superpowers/specs/2026-07-08-tool-registry-target-architecture-design.md` 的檔頭 `**狀態**` 那一行之後加：

```markdown
**後續**：D2「非 C MCP」與 §9「不做 MCP 式外掛」已由 [2026-10-03 後端 MCP Client 設計](2026-10-03-mcp-client-design.md) 取代（MCP 作為 ToolDef 的動態來源，工具即一等公民不變）。
```

- [ ] **Step 5：README 文件地圖**

`README.md` 的「文件地圖」表格，在 `INTEGRATION.md` 那一列之後加：

```markdown
| [`mcp/kit/README.md`](mcp/kit/README.md) | 自建 MCP server：驗 HyAgent 呼叫身分、工具撰寫規範、範例 |
```

並在「專案結構」區塊的 `sdk/` 那一行之後加：

```
├─ mcp/kit/            自建 MCP server 套件 @hyagent/mcp-kit（驗 HyAgent 呼叫 JWT + 無狀態 MCP app + 範例）
```

- [ ] **Step 6：全專案驗證與 commit**

Run: `npm run typecheck && npm test`
Expected: 所有 workspace 型別無錯誤、測試全部 PASS。

```bash
git add INTEGRATION.md DEPLOY.zeabur.md server/.env.example docs/superpowers/specs/2026-07-08-tool-registry-target-architecture-design.md README.md
git commit -m "$(cat <<'EOF'
docs(mcp): 補上自建 MCP 服務的整合、部署與設定說明

INTEGRATION 新增自建 MCP 章節（流程、身分與安全、確認卡片 API）；部署文件補
MCP_SIGNING_KEY 與 0019 DDL；tool-registry 藍圖註記 D2 已被取代。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## 實機驗收（全部任務完成後，人工執行）

1. 本機產生一把 ES256 私鑰，**只在本次指令的環境變數**帶入（不寫進 `server/.env`），以 file 模式啟動後端：
   `cd server && DATA_BACKEND=file MCP_SIGNING_KEY="<私鑰>" npm run dev`
2. 啟動範例 MCP server：`HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json MCP_SERVER_ID=rooms PORT=4100 npm run example:rooms -w mcp/kit`
3. 後台登記 `rooms`（URL `http://localhost:4100/mcp`、關鍵字「會議室、預約、空檔」），測試連線看到兩個工具（一讀一寫）。
4. 預設租戶授予 `service:agent` 與 `mcp:rooms`。
5. Web 前台問「明天下午有哪間會議室可以用？」→ 直接回答；再說「幫我訂大會議室 A 明天 14:00 到 15:00，會議名稱週會」→ 出現確認卡片；按確認 → 回覆已完成並附預約編號。
````
