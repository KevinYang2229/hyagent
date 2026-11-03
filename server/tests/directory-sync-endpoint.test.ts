/**
 * `POST /api/directory-sync/events` 的 HTTP 契約（HANDOFF §5–§7）。
 * 429 的行為另見 directory-sync-rate-limit.test.ts（需要在載入 app 前設定上限）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { clockOffsetStats } from '@/modules/auth/clock-skew-monitor';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { directorySyncBodyParser } from '@/modules/user/directory-sync.routes';
import { issueAssertion } from './helpers/assertion-signer';

const app = createApp();
const syncPair = generateHyAgentKeyPair('ES256');
const loginPair = generateHyAgentKeyPair('ES256');
const AUD = 'hyagent:directory-sync';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function fixture(opts: { enabled?: boolean } = {}) {
  const tenant = tenantStore.createTenant('sync endpoint fixture', ['*']);
  tenantStore.addDirectorySyncKey(tenant.id, { publicKey: syncPair.publicKeyPem });
  tenantStore.updateTenant(tenant.id, { directorySyncEnabled: opts.enabled ?? true });
  return tenant;
}

function upsert(id: string, at = new Date().toISOString(), name = '王小明') {
  return {
    eventId: `evt_${id}_${at}`,
    type: 'user.upserted',
    occurredAt: at,
    user: { id, name, department: '資訊部' },
  };
}

function sign(tenantId: string, body: string, over: { privateKey?: string; audience?: string; hash?: string; subject?: string } = {}) {
  return issueAssertion({
    privateKey: over.privateKey ?? syncPair.privateKeyPem,
    tenant: tenantId,
    subject: over.subject ?? 'directory-sync',
    audience: over.audience ?? AUD,
    profile: { body_sha256: over.hash ?? sha(body) },
  });
}

function post(tenantId: string, payload: unknown, over: Parameters<typeof sign>[2] = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(app)
    .post('/api/directory-sync/events')
    .set('content-type', 'application/json')
    .set('authorization', `Bearer ${sign(tenantId, body, over)}`)
    .send(body);
}

const dirOf = (id: string) => tenantStore.getTenant(id)!.userDirectory ?? [];

it('合法請求回 200 data.results，目錄已更新', async () => {
  const t = fixture();
  const res = await post(t.id, { events: [upsert('E1')] });
  expect(res.status).toBe(200);
  expect(res.body.data.results).toEqual([expect.objectContaining({ status: 'applied' })]);
  expect(dirOf(t.id).find((u) => u.id === 'E1')).toMatchObject({ name: '王小明', origin: 'sync' });
});

it('空的 events 陣列是合法請求', async () => {
  const t = fixture();
  const res = await post(t.id, { events: [] });
  expect(res.status).toBe(200);
  expect(res.body.data.results).toEqual([]);
});

it('開關關閉回 403 DIRECTORY_SYNC_DISABLED', async () => {
  const t = fixture({ enabled: false });
  const res = await post(t.id, { events: [upsert('E1')] });
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ error: 'DIRECTORY_SYNC_DISABLED', requestId: expect.any(String) });
  expect(dirOf(t.id).find((u) => u.id === 'E1')).toBeUndefined();
});

it('缺 Bearer token 回 401 UNAUTHORIZED', async () => {
  const res = await request(app).post('/api/directory-sync/events').send({ events: [] });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('UNAUTHORIZED');
});

it('登入金鑰簽的同步請求回 401 UNKNOWN_KID', async () => {
  const t = fixture();
  tenantStore.addPublicKey(t.id, { publicKey: loginPair.publicKeyPem });
  const res = await post(t.id, { events: [upsert('E1')] }, { privateKey: loginPair.privateKeyPem });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('UNKNOWN_KID');
});

it('同步金鑰簽的憑證打 /api/auth/sso/exchange 被拒絕', async () => {
  const t = fixture();
  const assertion = issueAssertion({ privateKey: syncPair.privateKeyPem, tenant: t.id, subject: 'directory-sync' });
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('UNKNOWN_KID');
});

it('aud=hyagent 回 401 INVALID_AUDIENCE', async () => {
  const t = fixture();
  const res = await post(t.id, { events: [] }, { audience: 'hyagent' });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('INVALID_AUDIENCE');
});

it('內容與 body_sha256 不符回 400 BODY_HASH_MISMATCH（含缺少該 claim）', async () => {
  const t = fixture();
  const res = await post(t.id, { events: [upsert('E1')] }, { hash: sha('其他內容') });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('BODY_HASH_MISMATCH');
  expect(dirOf(t.id).find((u) => u.id === 'E1')).toBeUndefined();

  const noClaim = issueAssertion({
    privateKey: syncPair.privateKeyPem, tenant: t.id, subject: 'directory-sync', audience: AUD,
  });
  const res2 = await request(app)
    .post('/api/directory-sync/events')
    .set('content-type', 'application/json')
    .set('authorization', `Bearer ${noClaim}`)
    .send('{"events":[]}');
  expect(res2.status).toBe(400);
  expect(res2.body.error).toBe('BODY_HASH_MISMATCH');
});

it('重用同一張 JWT 回 401 TOKEN_REPLAYED', async () => {
  const t = fixture();
  const body = JSON.stringify({ events: [] });
  const jwt = sign(t.id, body);
  const send = () =>
    request(app).post('/api/directory-sync/events')
      .set('content-type', 'application/json').set('authorization', `Bearer ${jwt}`).send(body);
  expect((await send()).status).toBe(200);
  const again = await send();
  expect(again.status).toBe(401);
  expect(again.body.error).toBe('TOKEN_REPLAYED');
});

it('其他租戶的金鑰不能改此租戶目錄', async () => {
  const victim = fixture();
  const attacker = tenantStore.createTenant('attacker', ['*']);
  const otherPair = generateHyAgentKeyPair('ES256');
  tenantStore.addDirectorySyncKey(attacker.id, { publicKey: otherPair.publicKeyPem });
  tenantStore.updateTenant(attacker.id, { directorySyncEnabled: true });
  // 攻擊者簽 iss=victim，但金鑰只登記在自己的租戶
  const res = await post(victim.id, { events: [upsert('EVIL')] }, { privateKey: otherPair.privateKeyPem });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('UNKNOWN_KID');
  expect(dirOf(victim.id).find((u) => u.id === 'EVIL')).toBeUndefined();
});

it('iss 指向不存在的租戶回 404 TENANT_NOT_FOUND', async () => {
  const res = await post('no-such-tenant', { events: [] });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('TENANT_NOT_FOUND');
});

it('撤銷的金鑰回 401 KEY_REVOKED', async () => {
  const t = fixture();
  const added = tenantStore.addDirectorySyncKey(t.id, { publicKey: loginPair.publicKeyPem })!;
  tenantStore.revokeDirectorySyncKey(t.id, added.key.kid, 'rotated', { via: 'admin-api-key' });
  const res = await post(t.id, { events: [] }, { privateKey: loginPair.privateKeyPem });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('KEY_REVOKED');
});

it('JSON 不合法或 events 不是陣列回 400 INVALID_BODY', async () => {
  const t = fixture();
  for (const payload of ['{not json', '{}', '{"events":"x"}', 'null']) {
    const res = await post(t.id, payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_BODY');
  }
});

it('501 筆事件回 413 TOO_MANY_EVENTS；500 筆可通過', async () => {
  const t = fixture();
  const mk = (n: number) => ({ events: Array.from({ length: n }, (_, i) => upsert(`B${i}`)) });
  const over = await post(t.id, mk(501));
  expect(over.status).toBe(413);
  expect(over.body.error).toBe('TOO_MANY_EVENTS');
  expect((await post(t.id, mk(500))).status).toBe(200);
});

it('超過 1 MB 回 413 TOO_MANY_EVENTS（扁平格式）', async () => {
  const t = fixture();
  const res = await post(t.id, JSON.stringify({ events: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
  expect(res.status).toBe(413);
  expect(res.body).toMatchObject({ error: 'TOO_MANY_EVENTS', requestId: expect.any(String) });
});

async function sessionFor(tenantId: string, sub: string) {
  return (await authSessionStore.create({ tenantId, sub, kid: 'k', expiresInSeconds: 600 })).sessionToken;
}

it('user.deleted 後該員工 Session 立即失效，其他人不受影響', async () => {
  const t = fixture();
  await post(t.id, { events: [upsert('GONE', '2026-01-01T00:00:00.000Z'), upsert('STAY', '2026-01-01T00:00:00.000Z')] });
  const gone = await sessionFor(t.id, 'GONE');
  const stay = await sessionFor(t.id, 'STAY');

  const res = await post(t.id, {
    events: [{ eventId: 'd1', type: 'user.deleted', occurredAt: new Date().toISOString(), userId: 'GONE' }],
  });
  expect(res.status).toBe(200);
  expect(res.body.data.results[0].status).toBe('applied');
  expect(await authSessionStore.get(gone)).toBeUndefined();
  expect(await authSessionStore.get(stay)).toBeDefined();
  expect(dirOf(t.id).find((u) => u.id === 'GONE')).toBeUndefined();
});

it('persistCritical 失敗回 500、不作廢 Session；重送後 Session 被作廢', async () => {
  const t = fixture();
  await post(t.id, { events: [upsert('GONE', '2026-01-01T00:00:00.000Z')] });
  const token = await sessionFor(t.id, 'GONE');
  const del = { events: [{ eventId: 'd1', type: 'user.deleted', occurredAt: new Date().toISOString(), userId: 'GONE' }] };

  const spy = jest.spyOn(tenantStore, 'persistCritical').mockRejectedValueOnce(new Error('disk full'));
  const failed = await post(t.id, del);
  spy.mockRestore();
  expect(failed.status).toBe(500);
  expect(failed.body).toMatchObject({ error: 'INTERNAL_ERROR', requestId: expect.any(String) });
  expect(await authSessionStore.get(token)).toBeDefined();

  const retry = await post(t.id, del);
  expect(retry.status).toBe(200);
  expect(retry.body.data.results[0].status).toBe('stale');
  expect(await authSessionStore.get(token)).toBeUndefined();
});

it('revokeBySub 在持久化後失敗也回 500，重送會再作廢', async () => {
  const t = fixture();
  await post(t.id, { events: [upsert('GONE', '2026-01-01T00:00:00.000Z')] });
  const token = await sessionFor(t.id, 'GONE');
  const del = { events: [{ eventId: 'd1', type: 'user.deleted', occurredAt: new Date().toISOString(), userId: 'GONE' }] };

  const spy = jest.spyOn(authSessionStore, 'revokeBySub').mockRejectedValueOnce(new Error('db down'));
  const failed = await post(t.id, del);
  spy.mockRestore();
  expect(failed.status).toBe(500);
  expect(await authSessionStore.get(token)).toBeDefined();

  expect((await post(t.id, del)).status).toBe(200);
  expect(await authSessionStore.get(token)).toBeUndefined();
});

it('同步請求不改變 clockOffsetStats', async () => {
  const t = fixture();
  expect(clockOffsetStats(t.id, 15)).toBeUndefined();
  expect((await post(t.id, { events: [upsert('E1')] })).status).toBe(200);
  expect(clockOffsetStats(t.id, 15)).toBeUndefined();
});

it('成功後 directorySyncStatus 記錄筆數，不含人員資料', async () => {
  const t = fixture();
  await post(t.id, {
    events: [upsert('E1', '2026-02-01T00:00:00.000Z', '機密姓名'), upsert('E1', '2026-01-01T00:00:00.000Z')],
  });
  const status = tenantStore.getTenant(t.id)!.directorySyncStatus!;
  expect(status).toMatchObject({ applied: 1, stale: 1, rejected: 0 });
  expect(JSON.stringify(status)).not.toContain('機密姓名');
  expect(JSON.stringify(status)).not.toContain('E1');
});

it('全部 stale 時目錄不重寫，但狀態仍更新', async () => {
  const t = fixture();
  await post(t.id, { events: [upsert('E1', '2026-02-01T00:00:00.000Z')] });
  const before = tenantStore.getTenant(t.id)!.userDirectory;
  await post(t.id, { events: [upsert('E1', '2026-01-01T00:00:00.000Z')] });
  const after = tenantStore.getTenant(t.id)!;
  expect(after.userDirectory).toBe(before);
  expect(after.directorySyncStatus).toMatchObject({ applied: 0, stale: 1 });
});

it('其他路由的 JSON parsing 不變：/api/auth/sso/exchange 正常', async () => {
  const t = tenantStore.createTenant('json fixture', ['*']);
  tenantStore.addPublicKey(t.id, { publicKey: loginPair.publicKeyPem });
  const assertion = issueAssertion({ privateKey: loginPair.privateKeyPem, tenant: t.id, subject: '507' });
  const res = await request(app).post('/api/auth/sso/exchange').send({ assertion });
  expect(res.status).toBe(201);
});

it('後面的 express.json 不會動已解析成 Buffer 的 body', async () => {
  const probe = express();
  probe.use('/x', directorySyncBodyParser);
  probe.use(express.json({ limit: '1mb' }));
  probe.post('/x', (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), text: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null });
  });
  const raw = '{"events":[ ]}';
  const res = await request(probe).post('/x').set('content-type', 'application/json').send(raw);
  expect(res.body).toEqual({ isBuffer: true, text: raw });
});

it('sub 不是 directory-sync 回 401 INVALID_CLAIMS', async () => {
  const t = fixture();
  const res = await post(t.id, { events: [upsert('E1')] }, { subject: 'someone' });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('INVALID_CLAIMS');
  expect(dirOf(t.id).find((u) => u.id === 'E1')).toBeUndefined();
});

it('回應 body 的 requestId 等於 x-request-id header（成功、驗證失敗、413 皆然）', async () => {
  const t = fixture();
  const bad = await post(t.id, { events: [] }, { audience: 'hyagent' });
  expect(bad.headers['x-request-id']).toBeTruthy();
  expect(bad.body.requestId).toBe(bad.headers['x-request-id']);

  const big = await post(t.id, JSON.stringify({ events: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
  expect(big.status).toBe(413);
  expect(big.headers['x-request-id']).toBeTruthy();
  expect(big.body.requestId).toBe(big.headers['x-request-id']);

  const body = JSON.stringify({ events: [] });
  const echoed = await request(app).post('/api/directory-sync/events')
    .set('content-type', 'application/json').set('x-request-id', 'trace-123')
    .set('authorization', `Bearer ${sign(t.id, body, { audience: 'hyagent' })}`).send(body);
  expect(echoed.body.requestId).toBe('trace-123');
});

it('一批事件只寫入一次，即使全是 stale；錯誤的請求不寫入', async () => {
  const t = fixture();
  const spy = jest.spyOn(tenantStore, 'persistCritical');
  // updateTenant 內含一次 persist()；改用 applyDirectorySyncState 才不會多寫一份快照
  const update = jest.spyOn(tenantStore, 'updateTenant');
  await post(t.id, { events: [upsert('E1', '2026-02-01T00:00:00.000Z'), upsert('E2', '2026-02-01T00:00:00.000Z')] });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  await post(t.id, { events: [upsert('E1', '2026-01-01T00:00:00.000Z')] });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  await post(t.id, '{bad');
  expect(spy).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  update.mockRestore();
  spy.mockRestore();
});

describe('user.deleted 清除個人授權（accounts／accountBundles）', () => {
  // 要落在刪除紀錄的 30 天保留期內，否則重送時紀錄已被清掉，不算 stale
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const T0 = daysAgo(3);
  const T1 = daysAgo(2);
  const T2 = daysAgo(1);
  const delAt = (id: string, at: string) => ({ eventId: `d_${id}_${at}`, type: 'user.deleted', occurredAt: at, userId: id });
  const seed = (tenantId: string) => scopePolicy.setPolicy(tenantId, {
    groups: { 資訊部: ['dept:direct'] },
    accounts: { GONE: ['personal:direct'], STAY: ['stay:direct'] },
    bundles: [
      { id: 'personal-role', name: '個人角色', scopes: ['personal:role'] },
      { id: 'dept-role', name: '部門角色', scopes: ['dept:role'] },
      { id: 'all-role', name: '全體角色', scopes: ['all:role'] },
    ],
    groupBundles: { 資訊部: ['dept-role'] },
    accountBundles: { GONE: ['personal-role'], STAY: ['personal-role'] },
    tenantBundles: ['all-role'],
  });
  async function deletedFixture() {
    const t = fixture();
    await post(t.id, { events: [upsert('GONE', T0), upsert('STAY', T0)] });
    seed(t.id);
    return t;
  }
  /** 不碰磁碟也能看到「實際落地的內容」：攔下寫到政策檔的 payload。 */
  function capturePolicyWrites(failOnce = false) {
    const real = fs.writeFileSync.bind(fs);
    const written: string[] = [];
    let fail = failOnce;
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string, ...rest: []) => {
      if (String(file).includes('scope-policy')) {
        if (fail) { fail = false; throw new Error('disk full'); }
        written.push(String(data));
      }
      return real(file, data, ...rest);
    }) as typeof fs.writeFileSync);
    return { written, spy };
  }
  afterEach(() => jest.restoreAllMocks());

  it('刪除後 accounts 與 accountBundles 都移除此人，他人與其他政策不動', async () => {
    const t = await deletedFixture();
    const res = await post(t.id, { events: [delAt('GONE', T1)] });
    expect(res.status).toBe(200);
    const policy = scopePolicy.getPolicy(t.id);
    expect(policy.accounts).toEqual({ STAY: ['stay:direct'] });
    expect(policy.accountBundles).toEqual({ STAY: ['personal-role'] });
    expect(policy.groups).toEqual({ 資訊部: ['dept:direct'] });
    expect(policy.groupBundles).toEqual({ 資訊部: ['dept-role'] });
    expect(policy.tenantBundles).toEqual(['all-role']);
    expect(policy.bundles).toHaveLength(3);
  });

  it('復職後沒有個人權限，部門與全體角色照常生效', async () => {
    const t = await deletedFixture();
    await post(t.id, { events: [delAt('GONE', T1)] });
    expect((await post(t.id, { events: [upsert('GONE', T2)] })).body.data.results[0].status).toBe('applied');
    const scopes = resolveScopes({ tenantId: t.id, userId: 'GONE' });
    expect(scopes).toEqual(expect.arrayContaining(['dept:direct', 'dept:role', 'all:role']));
    expect(scopes).not.toEqual(expect.arrayContaining(['personal:direct']));
    expect(scopes).not.toEqual(expect.arrayContaining(['personal:role']));
  });

  it('政策寫入失敗回 500、Session 未作廢；重送一定再寫一次（記憶體已清也一樣）並作廢', async () => {
    const t = await deletedFixture();
    const token = await sessionFor(t.id, 'GONE');
    const del = { events: [delAt('GONE', T1)] };
    const { written, spy } = capturePolicyWrites(true);

    const failed = await post(t.id, del);
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ error: 'INTERNAL_ERROR', requestId: expect.any(String) });
    expect(written).toEqual([]);
    expect(await authSessionStore.get(token)).toBeDefined();

    const retry = await post(t.id, del);
    spy.mockRestore();
    expect(retry.status).toBe(200);
    expect(retry.body.data.results[0].status).toBe('stale');
    expect(written).toHaveLength(1);
    const persisted = new Map(JSON.parse(written[0]) as [string, { accounts: object; accountBundles: object }][]).get(t.id)!;
    expect(persisted.accounts).toEqual({ STAY: ['stay:direct'] });
    expect(persisted.accountBundles).toEqual({ STAY: ['personal-role'] });
    expect(await authSessionStore.get(token)).toBeUndefined();
  });

  it('目錄寫入失敗回 500 時還不動政策；重送才清', async () => {
    const t = await deletedFixture();
    const del = { events: [delAt('GONE', T1)] };
    const spy = jest.spyOn(tenantStore, 'persistCritical').mockRejectedValueOnce(new Error('disk full'));
    expect((await post(t.id, del)).status).toBe(500);
    spy.mockRestore();
    expect(scopePolicy.getPolicy(t.id).accounts.GONE).toEqual(['personal:direct']);

    expect((await post(t.id, del)).status).toBe(200);
    expect(scopePolicy.getPolicy(t.id).accounts.GONE).toBeUndefined();
  });

  it('重送相同時間的 delete 是冪等的：結果相同、不影響其他人', async () => {
    const t = await deletedFixture();
    const del = { events: [delAt('GONE', T1)] };
    await post(t.id, del);
    const after = scopePolicy.getPolicy(t.id);
    const again = await post(t.id, del);
    expect(again.status).toBe(200);
    expect(again.body.data.results[0].status).toBe('stale');
    expect(scopePolicy.getPolicy(t.id)).toEqual(after);
  });

  it('復職且重新指派後，遲到的舊 delete 不會清掉新指派的個人權限', async () => {
    const t = await deletedFixture();
    await post(t.id, { events: [delAt('GONE', T1)] });
    await post(t.id, { events: [upsert('GONE', T2)] });
    const policy = scopePolicy.getPolicy(t.id);
    scopePolicy.setPolicy(t.id, { ...policy, accounts: { ...policy.accounts, GONE: ['personal:new'] } });
    const replay = await post(t.id, { events: [delAt('GONE', T1)] });
    expect(replay.body.data.results[0].status).toBe('stale');
    expect(scopePolicy.getPolicy(t.id).accounts.GONE).toEqual(['personal:new']);
  });

  it('順序是目錄寫入 → 政策寫入 → 作廢 Session，政策寫完才回 200', async () => {
    const t = await deletedFixture();
    const persist = jest.spyOn(tenantStore, 'persistCritical');
    const revoke = jest.spyOn(authSessionStore, 'revokeBySub');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const real = scopePolicy.clearAccountGrants.bind(scopePolicy);
    const clear = jest.spyOn(scopePolicy, 'clearAccountGrants').mockImplementation(async (...a) => {
      await held;
      await real(...a);
    });

    let done = false;
    const pending = post(t.id, { events: [delAt('GONE', T1)] }).then((r) => { done = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clear).toHaveBeenCalledWith(t.id, ['GONE']);
    expect(done).toBe(false);
    expect(revoke).not.toHaveBeenCalled();

    release();
    expect((await pending).status).toBe(200);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]);
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0]);
  });

  it('沒有 delete 的批次不碰政策', async () => {
    const t = await deletedFixture();
    const clear = jest.spyOn(scopePolicy, 'clearAccountGrants');
    await post(t.id, { events: [upsert('NEW', T2)] });
    expect(clear).not.toHaveBeenCalled();
  });

  it('被拒絕或過期（非同一時間）的 delete 不清權限', async () => {
    const t = await deletedFixture();
    await post(t.id, { events: [upsert('GONE', T2)] });
    const res = await post(t.id, { events: [delAt('GONE', T1), { eventId: 'bad', type: 'user.deleted', occurredAt: T2, userId: 'x'.repeat(201) }] });
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['stale', 'rejected']);
    expect(scopePolicy.getPolicy(t.id).accounts.GONE).toEqual(['personal:direct']);
  });

  it('後台手動 DELETE 不動個人授權（維持原行為）', async () => {
    const t = await deletedFixture();
    await request(app).delete(`/api/admin/tenants/${t.id}/users/GONE`).set({ 'x-admin-key': 'test-admin-key' }).expect(200);
    expect(scopePolicy.getPolicy(t.id).accounts.GONE).toEqual(['personal:direct']);
    expect(scopePolicy.getPolicy(t.id).accountBundles?.GONE).toEqual(['personal-role']);
  });
});
