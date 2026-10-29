/**
 * 端到端：HyAgent agent（假 LLM）→ MCP（JWT 驗章）→ db-intelligence → 政策 → SQL。
 * 驗證身分與角色從 HyAgent 傳到 db-intelligence：租戶／使用者取自 session，角色取自後台授予的
 * `mcp:db-intelligence:<role>`，資料列範圍取自 db-intelligence 的使用者目錄；拒絕原因如實回給模型。
 * 真實模型的回答品質另見 scripts/dbi-e2e-eval.ts。
 */
const llmCreate = jest.fn();
jest.mock('@/lib/llm', () => {
  const actual = jest.requireActual('@/lib/llm');
  return { ...actual, getLLMProvider: () => ({ name: 'fake', createMessage: llmCreate }) };
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import {
  applyCatalogReview,
  buildDiscoveredSchema,
  createDbIntelligenceApp,
  DbIntelligenceService,
  DbiState,
  directoryResolver,
  MemoryAuditSink,
  MemoryCatalogStore,
  syncCatalog,
  type CompiledQuery,
} from '@hyagent/db-intelligence';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { mcpConnections } from '@/modules/mcp/mcp.connection';
import { mcpToolFingerprint } from '@/modules/mcp/mcp.fingerprint';
import { configureMcpSigningKey, mcpJwks } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
const usage = { inputTokens: 1, outputTokens: 1 };
const res = (p: Record<string, unknown>) => ({ text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'm', keySource: 'platform', ...p });

let http: Server;
let tenantId: string;
let executed: CompiledQuery[];
let audit: MemoryAuditSink;

function discovered() {
  const col = (object_name: string, name: string, data_type: string, ordinal: number) => ({ schema_name: 'public', object_name, name, data_type, nullable: false, ordinal, comment: null });
  return buildDiscoveredSchema(
    ['public'],
    null,
    [
      { schema_name: 'public', object_name: 'projects', relkind: 'r', comment: null },
      { schema_name: 'public', object_name: 'employee_salary', relkind: 'r', comment: null },
    ],
    [col('projects', 'name', 'text', 1), col('projects', 'department_id', 'integer', 2), col('employee_salary', 'salary', 'integer', 1)],
    [],
    [],
  );
}

beforeEach(async () => {
  llmCreate.mockReset();
  executed = [];
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  tenantId = tenantStore.createTenant(`dbi-e2e-${Date.now()}`).id;
  tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });

  const catalogs = new MemoryCatalogStore();
  const { catalog } = syncCatalog(undefined, discovered(), { dataSourceId: 'ds1', tenantId });
  await catalogs.save(
    applyCatalogReview(catalog, {
      datasets: [
        { id: 'public.projects', approvalStatus: 'approved', columns: { name: { isQueryable: true }, department_id: { isQueryable: true } } },
        { id: 'public.employee_salary', approvalStatus: 'approved', columns: { salary: { isQueryable: true, sensitivity: 'confidential' } } },
      ],
      publish: true,
    }),
  );
  const state = new DbiState({
    dataSources: [{ id: 'ds1', tenantId, dbType: 'postgres', schemas: ['public'], connectionEnv: 'UNUSED', timezone: 'Asia/Taipei' }],
    policies: {
      version: 'v1',
      policies: [
        { id: 'employee-own-dept', tenantId, dataSourceId: 'ds1', dataset: 'public.projects', principals: { users: [], roles: ['employee'] }, columns: ['*'], masked: {}, rowScope: [{ column: 'department_id', attribute: 'departmentId' }], aggregateOnly: false },
        { id: 'manager-all', tenantId, dataSourceId: 'ds1', dataset: 'public.projects', principals: { users: [], roles: ['manager'] }, columns: ['*'], masked: {}, rowScope: [], aggregateOnly: false },
      ],
    },
    principals: { [tenantId]: { alice: { roles: ['employee'], attributes: { departmentId: 1 } } } },
  });
  audit = new MemoryAuditSink();
  const dbi = createDbIntelligenceApp({
    verifier: createHyAgentVerifier({ jwksUrl: 'http://unused', audience: 'db-intelligence', fetchJwks: async () => mcpJwks() as never, rejectReplay: true }),
    service: new DbIntelligenceService({
      dataSources: () => state.dataSources(),
      catalogs,
      policies: () => state.policies(),
      principals: directoryResolver(() => state.principals(), { serverId: 'db-intelligence' }),
      executor: {
        async execute(_id, q) {
          executed.push(q);
          return { columns: q.columns, rows: [['官網改版', 1]], truncated: false, dbTimeMs: 1 };
        },
      },
      audit,
    }),
  });
  http = await new Promise((r) => { const s = dbi.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

  // 經後台 API 登記（含角色），核准唯讀工具，並授予 scope——與管理員實際操作相同的路徑
  await request(app).post('/api/admin/mcp-servers').set(admin).send({ id: 'db-intelligence', name: '資料庫查詢', url, roles: ['manager'], description: '查詢公司專案資料' }).expect(201);
  const config = mcpStore.get('db-intelligence')!;
  const tools = await mcpConnections.get(config).listTools();
  mcpStore.update(config.id, {
    toolOverrides: Object.fromEntries(tools.map((t) => [t.name, { approvedReadOnly: true, approvedFingerprint: mcpToolFingerprint(config.url, t) }])),
  });
  await request(app)
    .put(`/api/admin/tenants/${tenantId}/policy`)
    .set(admin)
    .send({ grantedScopes: ['service:agent'], groups: {}, accounts: { alice: ['mcp:db-intelligence'], bob: ['mcp:db-intelligence', 'mcp:db-intelligence:manager'] } })
    .expect(200);
});

afterEach(async () => {
  await mcpConnections.closeAll();
  await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); });
  mcpStore.clear();
  scopePolicy.clear();
  configureMcpSigningKey(null);
});

const session = (userId: string) =>
  ({ id: `s-${userId}`, tenantId, userId, formId: '', values: {}, status: 'collecting', activeServiceId: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: '我的部門有哪些專案？' }] }], createdAt: new Date().toISOString() }) as unknown as Session;

const plan = (dataset: string, field: string) => ({ version: '1.0', data_source_id: 'ds1', dataset, select: [{ field }] });

async function ask(userId: string, toolInput: Record<string, unknown>): Promise<string> {
  llmCreate
    .mockResolvedValueOnce(res({ toolCalls: [{ id: 't1', name: 'mcp_db-intelligence_execute_safe_query', input: toolInput }], stopReason: 'tool_use' }))
    .mockResolvedValueOnce(res({ text: '完成' }));
  await agentAgentService.handleTurn(session(userId), '我的部門有哪些專案？', { name: 'fake', createMessage: llmCreate });
  // 第二次呼叫模型時帶的訊息裡含工具結果
  return JSON.stringify(llmCreate.mock.calls[1][0].messages);
}

describe('HyAgent → db-intelligence 端到端', () => {
  it('四個工具以唯讀暴露給模型', async () => {
    llmCreate.mockResolvedValueOnce(res({ text: 'hi' }));
    await agentAgentService.handleTurn(session('alice'), 'hi', { name: 'fake', createMessage: llmCreate });
    const names = (llmCreate.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name).filter((n) => n.startsWith('mcp_db-intelligence_'));
    expect(names.sort()).toEqual(['execute_safe_query', 'get_dataset_details', 'get_query_result', 'search_schema'].map((n) => `mcp_db-intelligence_${n}`));
  });

  it('員工：身分來自 session，部門範圍來自使用者目錄，結果回到模型', async () => {
    const toolResult = await ask('alice', { query_plan: plan('projects', 'name') });
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toContain('t0."department_id" = $1');
    expect(executed[0].params[0]).toBe(1);
    expect(toolResult).toContain('官網改版');
    expect(audit.events[0]).toMatchObject({ tenant_id: tenantId, principal_id: 'alice', status: 'success', policy_ids: ['employee-own-dept'] });
  });

  it('主管：角色來自後台授予的 mcp:db-intelligence:manager，不受部門限制', async () => {
    await ask('bob', { query_plan: plan('projects', 'name') });
    expect(executed[0].sql).not.toContain('WHERE');
    expect(audit.events[0]).toMatchObject({ principal_id: 'bob', policy_ids: ['manager-all'] });
  });

  it('模型夾帶 tenant_id：HyAgent 依工具 schema 先擋下，請求不會送到 db-intelligence', async () => {
    const toolResult = await ask('alice', { query_plan: { ...plan('projects', 'name'), tenant_id: 'other' } });
    expect(toolResult).toContain('must NOT have additional properties');
    expect(executed).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it('越權查詢被拒，錯誤碼如實回給模型並留稽核', async () => {
    const toolResult = await ask('alice', { query_plan: plan('employee_salary', 'salary') });
    expect(toolResult).toContain('QUERY_POLICY_DENIED');
    expect(executed).toHaveLength(0);
    expect(audit.events[0]).toMatchObject({ principal_id: 'alice', status: 'denied', reason_code: 'QUERY_POLICY_DENIED' });
  });

  it('後台只能授予服務宣告過的角色', async () => {
    const r = await request(app)
      .put(`/api/admin/tenants/${tenantId}/policy`)
      .set(admin)
      .send({ grantedScopes: [], groups: {}, accounts: { bob: ['mcp:db-intelligence:admin'] } });
    expect(r.status).toBe(400);
    const caps = await request(app).get(`/api/admin/tenants/${tenantId}/policy`).set(admin);
    const ids = (caps.body.data.capabilities as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['mcp:db-intelligence', 'mcp:db-intelligence:manager']));
  });
});
