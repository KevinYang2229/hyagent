/**
 * 自動登入後在背景建立／更新目錄資料。
 *
 * 最高原則：登入的成敗、回應與速度，完全不取決於目錄。
 * 所以除了建立／更新規則，這裡釘的重點是「背景工作壞掉或很慢，exchange 結果不變」。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair, type AssertionClaims } from '@/lib/assertion';
import { logger } from '@/lib/logger';
import { assertionExchange } from '@/modules/auth/assertion-exchange';
import { issueGuestSession } from '@/modules/auth/guest-session';
import * as provision from '@/modules/user/directory-provision';
import { provisionFromClaims, scheduleSsoProvision } from '@/modules/user/directory-provision';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { issueAssertion } from './helpers/assertion-signer';

const app = createApp();
const keyPair = generateHyAgentKeyPair('ES256');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const IAT = 1_800_000_000;

function newTenant(autoProvision = true, directory?: DirectoryEntry[]) {
  const tenant = tenantStore.createTenant('provision fixture', ['*']);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  tenantStore.updateTenant(tenant.id, {
    ...(autoProvision ? { ssoAutoProvision: true } : {}),
    ...(directory ? { userDirectory: directory } : {}),
  });
  const sign = (subject: string, profile: Record<string, unknown> = {}) =>
    issueAssertion({ privateKey: keyPair.privateKeyPem, tenant: tenant.id, subject, profile });
  return { id: tenant.id, sign };
}

const dir = (id: string) => tenantStore.getTenant(id)?.userDirectory;

function claims(sub: string, over: Record<string, unknown> = {}): AssertionClaims {
  return { iss: 't', sub, aud: 'hyagent', iat: IAT, exp: IAT + 60, jti: 'j', ...over } as AssertionClaims;
}
const fullClaims = (sub = 'E1') =>
  claims(sub, {
    name: '王小明',
    email: 'wang@example.com',
    'hyagent:profile': { deptName: '資訊部', jobPostName: '工程師', companyName: '凌網' },
  });

afterEach(() => jest.restoreAllMocks());

describe('provisionFromClaims：建立', () => {
  it('新員工建立，origin 為 sso，欄位對應 name/deptName/jobPostName/companyName/email', () => {
    const { id } = newTenant();
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toEqual([
      { id: 'E1', name: '王小明', department: '資訊部', title: '工程師', company: '凌網', email: 'wang@example.com', origin: 'sso' },
    ]);
  });

  it('email 不合法時略過 email，其餘照建', () => {
    const { id } = newTenant();
    provisionFromClaims(id, claims('E1', { name: '王', email: 'not-an-email', 'hyagent:profile': { deptName: '資訊部' } }));
    const [entry] = dir(id)!;
    expect(entry).toEqual({ id: 'E1', name: '王', department: '資訊部', origin: 'sso' });
    expect('email' in entry).toBe(false);
  });

  it('只有 sub 時，姓名用 sub、部門用 UNKNOWN_DEPARTMENT', () => {
    const { id } = newTenant();
    provisionFromClaims(id, claims('E1'));
    expect(dir(id)).toEqual([{ id: 'E1', name: 'E1', department: UNKNOWN_DEPARTMENT, origin: 'sso' }]);
  });

  it('開關關閉（執行當下再檢查）：目錄不變', () => {
    const { id } = newTenant(false);
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toBeUndefined();
  });

  it('同一新員工連續觸發兩次：只有一筆', () => {
    const { id } = newTenant();
    provisionFromClaims(id, fullClaims());
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toHaveLength(1);
  });

  it('租戶不存在：不丟錯、不建立', () => {
    expect(() => provisionFromClaims('no-such-tenant', fullClaims())).not.toThrow();
  });

  it('建立只呼叫一次 updateTenant（不另寫關鍵快照）', () => {
    const { id } = newTenant();
    const spy = jest.spyOn(tenantStore, 'updateTenant');
    provisionFromClaims(id, fullClaims());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toHaveProperty('userDirectory');
  });
});

describe('provisionFromClaims：上限、sub 檢查、墓碑', () => {
  it('目錄滿 10,000 人：不建立，記警告，不含 sub', () => {
    const full: DirectoryEntry[] = Array.from({ length: 10_000 }, (_, i) => ({ id: `u${i}`, name: 'n', department: 'd', origin: 'manual' as const }));
    const { id } = newTenant(true, full);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    provisionFromClaims(id, fullClaims('SECRET-SUB'));
    expect(dir(id)).toHaveLength(10_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(id);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-SUB');
  });

  it('目錄滿 10,000 人：既有 sso 項目仍可更新', () => {
    const full: DirectoryEntry[] = Array.from({ length: 9_999 }, (_, i) => ({ id: `u${i}`, name: 'n', department: 'd', origin: 'manual' as const }));
    full.push({ id: 'E1', name: '舊名', department: '舊部', origin: 'sso' });
    const { id } = newTenant(true, full);
    provisionFromClaims(id, fullClaims('E1'));
    expect(dir(id)).toHaveLength(10_000);
    expect(dir(id)!.find((u) => u.id === 'E1')).toMatchObject({ name: '王小明', department: '資訊部' });
  });

  it.each([
    ['超過 200 字元', 'x'.repeat(201)],
    ['含前後空白', ' padded-sub '],
  ])('sub %s：不建立，日誌不含 sub', (_label, sub) => {
    const { id } = newTenant();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    provisionFromClaims(id, fullClaims(sub));
    expect(dir(id)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sub.trim());
  });

  it.each([['NUL', 'E1\u0000'], ['單獨代理字元', 'E1\ud83d']])('sub 含%s：登入成功、目錄不變、警告不含 sub', async (_l, sub) => {
    const { id, sign } = newTenant();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const r = await assertionExchange.exchange({ assertion: sign(sub, { name: 'N' }), origin: 'https://any.example.com' });
    expect(r.user.sub).toBe(sub);
    await flush();
    expect(dir(id)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('E1');
  });

  it('name／部門含 NUL 視為缺：姓名退回 sub、部門退回 UNKNOWN_DEPARTMENT，仍建立', () => {
    const { id } = newTenant();
    provisionFromClaims(id, claims('E1', { name: 'a\u0000b', 'hyagent:profile': { deptName: 'd\u0000', jobPostName: 't\u0000' } }));
    expect(dir(id)).toEqual([{ id: 'E1', name: 'E1', department: UNKNOWN_DEPARTMENT, origin: 'sso' }]);
  });

  it('sub 剛好 200 字元可以建立', () => {
    const { id } = newTenant();
    provisionFromClaims(id, fullClaims('x'.repeat(200)));
    expect(dir(id)).toHaveLength(1);
  });

  it('刪除紀錄晚於或等於 iat：不建立；iat 較晚：建立', () => {
    const { id } = newTenant();
    tenantStore.updateTenant(id, { directoryTombstones: { E1: new Date(IAT * 1000).toISOString(), E2: new Date(IAT * 1000 - 1).toISOString() } });
    provisionFromClaims(id, fullClaims('E1'));
    expect(dir(id)).toBeUndefined();
    provisionFromClaims(id, fullClaims('E2'));
    expect(dir(id)!.map((u) => u.id)).toEqual(['E2']);
  });
});

describe('provisionFromClaims：更新既有項目', () => {
  const existing = (over: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
    id: 'E1', name: '舊名', department: '舊部', title: '舊職', company: '舊司', email: 'old@example.com', region: '台北', deputyIds: ['D1'], origin: 'sso', ...over,
  });

  it('origin=sso 且無 syncedAt：資料不同才更新，保留 deputyIds 與 region', () => {
    const { id } = newTenant(true, [existing()]);
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toEqual([
      { id: 'E1', name: '王小明', department: '資訊部', title: '工程師', company: '凌網', email: 'wang@example.com', region: '台北', deputyIds: ['D1'], origin: 'sso' },
    ]);
  });

  it('資料相同時不呼叫 updateTenant', () => {
    const same = existing({ name: '王小明', department: '資訊部', title: '工程師', company: '凌網', email: 'wang@example.com' });
    const { id } = newTenant(true, [same]);
    const spy = jest.spyOn(tenantStore, 'updateTenant');
    provisionFromClaims(id, fullClaims());
    expect(spy).not.toHaveBeenCalled();
  });

  it('claim 缺少：既有資料全部保留，不寫入，也不退回 sub／UNKNOWN_DEPARTMENT', () => {
    const entry = existing();
    const { id } = newTenant(true, [entry]);
    const spy = jest.spyOn(tenantStore, 'updateTenant');
    provisionFromClaims(id, claims('E1'));
    expect(dir(id)).toEqual([entry]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('只帶部分 claim：只覆蓋帶了的欄位', () => {
    const { id } = newTenant(true, [existing()]);
    provisionFromClaims(id, claims('E1', { 'hyagent:profile': { deptName: '新部' } }));
    expect(dir(id)).toEqual([{ ...existing(), department: '新部' }]);
  });

  it.each([
    ['超過 200 字元', 'x'.repeat(201)],
    ['含 NUL', 'a\u0000b'],
    ['單獨代理字元', 'a\ud83d'],
    ['只有空白', '   '],
    ['不是字串', 42],
  ])('claim %s 視為沒帶：保留既有值', (_label, bad) => {
    const entry = existing();
    const { id } = newTenant(true, [entry]);
    provisionFromClaims(id, claims('E1', {
      name: bad, email: bad, 'hyagent:profile': { deptName: bad, jobPostName: bad, companyName: bad },
    }));
    expect(dir(id)).toEqual([entry]);
  });

  it('email 格式不合視為沒帶：保留既有值，其他欄位照常更新', () => {
    const { id } = newTenant(true, [existing()]);
    provisionFromClaims(id, claims('E1', { name: '新名', email: 'not-an-email' }));
    expect(dir(id)).toEqual([{ ...existing(), name: '新名' }]);
  });

  it('帶了的欄位與現值相同、其餘沒帶：不呼叫 updateTenant', () => {
    const { id } = newTenant(true, [existing()]);
    const spy = jest.spyOn(tenantStore, 'updateTenant');
    provisionFromClaims(id, claims('E1', { name: '舊名' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('origin=sso 且有 syncedAt：不更新', () => {
    const entry = existing({ syncedAt: '2026-11-03T00:00:00.000Z' });
    const { id } = newTenant(true, [entry]);
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toEqual([entry]);
  });

  it.each(['manual', 'sync', undefined] as const)('origin=%s：不更新', (origin) => {
    const entry = existing({ origin });
    if (origin === undefined) delete entry.origin;
    const { id } = newTenant(true, [entry]);
    provisionFromClaims(id, fullClaims());
    expect(dir(id)).toEqual([entry]);
  });

  it('刪除紀錄不影響既有項目的更新規則（只擋建立）', () => {
    const { id } = newTenant(true, [existing()]);
    tenantStore.updateTenant(id, { directoryTombstones: { E1: new Date(IAT * 1000 + 5000).toISOString() } });
    provisionFromClaims(id, fullClaims());
    expect(dir(id)![0].name).toBe('王小明');
  });
});

describe('scheduleSsoProvision', () => {
  it('setImmediate 之後才執行', async () => {
    const { id } = newTenant();
    scheduleSsoProvision(id, fullClaims());
    expect(dir(id)).toBeUndefined();
    await flush();
    expect(dir(id)).toHaveLength(1);
  });

  it('updateTenant 拋錯：不產生未處理例外，只記不含 sub 的警告', async () => {
    const { id } = newTenant();
    jest.spyOn(tenantStore, 'updateTenant').mockImplementation(() => { throw new Error('boom SECRET-SUB'); });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    process.on('uncaughtException', unhandled);
    scheduleSsoProvision(id, fullClaims('SECRET-SUB'));
    await flush();
    process.off('unhandledRejection', unhandled);
    process.off('uncaughtException', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(id);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-SUB');
  });

  it('連 logger 都拋錯也吞掉', async () => {
    const { id } = newTenant();
    jest.spyOn(tenantStore, 'updateTenant').mockImplementation(() => { throw new Error('boom'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('logger down'); });
    const unhandled = jest.fn();
    process.on('uncaughtException', unhandled);
    scheduleSsoProvision(id, fullClaims());
    await flush();
    process.off('uncaughtException', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('執行當下再檢查開關：排程後被關掉就不建立', async () => {
    const { id } = newTenant();
    scheduleSsoProvision(id, fullClaims());
    tenantStore.updateTenant(id, { ssoAutoProvision: false });
    await flush();
    expect(dir(id)).toBeUndefined();
  });
});

describe('exchange 整合：登入不受目錄影響', () => {
  const exchange = (assertion: string) => assertionExchange.exchange({ assertion, origin: 'https://any.example.com' });
  const profile = { name: '王小明', email: 'wang@example.com', 'hyagent:profile': { deptName: '資訊部', jobPostName: '工程師', companyName: '凌網' } };
  const stripToken = <T extends { sessionToken: string }>(r: T) => ({ ...r, sessionToken: '<token>' });

  it('開關關閉：不呼叫 scheduleSsoProvision，目錄不變', async () => {
    const { id, sign } = newTenant(false);
    const spy = jest.spyOn(provision, 'scheduleSsoProvision');
    await exchange(sign('E1', profile));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(dir(id)).toBeUndefined();
  });

  it('開啟：登入後背景建立；exchange 當下目錄尚未寫入', async () => {
    const { id, sign } = newTenant();
    await exchange(sign('E1', profile));
    expect(dir(id)).toBeUndefined();
    await flush();
    expect(dir(id)).toEqual([
      { id: 'E1', name: '王小明', department: '資訊部', title: '工程師', company: '凌網', email: 'wang@example.com', origin: 'sso' },
    ]);
  });

  it('開啟與關閉的 exchange 結果相同（除 token 外），也不含任何目錄資料', async () => {
    const on = newTenant(true);
    const off = newTenant(false);
    const rOn = await exchange(on.sign('E1', profile));
    const rOff = await exchange(off.sign('E1', profile));
    expect(Object.keys(rOn).sort()).toEqual(Object.keys(rOff).sort());
    expect(stripToken({ ...rOn, tenantId: '', kid: '' })).toEqual(stripToken({ ...rOff, tenantId: '', kid: '' }));
    expect(rOn.user).toEqual({ sub: 'E1', name: '王小明' });
    expect(JSON.stringify(rOn)).not.toMatch(/資訊部|工程師|凌網|origin|syncedAt/);
  });

  it('provisionFromClaims 拋錯：exchange 結果與開關關閉時相同', async () => {
    const on = newTenant(true);
    const off = newTenant(false);
    jest.spyOn(tenantStore, 'updateTenant').mockImplementation(() => { throw new Error('down'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rOn = await exchange(on.sign('E1', profile));
    const rOff = await exchange(off.sign('E1', profile));
    await flush();
    expect(stripToken({ ...rOn, tenantId: '', kid: '' })).toEqual(stripToken({ ...rOff, tenantId: '', kid: '' }));
  });

  it('exchange 不等待背景工作：updateTenant 變慢或失敗時仍立即回傳', async () => {
    const { sign } = newTenant();
    const real = tenantStore.updateTenant.bind(tenantStore);
    let called = 0;
    jest.spyOn(tenantStore, 'updateTenant').mockImplementation((...a) => {
      called += 1;
      const until = Date.now() + 300;
      while (Date.now() < until) { /* 模擬慢 */ }
      return real(...a);
    });
    const started = Date.now();
    await exchange(sign('E1', profile));
    expect(Date.now() - started).toBeLessThan(250);
    expect(called).toBe(0);
    await flush();
    expect(called).toBe(1);
  });

  it('有刪除紀錄、目錄缺人時，只要憑證有效仍可登入', async () => {
    const { id, sign } = newTenant();
    // 墓碑放在未來一分鐘：用「現在」的話，簽章若剛好跨過整秒，iat 會晚於墓碑而建立（時間相依的不穩定）
    tenantStore.updateTenant(id, { directoryTombstones: { E1: new Date(Date.now() + 60_000).toISOString() }, userDirectory: [] });
    await expect(exchange(sign('E1', profile))).resolves.toMatchObject({ user: { sub: 'E1' } });
    await flush();
    expect(dir(id)).toEqual([]);
  });

  it('免登入訪客不寫入目錄', async () => {
    const t = tenantStore.createTenant('guest fixture', ['*']);
    tenantStore.updateTenant(t.id, { guestAccess: true, ssoAutoProvision: true });
    await issueGuestSession(tenantStore.getTenant(t.id));
    await flush();
    expect(dir(t.id)).toBeUndefined();
  });

  it('開啟且寫入前的第一個請求：getApplicant 走 Session 憑證，資料相同', async () => {
    const { id, sign } = newTenant();
    const meOf = async (token: string) => (await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).body.data;
    const { sessionToken } = await exchange(sign('E1', profile));
    expect(dir(id)).toBeUndefined();
    const before = await meOf(sessionToken);
    await flush();
    expect(dir(id)).toHaveLength(1);
    const after = await meOf(sessionToken);
    expect(before).toMatchObject({ name: '王小明', department: '資訊部', title: '工程師' });
    expect(after).toEqual(before);
  });
});
