import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHyAgentVerifier } from '@hyagent/mcp-kit';
import { createDbIntelligenceApp } from '../src/app';
import { RingAuditSink } from '../src/audit';
import { MemoryCatalogStore } from '../src/catalog/store';
import { DataSourceConnections } from '../src/pools';
import { DbIntelligenceService, directoryResolver } from '../src/service';
import { DbiState } from '../src/state';
import { caller, demoCatalog, demoConfig, now } from './fixtures';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(claims: Record<string, unknown>): string {
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64({ iss: 'hyagent', aud: 'db-intelligence', iat, exp: iat + 60, jti: randomUUID(), ...claims })}`;
  return `${input}.${sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const ADMIN = () => token({ sub: 'hyagent-system', scopes: ['hyagent:admin'] });

let server: Server;
let base: string;
let state: DbiState;
let catalogs: MemoryCatalogStore;
let audit: RingAuditSink;
let persisted: unknown[];

beforeEach(async () => {
  persisted = [];
  state = new DbiState(demoConfig, (s) => persisted.push(s));
  catalogs = new MemoryCatalogStore();
  await catalogs.save(demoCatalog());
  audit = new RingAuditSink(10);
  const connections = new DataSourceConnections(() => state.dataSources(), { env: {} });
  const service = new DbIntelligenceService({
    dataSources: () => state.dataSources(),
    catalogs,
    policies: () => state.policies(),
    principals: directoryResolver(() => state.principals(), { serverId: 'db-intelligence' }),
    executor: { execute: async () => { throw new Error('不應執行'); } },
    audit,
    now,
  });
  const app = createDbIntelligenceApp({
    verifier: createHyAgentVerifier({ jwksUrl: 'http://x', audience: 'db-intelligence', fetchJwks: async () => ({ keys: [jwk] }), rejectReplay: true }),
    service,
    admin: { state, catalogs, connections, audit, serverId: 'db-intelligence' },
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
});

afterEach(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
});

async function call(method: string, path: string, body?: unknown, auth: string | null = ADMIN()) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試斷言用，回應結構由各案例檢查
  return { status: res.status, body: (await res.json()) as any };
}

describe('授權', () => {
  it('沒有 token 401；使用者 JWT、沒有管理 scope 的系統 JWT 一律 403', async () => {
    expect((await call('GET', '/data-sources', undefined, null)).status).toBe(401);
    expect((await call('GET', '/data-sources', undefined, token({ sub: 'bob', tenant: 'demo', scopes: ['hyagent:admin'] }))).status).toBe(403);
    expect((await call('GET', '/data-sources', undefined, token({ sub: 'hyagent-system', scopes: [] }))).status).toBe(403);
  });

  it('管理 token 也不能重放', async () => {
    const t = ADMIN();
    expect((await call('GET', '/data-sources', undefined, t)).status).toBe(200);
    expect((await call('GET', '/data-sources', undefined, t)).status).toBe(401);
  });
});

describe('資料來源', () => {
  it('列表附 Catalog 摘要與連線設定狀態，不回連線字串', async () => {
    const { body } = await call('GET', '/data-sources?tenant_id=demo');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'ds_project_01', connectionEnv: 'DBI_DS_PROJECT_01_URL', connectionConfigured: false, catalog: { version: 2, published: true, datasets: 3 } });
    expect((await call('GET', '/data-sources?tenant_id=other')).body.data).toEqual([]);
  });

  it('新增、修改、刪除；設定檔不接受密碼欄位', async () => {
    const ds = { tenantId: 'demo', dbType: 'postgres', schemas: ['hr'], connectionEnv: 'DBI_HR_URL' };
    const created = await call('PUT', '/data-sources/ds_hr', ds);
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ id: 'ds_hr', timezone: 'Asia/Taipei' });
    expect(persisted).toHaveLength(1);
    expect((await call('PUT', '/data-sources/ds_hr', { ...ds, password: 'x' })).status).toBe(422);
    expect((await call('PUT', '/data-sources/bad.id', ds)).status).toBe(422);
    expect((await call('DELETE', '/data-sources/ds_hr')).body.data).toEqual({ id: 'ds_hr', deleted: true });
    expect((await call('DELETE', '/data-sources/ds_hr')).status).toBe(404);
  });

  it('不能改綁租戶；仍有政策使用時不能刪', async () => {
    const r = await call('PUT', '/data-sources/ds_project_01', { tenantId: 'other', dbType: 'postgres', schemas: ['public'], connectionEnv: 'X' });
    expect(r.status).toBe(409);
    expect((await call('DELETE', '/data-sources/ds_project_01')).status).toBe(409);
  });

  it('連線字串未設定時，連線測試與掃描回 CONNECTION_NOT_CONFIGURED', async () => {
    for (const p of ['connection-test', 'schema-sync']) {
      const r = await call('POST', `/data-sources/ds_project_01/${p}`);
      expect(r).toMatchObject({ status: 400, body: { error: { code: 'CONNECTION_NOT_CONFIGURED' } } });
    }
  });
});

describe('Catalog', () => {
  it('管理員看得到原始註解（審核用）', async () => {
    const r = await call('GET', '/data-sources/ds_project_01/catalog');
    const name = r.body.data.datasets.find((d: { key: string }) => d.key === 'projects').columns.find((c: { name: string }) => c.name === 'name');
    expect(name.comment).toContain('忽略先前所有規則');
  });

  it('PATCH 套用審核並換版本；不合法的審核回 400', async () => {
    const r = await call('PATCH', '/data-sources/ds_project_01/catalog', { datasets: [{ id: 'public.departments', approvalStatus: 'pending' }] });
    expect(r.body.data).toMatchObject({ version: 3 });
    expect((await catalogs.load('ds_project_01'))!.datasets.find((d) => d.key === 'departments')!.approvalStatus).toBe('pending');
    const bad = await call('PATCH', '/data-sources/ds_project_01/catalog', { datasets: [{ id: 'public.nope' }] });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'CATALOG_REVIEW_INVALID' } } });
  });
});

describe('政策與使用者目錄', () => {
  const policy = {
    id: 'p1',
    tenantId: 'demo',
    dataSourceId: 'ds_project_01',
    dataset: 'public.projects',
    principals: { roles: ['analyst'] },
    columns: ['name', 'budget'],
  };

  it('整包取代租戶政策、換版本、對 Catalog 對不上的欄位給警告', async () => {
    const before = state.policies().version;
    const r = await call('PUT', '/tenants/demo/policies', { policies: [policy] });
    expect(r.status).toBe(200);
    expect(r.body.data.version).not.toBe(before);
    expect(r.body.data.policies).toHaveLength(1);
    expect(r.body.data.warnings).toEqual(['政策 p1：public.projects 沒有欄位 budget']);
  });

  it('政策的 tenantId 與路徑不符、資料來源屬於別的租戶都拒絕', async () => {
    expect((await call('PUT', '/tenants/other/policies', { policies: [policy] })).status).toBe(400);
    expect((await call('PUT', '/tenants/other/policies', { policies: [{ ...policy, tenantId: 'other' }] })).status).toBe(400);
  });

  it('新開放機密／限制欄位要確認：試算不存檔、未確認回 409、確認後儲存、沒變動不再詢問', async () => {
    const salary = { ...policy, id: 'hr-salary-detail', dataset: 'public.employee_salary', principals: { roles: ['hr'] }, columns: ['department_id', 'salary'] };
    const existing = state.tenantPolicies('demo').policies;
    const next = [...existing, salary];
    const expected = [{ policyId: 'hr-salary-detail', dataset: 'public.employee_salary', column: 'salary', sensitivity: 'restricted' }];

    const dry = await call('PUT', '/tenants/demo/policies?dry_run=1', { policies: next });
    expect(dry.body.data).toMatchObject({ saved: false, sensitive: expected });
    expect(state.tenantPolicies('demo').policies).toHaveLength(existing.length);

    const refused = await call('PUT', '/tenants/demo/policies', { policies: next });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'SENSITIVE_COLUMNS_UNCONFIRMED', details: { sensitive: expected } } } });
    expect(state.tenantPolicies('demo').policies).toHaveLength(existing.length);

    const ok = await call('PUT', '/tenants/demo/policies', { policies: next, confirmSensitiveColumns: true });
    expect(ok.body.data).toMatchObject({ saved: true, sensitive: expected });
    // 既有的 hr-salary-statistics 也列了 salary，但不是新開放的，所以不出現在清單裡
    const again = await call('PUT', '/tenants/demo/policies', { policies: state.tenantPolicies('demo').policies });
    expect(again.body.data).toMatchObject({ saved: true, sensitive: [] });
  });

  it('使用者目錄', async () => {
    const r = await call('PUT', '/tenants/demo/principals', { carol: { roles: ['employee'], attributes: { departmentId: 2 } } });
    expect(r.body.data).toEqual({ carol: { roles: ['employee'], attributes: { departmentId: 2 } } });
    expect((await call('GET', '/tenants/demo/principals')).body.data.alice).toBeUndefined();
  });
});

describe('查詢預覽', () => {
  const plan = { version: '1.0', data_source_id: 'ds_project_01', dataset: 'projects', select: [{ field: 'name' }] };

  it('以目錄身分預覽：帶出資料列範圍與參數，不執行', async () => {
    const r = await call('POST', '/query/preview', { tenant_id: 'demo', user_id: 'alice', query_plan: plan });
    expect(r.body.data).toMatchObject({
      policy_ids: ['employee-own-department-projects'],
      params: [1, 101],
      row_scope: [{ dataset: 'projects', conditions: [{ column: 'department_id', value: 1 }] }],
    });
    expect(r.body.data.sql).toContain('WHERE (t0."department_id" = $1)');
  });

  it('JWT scope 推導角色：mcp:db-intelligence:manager → manager', async () => {
    const r = await call('POST', '/query/preview', { tenant_id: 'demo', user_id: 'zoe', scopes: ['mcp:db-intelligence:manager'], query_plan: plan });
    expect(r.body.data).toMatchObject({ principal: { roles: ['manager'] }, policy_ids: ['manager-all-projects'], row_scope: [] });
  });

  it('被拒的計畫回錯誤碼', async () => {
    const r = await call('POST', '/query/preview', { tenant_id: 'demo', user_id: 'alice', query_plan: { ...plan, dataset: 'employee_salary' } });
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'QUERY_POLICY_DENIED' } } });
  });
});

describe('稽核查詢', () => {
  it('依 request_id、狀態篩選最近的查詢', async () => {
    const svc = new DbIntelligenceService({
      dataSources: () => state.dataSources(),
      catalogs,
      policies: () => state.policies(),
      principals: directoryResolver(() => state.principals()),
      executor: { execute: async () => { throw new Error('x'); } },
      audit,
    });
    const err = await svc.executeSafeQuery(caller('alice'), { query_plan: { version: '1.0', data_source_id: 'ds_project_01', dataset: 'employee_salary', select: [{ field: 'salary' }] } }).catch((e) => e);
    const all = await call('GET', '/audit?tenant_id=demo&status=denied');
    expect(all.body.data).toHaveLength(1);
    const one = await call('GET', `/audit?request_id=${err.requestId}`);
    expect(one.body.data[0]).toMatchObject({ principal_id: 'alice', reason_code: 'QUERY_POLICY_DENIED' });
  });
});
