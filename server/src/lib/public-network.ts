/**
 * 租戶管理者設定的對外目標（知識庫網站爬取、webhook 端點）只允許連到公開網段，避免 SSRF：
 * 外部客戶不能藉此讓伺服器去打 127.0.0.1、內網或雲端 metadata（169.254.169.254）。
 *
 * - assertPublicUrl：寫入設定時檢查，不合格回 422。
 * - publicOnlyFetch：實際連線時再解析一次 DNS 並把 socket 釘在檢查過的位址（防 DNS rebinding），
 *   每一跳轉都重新檢查（webhook 不跟隨跳轉）。
 *
 * 位址判斷沿用 MCP 的 isPublicMcpAddress；與 MCP 不同，這裡沒有開發環境 loopback 或私有網段的例外。
 * 超級管理者設定的目標不經過這層（行為不變）。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicMcpAddress, pinnedFetch } from '@/modules/mcp/mcp.network';
import { AppError } from '@/utils/app-error';

export const BLOCKED_DESTINATION_MESSAGE =
  '目標網址指向內部或保留網段（例如 127.0.0.1、內網位址或 169.254.169.254），不允許使用；請改用可公開連線的網址';

function blocked(): AppError {
  return AppError.unprocessable(BLOCKED_DESTINATION_MESSAGE);
}

function parseHttpUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw AppError.unprocessable('網址格式不正確');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw AppError.unprocessable('網址只能使用 http 或 https');
  if (url.username || url.password) throw AppError.unprocessable('網址不可包含帳號密碼');
  return url;
}

/** 解析主機名稱；任何一個位址不是公開網段就拒絕（混合公開／內網的 DNS 結果也拒絕） */
async function resolvePublicAddress(url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw AppError.unprocessable(`無法解析主機名稱：${host}`);
    }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicMcpAddress(address))) throw blocked();
  return addresses[0];
}

/** 寫入時檢查：網址必須是 http(s)、且主機只解析到公開網段。回傳解析後的 URL */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  const url = parseHttpUrl(raw);
  await resolvePublicAddress(url);
  return url;
}

const MAX_REDIRECTS = 5;

/**
 * 只連公開網段的 fetch。每一跳都重新解析並檢查，socket 釘在檢查過的位址。
 * maxRedirects 為 0 時遇到跳轉直接拒絕（webhook）；回傳的 Response 不含 url 屬性，呼叫端不應依賴它。
 */
export async function publicOnlyFetch(
  raw: string | URL,
  init?: RequestInit,
  options: { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let url = parseHttpUrl(raw);
  for (let hop = 0; ; hop += 1) {
    const target = await resolvePublicAddress(url);
    const res = await pinnedFetch(
      url,
      target,
      init,
      maxRedirects === 0 ? () => AppError.unprocessable('目標網址回應跳轉，基於安全不跟隨') : undefined,
    );
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location || hop >= maxRedirects) throw AppError.unprocessable('目標網址跳轉次數過多或缺少跳轉目的地');
    url = parseHttpUrl(new URL(location, url));
  }
}
