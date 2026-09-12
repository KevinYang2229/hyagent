import { afterEach, expect, it, vi } from 'vitest';
import { createOAAgent } from './index';

afterEach(() => vi.unstubAllGlobals());

it('concurrent expired requests share one refresh rotation', async () => {
  let refreshes = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/sso/exchange')) return Response.json({ data: { accessToken: 'old', refreshToken: 'once' } });
    if (url.endsWith('/refresh')) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ data: { accessToken: 'new', refreshToken: 'next' } });
    }
    const header = (init?.headers as Record<string, string>)?.authorization;
    return header === 'Bearer new' ? Response.json({ data: [] }) : new Response('{}', { status: 401 });
  });
  vi.stubGlobal('fetch', fetch);
  const client = createOAAgent({ apiBase: 'http://localhost', userToken: 'handoff' });
  await client.authenticate();
  await Promise.all([client.conversations.get('one'), client.conversations.get('two')]);
  expect(refreshes).toBe(1);
});
