/**
 * 租戶管理者設定的對外目標（知識庫網站來源、webhook 端點）只允許公開網段（SSRF 防護）。
 * 超級管理者設定的目標行為不變；舊資料（沒有 restrictNetwork 旗標）也維持原行為。
 */
jest.mock('@/modules/knowledge/website-browser');
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), tokens: 0 }),
  }),
}));
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({
  ...jest.requireActual('@/modules/knowledge/knowledge.index.repo'),
  replaceWebsiteChunks: jest.fn(),
}));

import dns from 'node:dns/promises';
import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import type { AdminAccount } from '@/modules/admin-account/admin-account.types';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { runIngest } from '@/modules/knowledge/ingest.service';
import { WebsiteBrowser } from '@/modules/knowledge/website-browser';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { webhookDispatcher } from '@/modules/webhook/webhook.dispatcher';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { publicOnlyFetch } from '@/lib/public-network';
import * as mcpNetwork from '@/modules/mcp/mcp.network';
import { signAdminToken, signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
let tenantId = '';
let account: AdminAccount;

const bearer = (a: AdminAccount): Record<string, string> => ({
  Authorization: `Bearer ${signTenantAdminToken({ accountId: a.id, tenantId: a.tenantId, credentialVersion: a.credentialVersion })}`,
});
const superBearer = (): Record<string, string> => ({ Authorization: `Bearer ${signAdminToken()}` });
const source = (startUrl: string, extra: Record<string, unknown> = {}) => ({
  startUrl, maxPages: 5, chunkChars: 800, embeddingModel: 'text-embedding-3-large', rerank: false, ...extra,
});

beforeAll(() => {
  adminAccountStore.clear();
  tenantId = tenantStore.createTenant('ssrf-own').id;
  account = adminAccountStore.create({
    tenantId, username: 'ssrf-user', displayName: 'ssrf', passwordHash: 'x',
    permissions: { knowledge: 'write', webhook: 'write' },
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  webhookStore.purgeTenant(tenantId);
});

describe('知識庫網站來源', () => {
  it.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.8/', 'http://[::1]/'])(
    '租戶管理者設定 %s 回 422；超級管理者照常可設定',
    async (url) => {
      const t = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(bearer(account)).send(source(url));
      expect(t.status).toBe(422);
      expect(t.body.error.message).toContain('內部或保留網段');
      const s = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(superBearer()).send(source(url));
      expect(s.status).toBe(200);
      expect(knowledgeStore.getSource(tenantId).restrictNetwork).toBeUndefined();
    },
  );

  it('主機名稱解析到內網也拒絕（含公開／內網混合）', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.1.2.3', family: 4 }] as never);
    const t = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(bearer(account)).send(source('https://intranet.example.com/'));
    expect(t.status).toBe(422);
  });

  it('公開網址：租戶管理者儲存後標記 restrictNetwork；超級管理者重新儲存會清掉', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const t = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(bearer(account))
      .send(source('https://www.example.com/', { restrictNetwork: false }));
    expect(t.status).toBe(200);
    expect(knowledgeStore.getSource(tenantId).restrictNetwork).toBe(true);
    const s = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(superBearer())
      .send(source('https://www.example.com/'));
    expect(s.status).toBe(200);
    expect(knowledgeStore.getSource(tenantId).restrictNetwork).toBeUndefined();
  });

  it('租戶管理者不能開啟 JavaScript 渲染（瀏覽器的連線無法釘住位址）', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const t = await request(app).put(`/api/admin/tenants/${tenantId}/knowledge/source`).set(bearer(account))
      .send(source('https://www.example.com/', { renderJavaScript: true }));
    expect(t.status).toBe(422);
    expect(t.body.error.message).toContain('JavaScript');
  });

  it('POST /knowledge/ingest 帶網址時同樣檢查', async () => {
    const t = await request(app).post(`/api/admin/tenants/${tenantId}/knowledge/ingest`).set(bearer(account))
      .send({ startUrl: 'http://169.254.169.254/' });
    expect(t.status).toBe(422);
  });

  it('爬取時：restrictNetwork 的來源不走一般 fetch，解析到內網（DNS rebinding）就不連線', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    // 起始頁被擋：整個解析失敗並帶出原因（不會寫成空的成功索引）
    await expect(runIngest({
      tenantId, startUrl: 'https://rebind.example.com/', maxPages: 2, chunkChars: 800, embeddingModel: 'test',
      restrictNetwork: true, renderJavaScript: true,
    })).rejects.toThrow('內部或保留網段');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalled();
    expect(WebsiteBrowser).not.toHaveBeenCalled(); // 旗標來源一律不啟動瀏覽器
  });

  it('舊資料（沒有旗標）維持一般 fetch', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<main><h1>標題</h1><p>這是一段足夠長的測試內容，用來確認一般來源仍沿用原本的抓取方式。</p></main>', { headers: { 'content-type': 'text/html' } }),
    );
    await runIngest({ tenantId, startUrl: 'https://legacy.example.com/', maxPages: 1, chunkChars: 800, embeddingModel: 'test' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Webhook 端點', () => {
  it('租戶管理者登記內網網址回 422；超級管理者照常可登記且不標記', async () => {
    const t = await request(app).post(`/api/admin/tenants/${tenantId}/webhooks`).set(bearer(account)).send({ url: 'http://127.0.0.1:8080/hook' });
    expect(t.status).toBe(422);
    const s = await request(app).post(`/api/admin/tenants/${tenantId}/webhooks`).set(superBearer()).send({ url: 'http://127.0.0.1:8080/hook' });
    expect(s.status).toBe(201);
    expect(webhookStore.listByTenant(tenantId)[0].restrictNetwork).toBeUndefined();
  });

  it('租戶管理者登記公開網址：標記 restrictNetwork', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const t = await request(app).post(`/api/admin/tenants/${tenantId}/webhooks`).set(bearer(account)).send({ url: 'https://hook.example.com/x' });
    expect(t.status).toBe(201);
    expect(webhookStore.listByTenant(tenantId)[0].restrictNetwork).toBe(true);
  });

  it('投遞時：旗標端點的主機改解析到內網（DNS rebinding）就拒絕，不呼叫一般 fetch', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      webhookStore.register({ tenantId, url: 'https://hook.example.com/x', restrictNetwork: true });
      const fetchSpy = jest.spyOn(global, 'fetch');
      const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      webhookDispatcher.dispatch({ type: 'form.submitted', tenantId, data: {} as never });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(lookup).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('publicOnlyFetch：每一跳都重新檢查，跳轉到 metadata 位址即拒絕', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const pinned = jest.spyOn(mcpNetwork, 'pinnedFetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    );
    await expect(publicOnlyFetch('https://www.example.com/')).rejects.toMatchObject({ statusCode: 422 });
    expect(pinned).toHaveBeenCalledTimes(1);
    expect(pinned.mock.calls[0][1]).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('publicOnlyFetch：直接位址為 metadata 或 loopback 一律拒絕', async () => {
    await expect(publicOnlyFetch('http://169.254.169.254/latest')).rejects.toMatchObject({ statusCode: 422 });
    await expect(publicOnlyFetch('http://127.0.0.1/')).rejects.toMatchObject({ statusCode: 422 });
  });
});
