/**
 * HyAgent Session 的伺服器端儲存（規格 §7.1、§2.6、§7.4；評估文件 §6.2.1）。
 *
 * 這支釘的三件事，錯了都不會有功能症狀：
 *   1. token 與 sub 不以原文落地——DB / 快照外洩不該等於一批可直接使用的 Session。
 *   2. 依 kid 與依 sub 的批次作廢確實只殺到該殺的，且不跨租戶。
 *   3. 過期判定在**讀取路徑**，不依賴清理排程有沒有跑過。
 */
import fs from 'node:fs';
import { env } from '@/config/env';
import { authSessionStore, hashSub, readSub } from '@/lib/auth-session.store';
import { sweepExpired } from '@/lib/expiry-sweeper';
import { dataFile } from '@/lib/data-dir';

const HOUR = 3600;
const TEST_ENC_KEY = 'a'.repeat(64);

async function create(over: Partial<Parameters<typeof authSessionStore.create>[0]> = {}) {
  return authSessionStore.create({
    tenantId: 'tenantA',
    sub: '507',
    kid: 'kid-1',
    expiresInSeconds: HOUR,
    ...over,
  });
}

beforeEach(() => {
  authSessionStore.__resetForTests();
});

describe('建立與讀取', () => {
  it('sessionToken 是帶 hyas_ 前綴的不透明字串，Widget 不需要也不該解析它', async () => {
    const { sessionToken, expiresIn } = await create();
    expect(sessionToken).toMatch(/^hyas_[A-Za-z0-9_-]{20,}$/);
    expect(sessionToken.split('.')).toHaveLength(1); // 不是 JWT（規格 §7.1 明文禁止 self-contained）
    expect(expiresIn).toBe(HOUR);
  });

  it('每次建立的 token 都不同', async () => {
    const a = await create();
    const b = await create();
    expect(a.sessionToken).not.toBe(b.sessionToken);
  });

  it('以 token 取得 Session，且帶著建立時的 kid（規格 §2.6）', async () => {
    const { sessionToken } = await create({ kid: 'kid-abc', name: '羅玉瑩' });
    const session = await authSessionStore.get(sessionToken);
    expect(session).toMatchObject({ tenantId: 'tenantA', kid: 'kid-abc', name: '羅玉瑩' });
  });

  it('不存在的 token 回 undefined', async () => {
    await expect(authSessionStore.get('hyas_nope')).resolves.toBeUndefined();
  });
});

describe('落地的都不是原文（評估文件 §6.2.1 b）', () => {
  it('儲存的紀錄不含 sessionToken 原文，只有它的雜湊', async () => {
    const { sessionToken, session } = await create();
    expect(session.id).not.toBe(sessionToken);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(session)).not.toContain(sessionToken);
  });

  it('快照檔不含 token 原文，且帶著供批次作廢用的 subHash', async () => {
    const { sessionToken } = await create({ sub: 'employee-507' });
    const snapshot = fs.readFileSync(dataFile('oa-agent-auth-sessions.json'), 'utf-8');
    expect(snapshot).not.toContain(sessionToken);
    expect(snapshot).toContain(hashSub('tenantA', 'employee-507'));
  });

  it('設了 DATA_ENCRYPTION_KEY 時，sub 以密文落地，readSub 讀得回原文', async () => {
    env.DATA_ENCRYPTION_KEY = TEST_ENC_KEY;
    try {
      const { session } = await create({ sub: 'employee-507' });
      expect(session.subEnc).toMatch(/^enc:v1:/);
      expect(session.subEnc).not.toContain('employee-507');
      expect(readSub(session)).toBe('employee-507');

      const snapshot = fs.readFileSync(dataFile('oa-agent-auth-sessions.json'), 'utf-8');
      expect(snapshot).not.toContain('employee-507');
    } finally {
      env.DATA_ENCRYPTION_KEY = '';
    }
  });

  it('未設金鑰時退回明文（dev 便利，與 llmConfig 金鑰同一套機制）', async () => {
    const { session } = await create({ sub: 'employee-507' });
    expect(readSub(session)).toBe('employee-507');
    expect(session.subEnc).toBe('employee-507');
  });

  it('正式環境未設金鑰時直接拒絕建立 Session——使用者識別碼不該明文躺在暫存目錄', async () => {
    env.NODE_ENV = 'production';
    try {
      await expect(create()).rejects.toThrow(/DATA_ENCRYPTION_KEY/);
    } finally {
      env.NODE_ENV = 'test';
    }
  });

  it('同一個 sub 在不同租戶算出不同雜湊——否則依 sub 作廢會跨租戶誤殺', () => {
    expect(hashSub('tenantA', '507')).not.toBe(hashSub('tenantB', '507'));
  });
});

describe('作廢（規格 §2.6、§7.2、§7.4）', () => {
  it('revoke 單一 Session，其他不受影響', async () => {
    const a = await create();
    const b = await create();
    await expect(authSessionStore.revoke(a.sessionToken)).resolves.toBe(true);
    await expect(authSessionStore.get(a.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(b.sessionToken)).resolves.toBeDefined();
  });

  it('revoke 不存在的 token 回 false，不丟錯', async () => {
    await expect(authSessionStore.revoke('hyas_nope')).resolves.toBe(false);
  });

  it('依 kid 作廢：只殺以該金鑰建立的 Session（§2.6）', async () => {
    const old = await create({ kid: 'kid-old' });
    const fresh = await create({ kid: 'kid-new' });

    await expect(authSessionStore.revokeByKid('tenantA', 'kid-old')).resolves.toBe(1);
    await expect(authSessionStore.get(old.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(fresh.sessionToken)).resolves.toBeDefined();
  });

  it('依 kid 作廢不跨租戶', async () => {
    const mine = await create({ tenantId: 'tenantA', kid: 'shared-kid' });
    const theirs = await create({ tenantId: 'tenantB', kid: 'shared-kid' });

    await expect(authSessionStore.revokeByKid('tenantA', 'shared-kid')).resolves.toBe(1);
    await expect(authSessionStore.get(mine.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(theirs.sessionToken)).resolves.toBeDefined();
  });

  it('依 sub 作廢：同一使用者的多個 Session 一起清掉（§7.4）', async () => {
    const desktop = await create({ sub: '507' });
    const mobile = await create({ sub: '507' });
    const colleague = await create({ sub: '508' });

    await expect(authSessionStore.revokeBySub('tenantA', '507')).resolves.toBe(2);
    await expect(authSessionStore.get(desktop.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(mobile.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(colleague.sessionToken)).resolves.toBeDefined();
  });

  it('對無有效 Session 的 sub 回 0 而不是丟錯——否則就成了帳號在線與否的探測器（§7.4）', async () => {
    await expect(authSessionStore.revokeBySub('tenantA', 'never-logged-in')).resolves.toBe(0);
  });

  it('依 sub 作廢不跨租戶', async () => {
    const mine = await create({ tenantId: 'tenantA', sub: '507' });
    const theirs = await create({ tenantId: 'tenantB', sub: '507' });

    await expect(authSessionStore.revokeBySub('tenantA', '507')).resolves.toBe(1);
    await expect(authSessionStore.get(mine.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(theirs.sessionToken)).resolves.toBeDefined();
  });

  it('依租戶清空', async () => {
    const a = await create({ tenantId: 'tenantA' });
    const b = await create({ tenantId: 'tenantB' });
    await expect(authSessionStore.revokeByTenant('tenantA')).resolves.toBe(1);
    await expect(authSessionStore.get(a.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(b.sessionToken)).resolves.toBeDefined();
  });
});

describe('到期', () => {
  it('過期的 Session 在讀取路徑就被擋下，不必等清理排程', async () => {
    const { sessionToken } = await create({ expiresInSeconds: -1 });
    await expect(authSessionStore.get(sessionToken)).resolves.toBeUndefined();
  });

  it('sweep 只清過期的', async () => {
    const dead = await create({ expiresInSeconds: -1 });
    const live = await create();

    const { sessions } = await sweepExpired();

    expect(sessions).toBe(1);
    await expect(authSessionStore.get(dead.sessionToken)).resolves.toBeUndefined();
    await expect(authSessionStore.get(live.sessionToken)).resolves.toBeDefined();
  });

  it('expiresAt 依 expiresInSeconds 計算', async () => {
    const { session } = await create({ expiresInSeconds: 7200 });
    const lifetime = Date.parse(session.expiresAt) - Date.parse(session.createdAt);
    expect(lifetime).toBe(7200 * 1000);
  });
});
