// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savingStore, shouldBlock, withSaving } from './savingStore';
import { api } from './api';

describe('shouldBlock：哪些請求要擋畫面', () => {
  it('寫入一律擋，GET 不擋', () => {
    expect(shouldBlock('GET', '/admin/tenants/t1')).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(shouldBlock(m, '/admin/tenants/t1')).toBe(true);
  });
  it('只查詢／測試的寫入方法不擋', () => {
    expect(shouldBlock('POST', '/admin/tenants/t1/knowledge/query-test')).toBe(false);
    expect(shouldBlock('POST', '/admin/dbi/s1/query/preview')).toBe(false);
    expect(shouldBlock('POST', '/admin/dbi/s1/data-sources/d1/connection-test')).toBe(false);
    expect(shouldBlock('PUT', '/admin/dbi/s1/tenants/t1/policies?dry_run=1')).toBe(false);
    expect(shouldBlock('PUT', '/admin/dbi/s1/tenants/t1/policies')).toBe(true);
  });
});

describe('withSaving：成功或失敗都要解除', () => {
  it('同時多個請求要等最後一個結束', async () => {
    let r1!: () => void;
    let r2!: () => void;
    const a = withSaving(() => new Promise<void>((r) => (r1 = r)));
    const b = withSaving(() => new Promise<void>((r) => (r2 = r)));
    expect(savingStore.get()).toBe(2);
    r1();
    await a;
    expect(savingStore.get()).toBe(1);
    r2();
    await b;
    expect(savingStore.get()).toBe(0);
  });
  it('失敗也會解除', async () => {
    await expect(withSaving(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(savingStore.get()).toBe(0);
  });
});

describe('api 寫入請求會鎖住畫面', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('PATCH 進行中計數 > 0，完成後歸零；GET 不計', async () => {
    const seen: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      seen.push(savingStore.get());
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }));
    await api.updateTenant('t1', { name: 'n' });
    await api.getTenant('t1');
    expect(seen).toEqual([1, 0]);
    expect(savingStore.get()).toBe(0);
  });
});
