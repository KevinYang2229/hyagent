// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  localStorage.setItem('oa-access-token', 'old');
  localStorage.setItem('oa-refresh-token', 'once');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('parallel 401 responses share a single refresh', async () => {
  let refreshes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/refresh')) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ data: { accessToken: 'new', refreshToken: 'next' } });
    }
    return new Headers(init?.headers).get('authorization') === 'Bearer new'
      ? Response.json({ data: {} }) : new Response('{}', { status: 401 });
  }));
  const { fetchReport } = await import('./api');
  await Promise.all([fetchReport('one'), fetchReport('two')]);
  expect(refreshes).toBe(1);
  expect(localStorage.getItem('oa-refresh-token')).toBe('next');
});

it('uses credentials already rotated by another tab instead of replaying the old token', async () => {
  let refreshes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/refresh')) { refreshes++; throw new Error('must not refresh'); }
    if (new Headers(init?.headers).get('authorization') === 'Bearer new') return Response.json({ data: {} });
    localStorage.setItem('oa-access-token', 'new');
    localStorage.setItem('oa-refresh-token', 'next');
    return new Response('{}', { status: 401 });
  }));
  const { fetchReport } = await import('./api');
  await fetchReport('one');
  expect(refreshes).toBe(0);
});
