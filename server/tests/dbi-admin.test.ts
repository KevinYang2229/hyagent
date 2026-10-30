/**
 * 後台 Database Intelligence API：經 server 轉發到真實的 db-intelligence 管理端點（JWT 驗章）。
 * 驗證：需管理金鑰、白名單路徑、租戶需存在、管理身分 scope、對方拒絕時不回 401、稽核只記欄位名。
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import {
  applyCatalogReview,
  buildDiscoveredSchema,
  configSchema,
  createDbIntelligenceApp,
  DbIntelligenceService,
  DbiState,
  directoryResolver,
  MemoryCatalogStore,
  PoolRegistry,
  RingAuditSink,
  syncCatalog,
} from '@hyagent/db-intelligence';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion/keygen';
import { PLATFORM_AUDIT_TENANT } from '@/modules/audit/admin-audit';
import { auditStore } from '@/modules/audit/audit.store';
import { dbiAdminUrl } from '@/modules/db-intelligence/dbi.admin.routes';
import { configureMcpSigningKey, mcpJwks, signMcpToken } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const admin = { 'x-admin-key': 'test-admin-key' };
const DBI = path.resolve(__dirname, '../../mcp/db-intelligence');

let http: Server;
let url: string;
let tenantId: string;
let catalogs: MemoryCatalogStore;

beforeEach(async () => {
  configureMcpSigningKey(generateHyAgentKeyPair('ES256').privateKeyPem);
  tenantId = tenantStore.createTenant(`dbi-admin-${Date.now()}`).id;
  // Demo 設定換成本測試的租戶
  const config = configSchema.parse(JSON.parse(readFileSync(path.join(DBI, 'config/demo.json'), 'utf8').replaceAll('"demo"', JSON.stringify(tenantId))));
  const state = new DbiState(config);
  catalogs = new MemoryCatalogStore();
  const discovered = buildDiscoveredSchema(
    ['public'],
    null,
    [{ schema_name: 'public', object_name: 'projects', relkind: 'r', comment: null }],
    [{ schema_name: 'public', object_name: 'projects', name: 'name', data_type: 'text', nullable: false, ordinal: 1, comment: null }],
    [],
    [],
  );
  await catalogs.save(applyCatalogReview(syncCatalog(undefined, discovered, { dataSourceId: 'ds_project_01', tenantId }).catalog, { publish: true }));
  const audit = new RingAuditSink();
  const dbi = createDbIntelligenceApp({
    verifier: createHyAgentVerifier({ jwksUrl: 'http://unused', audience: 'db-intelligence', fetchJwks: async () => mcpJwks() as never, rejectReplay: true }),
    service: new DbIntelligenceService({
      dataSources: () => state.dataSources(),
      catalogs,
      policies: () => state.policies(),
      principals: directoryResolver(() => state.principals(), { serverId: 'db-intelligence' }),
      executor: { execute: async () => { throw new Error('不應執行'); } },
      audit,
    }),
    admin: { state, catalogs, pools: new PoolRegistry(() => state.dataSources(), { env: {} }), audit, serverId: 'db-intelligence' },
  });
  http = await new Promise((r) => { const s = dbi.listen(0, '127.0.0.1', () => r(s)); });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  mcpStore.create({ id: 'db-intelligence', name: '資料庫查詢', url });
});

afterEach(async () => {
  await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); });
  mcpStore.clear();
  auditStore.clear();
  configureMcpSigningKey(null);
});

const base = '/api/admin/db-intelligence/db-intelligence';

describe('後台 Database Intelligence API', () => {
  it('需要管理金鑰；未登記的 server 404', async () => {
    expect((await request(app).get(`${base}/data-sources`)).status).toBe(401);
    expect((await request(app).get('/api/admin/db-intelligence/nope/data-sources').set(admin)).status).toBe(404);
  });

  it('列資料來源：轉發到 MCP server，回應原樣帶回', async () => {
    const r = await request(app).get(`${base}/data-sources`).query({ tenant_id: tenantId, other: 'x' }).set(admin);
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ id: 'ds_project_01', tenantId, connectionConfigured: false, catalog: { version: 2, published: true } });
  });

  it('白名單以外的路徑不轉發', async () => {
    expect((await request(app).get(`${base}/state`).set(admin)).status).toBe(404);
    expect((await request(app).post(`${base}/data-sources`).set(admin).send({})).status).toBe(404);
  });

  it('不存在的租戶在 server 端就擋下', async () => {
    const r = await request(app).put(`${base}/tenants/no-such-tenant/policies`).set(admin).send({ policies: [] });
    expect(r.status).toBe(400);
    const ds = await request(app).put(`${base}/data-sources/ds2`).set(admin).send({ tenantId: 'no-such-tenant', dbType: 'postgres', schemas: ['public'], connectionEnv: 'X' });
    expect(ds.status).toBe(400);
  });

  it('改政策 → 預覽查詢；JWT scope 推導角色；稽核只記欄位名不記內容', async () => {
    const policies = [{ id: 'analyst-projects', tenantId, dataSourceId: 'ds_project_01', dataset: 'public.projects', principals: { roles: ['analyst'] }, columns: ['name'] }];
    const put = await request(app).put(`${base}/tenants/${tenantId}/policies`).set(admin).send({ policies });
    expect(put.status).toBe(200);
    expect(put.body.data.warnings).toEqual([]);

    await request(app).patch(`${base}/data-sources/ds_project_01/catalog`).set(admin).send({ datasets: [{ id: 'public.projects', approvalStatus: 'approved', columns: { name: { isQueryable: true } } }] });
    const plan = { version: '1.0', data_source_id: 'ds_project_01', dataset: 'projects', select: [{ field: 'name' }] };
    const preview = await request(app).post(`${base}/query/preview`).set(admin).send({ tenant_id: tenantId, user_id: 'zoe', scopes: ['mcp:db-intelligence:analyst'], query_plan: plan });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ policy_ids: ['analyst-projects'], principal: { roles: ['analyst'] } });
    const denied = await request(app).post(`${base}/query/preview`).set(admin).send({ tenant_id: tenantId, user_id: 'zoe', query_plan: plan });
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('QUERY_POLICY_DENIED');

    const entries = auditStore.list(PLATFORM_AUDIT_TENANT);
    const summaries = entries.map((e) => e.summary).join('\n');
    expect(summaries).toContain(`PUT /db-intelligence/db-intelligence/tenants/${tenantId}/policies`);
    expect(summaries).toContain('欄位：policies');
    expect(JSON.stringify(entries)).not.toContain('analyst-projects');
  });

  it('新開放機密欄位：試算參數轉發；未確認的 409 與欄位清單原樣帶回後台', async () => {
    await request(app).patch(`${base}/data-sources/ds_project_01/catalog`).set(admin).send({
      datasets: [{ id: 'public.projects', approvalStatus: 'approved', columns: { name: { isQueryable: true, sensitivity: 'confidential' } } }],
    });
    const policies = [{ id: 'p-name', tenantId, dataSourceId: 'ds_project_01', dataset: 'public.projects', principals: { roles: ['analyst'] }, columns: ['name'] }];
    const dry = await request(app).put(`${base}/tenants/${tenantId}/policies?dry_run=1`).set(admin).send({ policies });
    expect(dry.body.data).toMatchObject({ saved: false, sensitive: [{ column: 'name', sensitivity: 'confidential' }] });
    const refused = await request(app).put(`${base}/tenants/${tenantId}/policies`).set(admin).send({ policies });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'SENSITIVE_COLUMNS_UNCONFIRMED', details: { sensitive: [{ column: 'name' }] } });
    const ok = await request(app).put(`${base}/tenants/${tenantId}/policies`).set(admin).send({ policies, confirmSensitiveColumns: true });
    expect(ok.body.data.saved).toBe(true);
  });

  it('MCP server 拒絕管理身分時回 502，而不是讓後台以為自己被登出', async () => {
    // 同一個 URL 以不同 serverId 登記：JWT 的 aud 對不上
    mcpStore.create({ id: 'dbi-wrong-aud', name: 'x', url });
    const r = await request(app).get('/api/admin/db-intelligence/dbi-wrong-aud/data-sources').set(admin);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('DBI_AUTH_FAILED');
  });

  it('使用者 JWT 與一般系統 JWT 打不進管理端點', async () => {
    const callers: Parameters<typeof signMcpToken>[1][] = ['system', { tenantId, userId: 'bob', scopes: ['mcp:db-intelligence', 'hyagent:admin'] }];
    for (const who of callers) {
      const res = await fetch(dbiAdminUrl(url, '/data-sources'), { headers: { authorization: `Bearer ${signMcpToken('db-intelligence', who)}` } });
      expect(res.status).toBe(403);
    }
  });

  it('管理端點網址由 MCP 端點推導', () => {
    expect(dbiAdminUrl('https://dbi.example.com/mcp', '/audit', { limit: '5', x: 'y' }).toString()).toBe('https://dbi.example.com/admin/audit?limit=5');
    expect(dbiAdminUrl('https://x.example.com/tenant-a/mcp/', '/data-sources').toString()).toBe('https://x.example.com/tenant-a/admin/data-sources');
  });
});
