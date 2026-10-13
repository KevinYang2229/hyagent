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
    const tools = refreshed.body.data.tools as { name: string; effect: string; declaredReadOnly: boolean }[];
    // 遠端宣告唯讀但尚未核准 → 仍是寫入
    expect(tools.find((t) => t.name === 'rooms_availability')).toMatchObject({ effect: 'write', declaredReadOnly: true });
    expect(tools.find((t) => t.name === 'rooms_book')).toMatchObject({ effect: 'write', declaredReadOnly: false });

    const approved = await request(app).patch('/api/admin/mcp-servers/rooms').set(admin).send({
      toolOverrides: { rooms_availability: { approvedReadOnly: true } },
    });
    expect(approved.status).toBe(200);
    expect((approved.body.data.tools as { name: string; effect: string }[]).find((t) => t.name === 'rooms_availability')?.effect).toBe('read');

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
