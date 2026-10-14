import http from 'node:http';
import dns from 'node:dns/promises';
import { env } from '@/config/env';
import { isPublicMcpAddress, mcpSecureFetch, resolveMcpAddress, validateMcpUrl } from '@/modules/mcp/mcp.network';

const nodeEnv = env.NODE_ENV;
afterEach(() => { env.NODE_ENV = nodeEnv; env.MCP_ALLOWED_PRIVATE_ORIGINS = ''; jest.restoreAllMocks(); });

it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::'])('rejects non-public addresses %s', (address) => {
  expect(isPublicMcpAddress(address)).toBe(false);
});

it('requires HTTPS in production and rejects URL credentials', () => {
  env.NODE_ENV = 'production';
  expect(() => validateMcpUrl('http://example.com/mcp')).toThrow();
  expect(() => validateMcpUrl('https://user:pass@example.com/mcp')).toThrow();
  expect(() => validateMcpUrl('https://example.com/mcp')).not.toThrow();
});

it('rejects mixed public/private DNS; allows only exact private origins; never permits metadata', async () => {
  jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] as never);
  await expect(resolveMcpAddress(new URL('https://tools.example.com/mcp'))).rejects.toMatchObject({ code: 'MCP_DESTINATION_BLOCKED' });
  env.MCP_ALLOWED_PRIVATE_ORIGINS = 'https://tools.example.com';
  await expect(resolveMcpAddress(new URL('https://tools.example.com/mcp'))).resolves.toMatchObject({ address: '8.8.8.8' });
  env.MCP_ALLOWED_PRIVATE_ORIGINS = 'http://169.254.169.254';
  await expect(resolveMcpAddress(new URL('http://169.254.169.254/mcp'))).rejects.toThrow();
});

it('pins DNS to the checked address and rejects redirects without forwarding authorization', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    expect(req.headers.authorization).toBe('Bearer test');
    res.writeHead(302, { location: 'http://169.254.169.254/latest' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://tools.example.com:${port}/mcp`;
  env.MCP_ALLOWED_PRIVATE_ORIGINS = new URL(url).origin;
  const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  try {
    await expect(mcpSecureFetch(url, url, { headers: { authorization: 'Bearer test' } })).rejects.toMatchObject({ code: 'MCP_DESTINATION_BLOCKED' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hits).toBe(1);
    await expect(mcpSecureFetch(url, 'http://other.example.com/mcp')).rejects.toThrow();
    expect(hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
