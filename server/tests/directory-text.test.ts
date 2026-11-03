/** 目錄文字欄位的可儲存檢查：NUL／控制字元／單獨代理字元不得進入快照。 */
import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { applyDirectoryEvents } from '@/modules/user/directory-sync.apply';
import { isStorableText } from '@/modules/user/directory-text';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const T1 = '2026-11-03T07:00:00.000Z';

describe('isStorableText', () => {
  it.each(['王小明', 'Alice', '資訊部 (台北)', '😀 emoji', 'a b c', ''])('可儲存：%j', (v) => {
    expect(isStorableText(v)).toBe(true);
  });
  it.each([
    ['NUL', 'E1\u0000'], ['控制字元 U+001F', 'a\u001fb'], ['DEL', 'a\u007f'], ['換行', 'a\nb'],
    ['單獨高代理', 'a\ud83d'], ['單獨低代理', '\ude00b'], ['顛倒的代理對', '\ude00\ud83d'],
  ])('不可儲存：%s', (_l, v) => {
    expect(isStorableText(v)).toBe(false);
  });
});

describe('applyDirectoryEvents 拒絕不可儲存的文字', () => {
  const upsert = (user: Record<string, unknown>) => ({ eventId: 'e1', type: 'user.upserted', occurredAt: T1, user: { id: 'A', name: 'N', department: 'D', ...user } });
  const run = (events: unknown[]) => applyDirectoryEvents({ users: [], tombstones: {}, events, nowMs: NOW });

  it.each(['id', 'name', 'department', 'title', 'company'])('upsert 的 %s 含 NUL → INVALID_USER，不寫入', (field) => {
    const r = run([upsert({ [field]: 'x\u0000y' })]);
    expect(r.results).toEqual([{ eventId: 'e1', status: 'rejected', reason: 'INVALID_USER' }]);
    expect(r.users).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('upsert 的 name 含單獨代理字元 → INVALID_USER', () => {
    expect(run([upsert({ name: 'x\ud83d' })]).results[0]).toMatchObject({ status: 'rejected', reason: 'INVALID_USER' });
  });

  it('delete 的 userId 含 NUL → INVALID_EVENT，不產生刪除紀錄', () => {
    const r = run([{ eventId: 'd1', type: 'user.deleted', occurredAt: T1, userId: 'E1\u0000' }]);
    expect(r.results).toEqual([{ eventId: 'd1', status: 'rejected', reason: 'INVALID_EVENT' }]);
    expect(r.tombstones).toEqual({});
    expect(r.revokeUserIds).toEqual([]);
  });

  it('正常中文與 emoji 照常套用', () => {
    expect(run([upsert({ name: '王小明😀' })]).results[0].status).toBe('applied');
  });
});

describe('後台新增人員', () => {
  const app = createApp();
  const admin = { 'x-admin-key': 'test-admin-key' };
  it('name 含 NUL → 422，不寫入', async () => {
    const t = tenantStore.createTenant('text-admin');
    tenantStore.updateTenant(t.id, { userDirectory: [] });
    await request(app).post(`/api/admin/tenants/${t.id}/users`).set(admin).send({ id: 'n', name: 'N\u0000' }).expect(422);
    expect(tenantStore.getTenant(t.id)!.userDirectory).toEqual([]);
  });
  it('正常中文與 emoji 可新增', async () => {
    const t = tenantStore.createTenant('text-admin-ok');
    tenantStore.updateTenant(t.id, { userDirectory: [] });
    await request(app).post(`/api/admin/tenants/${t.id}/users`).set(admin).send({ id: 'n', name: '王😀' }).expect(201);
  });
});
