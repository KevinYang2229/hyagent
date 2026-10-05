/** MCP 服務表單：純函式（驗證、轉換），與畫面分離以便測試。 */
import type { McpServerConfig, McpServerStatus } from '../api';

export interface McpServerFormValues {
  id: string;
  name: string;
  url: string;
  /** 空字串＝共用 */
  ownerTenantId: string;
  description: string;
  /** 以逗號、頓號或換行分隔 */
  keywords: string;
  timeoutSeconds: string;
  enabled: boolean;
}

export interface McpServerPayload {
  name: string;
  url: string;
  ownerTenantId: string | null;
  description: string;
  keywords: string[];
  timeoutMs: number;
  enabled: boolean;
}

const SERVER_ID_RE = /^[a-z0-9-]{1,32}$/;

export function emptyMcpForm(): McpServerFormValues {
  return { id: '', name: '', url: '', ownerTenantId: '', description: '', keywords: '', timeoutSeconds: '20', enabled: true };
}

export function toFormValues(c: McpServerConfig): McpServerFormValues {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    ownerTenantId: c.ownerTenantId ?? '',
    description: c.description,
    keywords: c.keywords.join('、'),
    timeoutSeconds: String(Math.round(c.timeoutMs / 1000)),
    enabled: c.enabled,
  };
}

export function parseKeywords(text: string): string[] {
  return [...new Set(text.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean))];
}

export function validateMcpForm(v: McpServerFormValues, isNew: boolean): string[] {
  const errors: string[] = [];
  if (isNew && !SERVER_ID_RE.test(v.id)) errors.push('serverId 只允許小寫英數與連字號（1–32 字）');
  if (!v.name.trim()) errors.push('請填寫名稱');
  if (!/^https?:\/\//.test(v.url.trim())) errors.push('URL 必須以 http:// 或 https:// 開頭');
  const sec = Number(v.timeoutSeconds);
  if (!Number.isInteger(sec) || sec < 1 || sec > 120) errors.push('逾時須為 1–120 秒');
  return errors;
}

export function toPayload(v: McpServerFormValues): McpServerPayload {
  return {
    name: v.name.trim(),
    url: v.url.trim(),
    ownerTenantId: v.ownerTenantId.trim() || null,
    description: v.description.trim(),
    keywords: parseKeywords(v.keywords),
    timeoutMs: Number(v.timeoutSeconds) * 1000,
    enabled: v.enabled,
  };
}

export function statusLabel(state: McpServerStatus['state']): string {
  return { ok: '正常', unreachable: '連不上', auth_failed: '驗證失敗', idle: '尚未連線' }[state];
}
