import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';

const privateRanges = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateRanges.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const excludedV6 = new BlockList();
excludedV6.addSubnet('2001::', 23, 'ipv6');
excludedV6.addSubnet('2001:db8::', 32, 'ipv6');
excludedV6.addSubnet('2002::', 16, 'ipv6');

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !privateRanges.check(address, 'ipv4') :
    family === 6 && globalV6.check(address, 'ipv6') && !excludedV6.check(address, 'ipv6');
}

function denied(): AppError {
  return new AppError(403, 'MCP_DESTINATION_BLOCKED', 'MCP 連線目的地未獲准。');
}

export function validateMcpUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw denied();
  return url;
}

export async function resolveMcpAddress(url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  const allowPrivate = env.MCP_ALLOWED_PRIVATE_ORIGINS.split(',').map((s) => s.trim()).includes(url.origin);
  // Metadata/link-local and unspecified addresses remain forbidden even with an exception.
  const prohibited = new BlockList();
  prohibited.addSubnet('169.254.0.0', 16, 'ipv4');
  prohibited.addSubnet('0.0.0.0', 8, 'ipv4');
  prohibited.addSubnet('fe80::', 10, 'ipv6');
  prohibited.addAddress('::', 'ipv6');
  prohibited.addAddress('fd00:ec2::254', 'ipv6');
  prohibited.addAddress('100.100.100.200', 'ipv4');
  const privateExceptions = new BlockList();
  for (const [ip, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8]] as const) privateExceptions.addSubnet(ip, bits, 'ipv4');
  privateExceptions.addSubnet('fc00::', 7, 'ipv6');
  privateExceptions.addAddress('::1', 'ipv6');
  const mappedV6 = new BlockList();
  mappedV6.addSubnet('::ffff:0:0', 96, 'ipv6');
  if (!addresses.length || addresses.some(({ address, family }) => {
    if ((family === 6 && mappedV6.check(address, 'ipv6')) || prohibited.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
    const devLoopback = env.NODE_ENV !== 'production' && (address === '::1' || address.startsWith('127.'));
    return !isPublicMcpAddress(address) && !(allowPrivate && privateExceptions.check(address, family === 4 ? 'ipv4' : 'ipv6')) && !devLoopback;
  })) throw denied();
  return addresses[0];
}

/** Pin the checked DNS result to the actual socket. Never follow redirects or forward JWT to another origin. */
export async function mcpSecureFetch(configuredUrl: string, raw: string | URL, init?: RequestInit): Promise<Response> {
  const configured = validateMcpUrl(configuredUrl);
  const url = validateMcpUrl(String(raw));
  if (url.origin !== configured.origin) throw denied();
  const target = await resolveMcpAddress(url);
  const request = new Request(url, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      // A custom lookup returns only the address that was checked above (no DNS rebinding window).
      lookup: (_host, options, callback) => options.all
        ? callback(null, [target])
        : callback(null, target.address, target.family),
      agent: false,
    }, (res) => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(denied());
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(status);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
