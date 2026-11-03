/**
 * scopePolicy.clearAccountGrants 的落地保證：這是 webhook 回 200 前要等的寫入，
 * 不可沿用 setPolicy 的「失敗只記警告」語意，否則寫入失敗 OA 也不會重送。
 */
import fs from 'node:fs';
import { env } from '@/config/env';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { scopePolicy } from '@/modules/authz/scope-policy';

jest.mock('@/lib/db', () => ({ ...jest.requireActual('@/lib/db'), connectDb: jest.fn() }));

const T = 'durable-tenant';
const seed = () => scopePolicy.setPolicy(T, {
  groups: { D: ['g'] },
  accounts: { A: ['x'], B: ['y'], __proto__x: ['z'] },
  bundles: [{ id: 'r', name: 'R', scopes: ['s'] }],
  accountBundles: { A: ['r'], B: ['r'] },
  tenantBundles: [],
});

afterEach(() => {
  env.DATA_BACKEND = 'file';
  jest.restoreAllMocks();
  scopePolicy.clear();
});

describe('file 後端', () => {
  it('寫入失敗會 reject（不像 setPolicy 吞掉），記憶體已清；重試再寫一次', async () => {
    seed();
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(scopePolicy.clearAccountGrants(T, ['A'])).rejects.toThrow('disk full');
    expect(scopePolicy.accountScopes(T, 'A')).toEqual([]);
    expect(scopePolicy.accountBundleScopes(T, 'A')).toEqual([]);

    spy.mockClear();
    await expect(scopePolicy.clearAccountGrants(T, ['A'])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const written = new Map(JSON.parse(String(spy.mock.calls[0][1])) as [string, { accounts: object }][]);
    expect(written.get(T)!.accounts).not.toHaveProperty('A');
  });

  it('一次清多人，不動其他欄位', async () => {
    seed();
    await scopePolicy.clearAccountGrants(T, ['A', 'B']);
    const p = scopePolicy.getPolicy(T);
    expect(Object.keys(p.accounts)).toEqual(['__proto__x']);
    expect(p.accountBundles).toEqual({});
    expect(p.groups).toEqual({ D: ['g'] });
    expect(p.bundles).toHaveLength(1);
  });

  it('userId 剛好是 Object 內建名稱（__proto__）也只移除自己，不污染原型', async () => {
    scopePolicy.setPolicy(T, JSON.parse('{"groups":{},"accounts":{"__proto__":["evil"],"A":["x"]}}'));
    expect(scopePolicy.accountScopes(T, '__proto__')).toEqual(['evil']);
    await scopePolicy.clearAccountGrants(T, ['__proto__']);
    expect(scopePolicy.accountScopes(T, '__proto__')).toEqual([]);
    expect(scopePolicy.accountScopes(T, 'A')).toEqual(['x']);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it('沒有 accountBundles 的舊資料不會多出這個欄位', async () => {
    scopePolicy.setPolicy(T, { groups: {}, accounts: { A: ['x'] } });
    await scopePolicy.clearAccountGrants(T, ['A']);
    expect(scopePolicy.getPolicy(T)).toEqual({ groups: {}, accounts: {} });
  });

  it('租戶沒有政策：不寫檔、不建立政策', async () => {
    const spy = jest.spyOn(fs, 'writeFileSync');
    await scopePolicy.clearAccountGrants('no-policy', ['A']);
    expect(spy).not.toHaveBeenCalled();
    expect(scopePolicy.getPolicy('no-policy')).toEqual({ groups: {}, accounts: {} });
  });

  it('空清單：不寫檔', async () => {
    seed();
    const spy = jest.spyOn(fs, 'writeFileSync');
    await scopePolicy.clearAccountGrants(T, []);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('db 後端', () => {
  it('upsert 失敗會 reject；重試再 upsert 並帶清除後的資料', async () => {
    seed();
    const upsert = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    jest.mocked(connectDb).mockResolvedValue({ scopePolicyRow: { upsert } } as never);
    env.DATA_BACKEND = 'db';

    await expect(scopePolicy.clearAccountGrants(T, ['A'])).rejects.toThrow('db down');
    await expect(scopePolicy.clearAccountGrants(T, ['A'])).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(2);
    const arg = upsert.mock.calls[1][0];
    expect(arg.where).toEqual({ tenantId: T });
    expect(arg.update.data.accounts).not.toHaveProperty('A');
    expect(arg.update.data.accountBundles).not.toHaveProperty('A');
  });

  it('要等 upsert 完成才 resolve', async () => {
    seed();
    let release!: () => void;
    const upsert = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    jest.mocked(connectDb).mockResolvedValue({ scopePolicyRow: { upsert } } as never);
    env.DATA_BACKEND = 'db';
    let done = false;
    const p = scopePolicy.clearAccountGrants(T, ['A']).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });
});

describe('DbWriteQueue.runCritical', () => {
  it('排在先前的寫入之後才執行，失敗回給呼叫端，且不會卡住之後的寫入', async () => {
    const queue = new DbWriteQueue('test');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.runCritical(async () => { await gate; order.push('first'); });
    const second = queue.runCritical(async () => { order.push('second'); throw new Error('boom'); });
    const third = queue.runCritical(async () => { order.push('third'); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    release();
    await first;
    await expect(second).rejects.toThrow('boom');
    await third;
    expect(order).toEqual(['first', 'second', 'third']);
    await expect(queue.flush()).resolves.toBeUndefined();
  });
});
