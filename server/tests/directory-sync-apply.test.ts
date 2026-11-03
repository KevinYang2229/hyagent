import { applyDirectoryEvents } from '@/modules/user/directory-sync.apply';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const upsert = (id: string, at: string, over: Record<string, unknown> = {}, eventId = `e-${id}-${at}`) => ({
  eventId, type: 'user.upserted', occurredAt: at,
  user: { id, name: `名-${id}`, department: '資訊部', ...over },
});
const del = (userId: string, at: string, eventId = `d-${userId}-${at}`) => ({ eventId, type: 'user.deleted', occurredAt: at, userId });

function run(events: unknown[], users: DirectoryEntry[] = [], tombstones: Record<string, string> = {}) {
  return applyDirectoryEvents({ users, tombstones, events, nowMs: NOW });
}
const T1 = '2026-11-03T07:00:00.000Z';
const T2 = '2026-11-03T07:30:00.000Z';

describe('applyDirectoryEvents', () => {
  it('upsert 建立新人，origin 為 sync，syncedAt 為正規化 ISO', () => {
    const r = run([upsert('A', '2026-11-03T15:00:00+08:00', { title: '工程師', email: 'a@x.com' })]);
    expect(r.results).toEqual([{ eventId: 'e-A-2026-11-03T15:00:00+08:00', status: 'applied' }]);
    expect(r.users).toEqual([{ id: 'A', name: '名-A', department: '資訊部', title: '工程師', email: 'a@x.com', origin: 'sync', syncedAt: '2026-11-03T07:00:00.000Z' }]);
    expect(r.changed).toBe(true);
  });

  it('upsert 會 trim id／name／department', () => {
    const r = run([upsert('  A ', T1, { name: ' 王 ', department: ' 資訊部 ' })]);
    expect(r.users[0]).toMatchObject({ id: 'A', name: '王', department: '資訊部' });
  });

  it('upsert 更新既有人員：沒帶的 title/company/email 被清除', () => {
    const old: DirectoryEntry = { id: 'A', name: '舊', department: '舊部', title: 't', company: 'c', email: 'o@x.com', origin: 'sync', syncedAt: T1 };
    const r = run([upsert('A', T2)], [old]);
    expect(r.users[0]).toEqual({ id: 'A', name: '名-A', department: '資訊部', origin: 'sync', syncedAt: T2 });
    expect('title' in r.users[0]).toBe(false);
    expect('company' in r.users[0]).toBe(false);
    expect('email' in r.users[0]).toBe(false);
  });

  it('upsert 保留 deputyIds、region、origin', () => {
    const old: DirectoryEntry = { id: 'A', name: '舊', department: '舊部', region: '台北', deputyIds: ['B'], origin: 'sync', syncedAt: T1 };
    const r = run([upsert('A', T2)], [old]);
    expect(r.users[0]).toMatchObject({ region: '台北', deputyIds: ['B'], origin: 'sync', syncedAt: T2 });
  });

  it('manual 帳號被接手後 origin 仍是 manual', () => {
    const r = run([upsert('A', T1)], [{ id: 'A', name: '舊', department: '舊部', origin: 'manual' }]);
    expect(r.users[0]).toMatchObject({ origin: 'manual', syncedAt: T1, name: '名-A' });
  });

  it('沒有 origin 的舊資料被接手後仍沒有 origin', () => {
    const r = run([upsert('A', T1)], [{ id: 'A', name: '舊', department: '舊部' }]);
    expect('origin' in r.users[0]).toBe(false);
    expect(r.results[0].status).toBe('applied');
  });

  it('sso 帳號被接手後 origin 仍是 sso，且有 syncedAt', () => {
    const r = run([upsert('A', T1)], [{ id: 'A', name: '舊', department: '舊部', origin: 'sso' }]);
    expect(r.users[0]).toMatchObject({ origin: 'sso', syncedAt: T1 });
  });

  it('occurredAt 相同或較舊回 stale，資料不變', () => {
    const old: DirectoryEntry = { id: 'A', name: '舊', department: '舊部', origin: 'sync', syncedAt: T2 };
    const r = run([upsert('A', T2, {}, 'same'), upsert('A', T1, {}, 'older')], [old]);
    expect(r.results.map((x) => x.status)).toEqual(['stale', 'stale']);
    expect(r.users).toEqual([old]);
    expect(r.changed).toBe(false);
  });

  it('不同時區表示同一時刻視為相同：+08:00 與 Z', () => {
    const old: DirectoryEntry = { id: 'A', name: '舊', department: '舊部', origin: 'sync', syncedAt: '2026-11-03T07:00:00.000Z' };
    const r = run([upsert('A', '2026-11-03T15:00:00.000+08:00')], [old]);
    expect(r.results[0].status).toBe('stale');
  });

  it('occurredAt 超過現在 5 分鐘回 rejected INVALID_OCCURRED_AT，剛好 5 分鐘可接受', () => {
    const r = run([upsert('A', iso(NOW + 5 * 60_000 + 1), {}, 'late'), upsert('B', iso(NOW + 5 * 60_000), {}, 'edge')]);
    expect(r.results).toEqual([
      { eventId: 'late', status: 'rejected', reason: 'INVALID_OCCURRED_AT' },
      { eventId: 'edge', status: 'applied' },
    ]);
    expect(r.users.map((u) => u.id)).toEqual(['B']);
  });

  it('occurredAt 無法解析回 rejected INVALID_OCCURRED_AT', () => {
    const r = run([upsert('A', 'not-a-date', {}, 'x'), { eventId: 'y', type: 'user.deleted', userId: 'A' }]);
    expect(r.results).toEqual([
      { eventId: 'x', status: 'rejected', reason: 'INVALID_OCCURRED_AT' },
      { eventId: 'y', status: 'rejected', reason: 'INVALID_OCCURRED_AT' },
    ]);
    expect(r.changed).toBe(false);
  });

  it('批次內同一人亂序：結果為最新那筆', () => {
    const r = run([upsert('A', T2, { name: '新' }, 'n'), upsert('A', T1, { name: '舊' }, 'o')]);
    expect(r.results.map((x) => x.status)).toEqual(['applied', 'stale']);
    expect(r.users).toHaveLength(1);
    expect(r.users[0]).toMatchObject({ name: '新', syncedAt: T2 });
  });

  it('delete 移出目錄、寫入刪除紀錄、從他人 deputyIds 移除，並列入 revokeUserIds', () => {
    const users: DirectoryEntry[] = [
      { id: 'A', name: 'a', department: 'd', origin: 'sync', syncedAt: T1 },
      { id: 'B', name: 'b', department: 'd', deputyIds: ['A', 'C'] },
      { id: 'C', name: 'c', department: 'd' },
    ];
    const r = run([del('A', T2)], users);
    expect(r.results[0].status).toBe('applied');
    expect(r.users.map((u) => u.id)).toEqual(['B', 'C']);
    expect(r.users[0].deputyIds).toEqual(['C']);
    expect(r.tombstones).toEqual({ A: T2 });
    expect(r.revokeUserIds).toEqual(['A']);
  });

  it('delete 不存在的人：仍寫入刪除紀錄、回 applied', () => {
    const r = run([del('Z', T1)]);
    expect(r.results[0].status).toBe('applied');
    expect(r.tombstones).toEqual({ Z: T1 });
    expect(r.revokeUserIds).toEqual(['Z']);
    expect(r.changed).toBe(true);
  });

  it('重送相同 occurredAt 的 delete：回 stale，但仍列入 revokeUserIds', () => {
    const r = run([del('Z', T1)], [], { Z: T1 });
    expect(r.results[0].status).toBe('stale');
    expect(r.revokeUserIds).toEqual(['Z']);
    expect(r.changed).toBe(false);
  });

  it('較舊的 delete 回 stale，不列入 revokeUserIds', () => {
    const users: DirectoryEntry[] = [{ id: 'A', name: 'a', department: 'd', origin: 'sync', syncedAt: T2 }];
    const r = run([del('A', T1, 'd1'), del('Z', T1, 'd2')], users, { Z: T2 });
    expect(r.results.map((x) => x.status)).toEqual(['stale', 'stale']);
    expect(r.revokeUserIds).toEqual([]);
    expect(r.users).toEqual(users);
  });

  it('沒有 syncedAt 的手動帳號可被 delete', () => {
    const r = run([del('A', T1)], [{ id: 'A', name: 'a', department: 'd', origin: 'manual' }]);
    expect(r.users).toEqual([]);
    expect(r.results[0].status).toBe('applied');
  });

  it('刪除後遲到的舊 upsert 不會復活', () => {
    const r = run([upsert('A', T1)], [], { A: T2 });
    expect(r.results[0].status).toBe('stale');
    expect(r.users).toEqual([]);
    const same = run([upsert('A', T2)], [], { A: T2 });
    expect(same.results[0].status).toBe('stale');
  });

  it('晚於刪除紀錄的 upsert 重新建立（復職）', () => {
    const r = run([upsert('A', T2)], [], { A: T1 });
    expect(r.results[0].status).toBe('applied');
    expect(r.users[0]).toMatchObject({ id: 'A', origin: 'sync', syncedAt: T2 });
  });

  it('超過 10,000 人回 rejected DIRECTORY_FULL，更新既有人員不受影響', () => {
    const users: DirectoryEntry[] = Array.from({ length: 10000 }, (_, i) => ({ id: `u${i}`, name: 'n', department: 'd', origin: 'sync' as const, syncedAt: T1 }));
    const r = run([upsert('new', T2, {}, 'n'), upsert('u5', T2, { name: '改' }, 'u')], users);
    expect(r.results).toEqual([
      { eventId: 'n', status: 'rejected', reason: 'DIRECTORY_FULL' },
      { eventId: 'u', status: 'applied' },
    ]);
    expect(r.users).toHaveLength(10000);
    expect(r.users[5].name).toBe('改');
  });

  it('一筆不合法時，其他筆照常套用', () => {
    const r = run([upsert('A', T1, {}, 'a'), 'junk', upsert('B', T1, {}, 'b')]);
    expect(r.results.map((x) => x.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(r.users.map((u) => u.id)).toEqual(['A', 'B']);
  });

  it('email 不合法、缺 name 或 department 回 rejected INVALID_USER', () => {
    const bad = (user: unknown, eventId: string) => ({ eventId, type: 'user.upserted', occurredAt: T1, user });
    const r = run([
      upsert('A', T1, { email: 'nope' }, 'e1'),
      bad({ id: 'B', department: 'd' }, 'e2'),
      bad({ id: 'C', name: 'n' }, 'e3'),
      bad({ id: 'D', name: 'n', department: 'd', origin: 'manual' }, 'e4'),
      bad(null, 'e5'),
    ]);
    expect(r.results).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((eventId) => ({ eventId, status: 'rejected', reason: 'INVALID_USER' })));
    expect(r.users).toEqual([]);
  });

  it('delete 的 userId 超過 200 字元回 INVALID_EVENT，剛好 200 字元可以套用', () => {
    const r = run([del('x'.repeat(201), T1, 'long'), del('y'.repeat(200), T1, 'ok')]);
    expect(r.results).toEqual([
      { eventId: 'long', status: 'rejected', reason: 'INVALID_EVENT' },
      { eventId: 'ok', status: 'applied' },
    ]);
    expect(Object.keys(r.tombstones)).toEqual(['y'.repeat(200)]);
    expect(r.revokeUserIds).toEqual(['y'.repeat(200)]);
  });

  it('格式錯誤的事件回 rejected INVALID_EVENT，eventId 無法取得時為空字串', () => {
    const r = run([null, 42, { type: 'user.upserted' }, { eventId: 'x', type: 'weird', occurredAt: T1 }, { eventId: 'y', type: 'user.deleted', occurredAt: T1 }]);
    expect(r.results).toEqual([
      { eventId: '', status: 'rejected', reason: 'INVALID_EVENT' },
      { eventId: '', status: 'rejected', reason: 'INVALID_EVENT' },
      { eventId: '', status: 'rejected', reason: 'INVALID_EVENT' },
      { eventId: 'x', status: 'rejected', reason: 'INVALID_EVENT' },
      { eventId: 'y', status: 'rejected', reason: 'INVALID_EVENT' },
    ]);
  });

  it('超過 30 天的刪除紀錄被清除，剛好 30 天與未滿 30 天保留', () => {
    const tombstones = { old: iso(NOW - 30 * DAY - 1), edge: iso(NOW - 30 * DAY), fresh: iso(NOW - DAY) };
    const r = run([], [], tombstones);
    expect(r.tombstones).toEqual({ edge: tombstones.edge, fresh: tombstones.fresh });
    expect(r.changed).toBe(true);
  });

  it('全部 stale 時 changed 為 false', () => {
    const r = run([upsert('A', T1)], [{ id: 'A', name: 'a', department: 'd', syncedAt: T2 }]);
    expect(r.changed).toBe(false);
  });

  it('不修改輸入', () => {
    const users: DirectoryEntry[] = [
      { id: 'A', name: 'a', department: 'd', title: 't', origin: 'sync', syncedAt: T1 },
      { id: 'B', name: 'b', department: 'd', deputyIds: ['A'] },
    ];
    const tombstones = { old: iso(NOW - 40 * DAY) };
    const events = [upsert('A', T2), del('A', T2, 'dd'), upsert('C', T1)];
    const snap = JSON.parse(JSON.stringify({ users, tombstones, events }));
    run(events, users, tombstones);
    expect({ users, tombstones, events }).toEqual(snap);
  });
});
