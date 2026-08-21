/**
 * OA 映射（純函式，無 I/O）：由 oa.schema.json 驅動。
 *
 * - buildOABody：來源欄位（表單值 + 衍生 context）→ OA request body
 * - parseOAResponse：OA 原始回應 → 上層用的 OASubmitResult
 *
 * http 與 stub 連接器共用；OA 真欄位名／狀態值改動時只改 oa.schema.json。
 */
import type { OARequestMapping, OAResponseMapping } from '@hyagent/shared';
import { AppError } from '@/utils/app-error';
import type { OASubmitResult } from './types';

/**
 * 依 request.fieldMap 把來源欄位重新命名／挑選成 OA body。
 * fieldMap 同時是 allowlist：只有列出的欄位會送出；值為 undefined 不帶。
 * constants 直接併入。
 */
export function buildOABody(
  req: OARequestMapping,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [srcKey, oaKey] of Object.entries(req.fieldMap)) {
    const value = source[srcKey];
    if (value !== undefined) body[oaKey] = value;
  }
  if (req.constants) Object.assign(body, req.constants);
  return body;
}

/**
 * 依 response 映射自原始回應收斂出 id 與狀態。
 * id 取 resp.idField，缺則 fallback `id`；status 經 statusMap 轉換，未命中 fallback `pending`。
 */
export function parseOAResponse(
  resp: OAResponseMapping,
  raw: Record<string, unknown>,
): OASubmitResult {
  const oaRequestId = raw[resp.idField] ?? raw.id;
  if (oaRequestId === undefined || oaRequestId === null) {
    throw AppError.internal('OA response missing request id');
  }
  const statusKey = String(raw[resp.statusField ?? 'status']);
  const status = resp.statusMap?.[statusKey] ?? 'pending';
  return { oaRequestId: String(oaRequestId), status, raw };
}
