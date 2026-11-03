/**
 * 對接文件（docs/HANDOFF-DIRECTORY-SYNC.md）的驗收：§5.3 的 sendEvents 原樣放進來，
 * 打實際啟動的 app，跑完 §9 能自動化的項目。文件與程式不一致時改文件或程式，不要改這支測試的簽章步驟。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant } from '@/modules/user/user.directory';
import { issueAssertion } from './helpers/assertion-signer';

// ---- 以下 b64url 與 sendEvents 取自 HANDOFF-DIRECTORY-SYNC.md §5.3，一個字都不改 ----
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function sendEvents(events: unknown[]) {
  const body = JSON.stringify({ events });
  const now = Math.floor(Date.now() / 1000);

  const header = b64url({ alg: 'ES256', typ: 'JWT', kid: process.env.HYAGENT_SYNC_KID });
  const payload = b64url({
    iss: process.env.HYAGENT_TENANT_ID,
    aud: 'hyagent:directory-sync',
    sub: 'directory-sync',
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    body_sha256: createHash('sha256').update(body).digest('hex'),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(process.env.HYAGENT_SYNC_PRIVATE_KEY as string),
    dsaEncoding: 'ieee-p1363', // ES256 必須是 R‖S；RS256 不需要這行
  }).toString('base64url');

  return fetch(`${process.env.HYAGENT_HOST}/api/directory-sync/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${header}.${payload}.${signature}`, 'content-type': 'application/json' },
    body,
  });
}
// ---- §5.3 結束 ----

const syncPair = generateHyAgentKeyPair('ES256');
const loginPair = generateHyAgentKeyPair('ES256');
let server: Server;
let tenantId: string;
// 事件時間：以一天前為起點、每分鐘一格，避免受測試執行當下的時鐘影響（不可超過現在 + 5 分鐘）
const BASE = Date.now() - 86_400_000;
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.HYAGENT_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tenant = tenantStore.createTenant('handoff fixture', ['*']);
  tenantId = tenant.id;
  const added = tenantStore.addDirectorySyncKey(tenantId, { publicKey: syncPair.publicKeyPem })!;
  tenantStore.updateTenant(tenantId, { directorySyncEnabled: true });
  process.env.HYAGENT_TENANT_ID = tenantId;
  process.env.HYAGENT_SYNC_KID = added.key.kid;
  process.env.HYAGENT_SYNC_PRIVATE_KEY = syncPair.privateKeyPem;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const dirOf = () => tenantStore.getTenant(tenantId)!.userDirectory ?? [];
const entry = (id: string) => dirOf().find((u) => u.id === id);
const upsert = (id: string, at: string, user: Record<string, unknown> = {}) => ({
  eventId: `evt_${id}_${at}`,
  type: 'user.upserted',
  occurredAt: at,
  user: { id, name: '王小明', department: '資訊部', ...user },
});
const del = (id: string, at: string) => ({ eventId: `del_${id}_${at}`, type: 'user.deleted', occurredAt: at, userId: id });
const statuses = async (res: Response) => ((await res.json()) as { data: { results: { status: string }[] } }).data.results.map((r) => r.status);

it('文件 §5.3 的範例與本測試使用的程式碼一致', () => {
  const doc = readFileSync(path.resolve(__dirname, '../../docs/HANDOFF-DIRECTORY-SYNC.md'), 'utf8');
  const block = /```js\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('### 5.3')))![1];
  const mine = readFileSync(__filename, 'utf8');
  // 從 b64url 開始比：它決定 JWT 的編碼方式，文件改錯一樣會讓 OA 簽不過
  const body = (src: string) => src.slice(src.indexOf('const b64url'));
  // 只容許 TypeScript 型別標註的差異（文件是 JS）
  const strip = (s: string) => s.replace(/: unknown(\[\])?| as string/g, '').replace(/\s+/g, '');
  const docFn = body(block);
  const testFn = body(mine).slice(0, body(mine).indexOf('// ---- §5.3 結束'));
  expect(strip(testFn)).toBe(strip(docFn));
});

describe('§9 同步行為', () => {
  it('新增員工後目錄出現此人，部門正確', async () => {
    const res = await sendEvents([upsert('E1', at(480), { title: '工程師', company: '範例公司', email: 'e1@example.com' })]);
    expect(res.status).toBe(200);
    expect(await statuses(res)).toEqual(['applied']);
    expect(entry('E1')).toMatchObject({ name: '王小明', department: '資訊部', title: '工程師', company: '範例公司', origin: 'sync' });
  });

  it('異動部門後，下一個請求就依新部門判定', async () => {
    expect(getApplicant('E1', tenantId).department).toBe('資訊部');
    const res = await sendEvents([upsert('E1', at(540), { department: '業務部', title: '工程師', company: '範例公司', email: 'e1@example.com' })]);
    expect(await statuses(res)).toEqual(['applied']);
    expect(getApplicant('E1', tenantId).department).toBe('業務部');
  });

  it('不帶 title 送出後職稱被清除', async () => {
    const res = await sendEvents([upsert('E1', at(600), { department: '業務部' })]);
    expect(await statuses(res)).toEqual(['applied']);
    expect(entry('E1')).not.toHaveProperty('title');
    expect(entry('E1')).not.toHaveProperty('company');
    expect(entry('E1')).not.toHaveProperty('email');
    expect(getApplicant('E1', tenantId).title).toBeUndefined();
  });

  it('同一事件重送回 stale，資料不變', async () => {
    const ev = upsert('E1', at(600), { department: '業務部' });
    const before = JSON.stringify(entry('E1'));
    expect(await statuses(await sendEvents([ev]))).toEqual(['stale']);
    expect(JSON.stringify(entry('E1'))).toBe(before);
  });

  it('舊事件晚於新事件送達，資料維持最新', async () => {
    const res = await sendEvents([upsert('E1', at(510), { department: '人資部' })]);
    expect(await statuses(res)).toEqual(['stale']);
    expect(entry('E1')!.department).toBe('業務部');
  });

  it('occurredAt 相同時後到的被略過（文件 §7 的說明）', async () => {
    const res = await sendEvents([upsert('E1', at(600), { department: '財務部' })]);
    expect(await statuses(res)).toEqual(['stale']);
    expect(entry('E1')!.department).toBe('業務部');
  });

  it('user.deleted 後此人移出目錄，正在使用的 Session 被登出', async () => {
    const session = (await authSessionStore.create({ tenantId, sub: 'E1', kid: 'k', expiresInSeconds: 600 })).sessionToken;
    expect(await authSessionStore.get(session)).toBeDefined();
    const res = await sendEvents([del('E1', at(660))]);
    expect(await statuses(res)).toEqual(['applied']);
    expect(entry('E1')).toBeUndefined();
    expect(await authSessionStore.get(session)).toBeUndefined();
  });

  it('刪除後送來更早的 upsert 不會讓帳號復活', async () => {
    const res = await sendEvents([upsert('E1', at(630))]);
    expect(await statuses(res)).toEqual(['stale']);
    expect(entry('E1')).toBeUndefined();
  });

  it('復職：occurredAt 晚於刪除時間的 upsert 會重新建立', async () => {
    const res = await sendEvents([upsert('E1', at(720))]);
    expect(await statuses(res)).toEqual(['applied']);
    expect(entry('E1')).toBeDefined();
  });

  it('同一批內亂序：delete 在前、較舊的 upsert 在後', async () => {
    const res = await sendEvents([del('E2', at(780)), upsert('E2', at(779))]);
    expect(await statuses(res)).toEqual(['applied', 'stale']);
    expect(entry('E2')).toBeUndefined();
  });

  it('rejected 逐筆回報，不影響其他筆', async () => {
    const res = await sendEvents([
      upsert('E3', at(840)),
      upsert('E4', at(840), { extra: 'x' }),
      upsert('E5', at(840), { title: null }),
    ]);
    const json = (await res.json()) as { data: { results: { status: string; reason?: string }[] } };
    expect(json.data.results).toEqual([
      expect.objectContaining({ status: 'applied' }),
      expect.objectContaining({ status: 'rejected', reason: 'INVALID_USER' }),
      expect.objectContaining({ status: 'rejected', reason: 'INVALID_USER' }),
    ]);
    expect(entry('E3')).toBeDefined();
    expect(entry('E4')).toBeUndefined();
  });
});

describe('§9 錯誤處理', () => {
  const rawPost = (token: string, body: string) =>
    fetch(`${process.env.HYAGENT_HOST}/api/directory-sync/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });

  it('用登入金鑰簽的同步請求被拒絕（UNKNOWN_KID）', async () => {
    tenantStore.addPublicKey(tenantId, { publicKey: loginPair.publicKeyPem });
    const body = JSON.stringify({ events: [] });
    const token = issueAssertion({
      privateKey: loginPair.privateKeyPem,
      tenant: tenantId,
      subject: 'directory-sync',
      audience: 'hyagent:directory-sync',
      profile: { body_sha256: createHash('sha256').update(body).digest('hex') },
    });
    const res = await rawPost(token, body);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNKNOWN_KID');
  });

  it('竄改內容後收到 BODY_HASH_MISMATCH', async () => {
    const signedFor = JSON.stringify({ events: [] });
    const token = issueAssertion({
      privateKey: syncPair.privateKeyPem,
      tenant: tenantId,
      subject: 'directory-sync',
      audience: 'hyagent:directory-sync',
      profile: { body_sha256: createHash('sha256').update(signedFor).digest('hex') },
    });
    const res = await rawPost(token, JSON.stringify({ events: [upsert('EVIL', at(900))] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('BODY_HASH_MISMATCH');
    expect(entry('EVIL')).toBeUndefined();
  });

  it('重用同一張 JWT 收到 TOKEN_REPLAYED', async () => {
    const body = JSON.stringify({ events: [] });
    const token = issueAssertion({
      privateKey: syncPair.privateKeyPem,
      tenant: tenantId,
      subject: 'directory-sync',
      audience: 'hyagent:directory-sync',
      profile: { body_sha256: createHash('sha256').update(body).digest('hex') },
    });
    expect((await rawPost(token, body)).status).toBe(200);
    const again = await rawPost(token, body);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toBe('TOKEN_REPLAYED');
  });

  it('重送時重新簽章（sendEvents 每次產生新 jti）不會收到 TOKEN_REPLAYED', async () => {
    const batch = [upsert('E6', at(960))];
    expect(await statuses(await sendEvents(batch))).toEqual(['applied']);
    expect(await statuses(await sendEvents(batch))).toEqual(['stale']);
  });

  it('關閉同步後回 403 DIRECTORY_SYNC_DISABLED', async () => {
    tenantStore.updateTenant(tenantId, { directorySyncEnabled: false });
    const res = await sendEvents([]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('DIRECTORY_SYNC_DISABLED');
    tenantStore.updateTenant(tenantId, { directorySyncEnabled: true });
  });
});
