/**
 * HttpOAConnector：把表單送進真 OA 系統的 HTTP 連接器。
 *
 * 與 stub 共用同一份 OAConnector 介面，靠 OA_CONNECTOR=http 切換、
 * OA_BASE_URL / OA_API_KEY 設定。送出守門、驗證、簽核計算等上層邏輯一律不動。
 *
 * 端點、送出欄位映射、回應解析全由各表單的 oa.schema.json 驅動（見 oa.mapper）。
 * 真 OA 規格到位後只需改 schemas/<formId>/oa.schema.json，不必動本檔。
 */
import { querySignal, throwIfQueryCancelled } from '@/lib/query-cancellation';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { buildOABody, parseOAResponse } from './oa.mapper';
import type { LeaveBalance, OAConnector, OASubmitInput, OASubmitResult } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

/** 剩餘額度查詢端點（非表單，不由 oa.schema 驅動） */
const LEAVE_BALANCE_PATH = '/api/leave-balances';

/** OA_BASE_URL 必填（由 env superRefine 在 boot 時保證），此處去尾斜線 */
function baseUrl(): string {
  if (!env.OA_BASE_URL) {
    throw AppError.internal('OA_BASE_URL is required when OA_CONNECTOR=http');
  }
  return env.OA_BASE_URL.replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
  return env.OA_API_KEY ? { authorization: `Bearer ${env.OA_API_KEY}` } : {};
}

export const httpOAConnector: OAConnector = {
  name: 'http',

  async submitForm({ formId, oa, source }: OASubmitInput): Promise<OASubmitResult> {
    const body = buildOABody(oa.request, source);
    const url = `${baseUrl()}${oa.endpoint}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: oa.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      logger.error({ err, url, formId }, '[oa:http] request failed (network/timeout)');
      throw AppError.internal('OA system request failed');
    }

    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      logger.error({ url, formId, status: res.status, raw }, '[oa:http] non-2xx from OA');
      throw AppError.internal(`OA system rejected request (HTTP ${res.status})`);
    }
    const result = parseOAResponse(oa.response, raw);
    logger.info({ url, formId, oaRequestId: result.oaRequestId }, '[oa:http] form submitted');
    return result;
  },

  async getLeaveBalance(userId: string): Promise<LeaveBalance[]> {
    throwIfQueryCancelled();
    const url = `${baseUrl()}${LEAVE_BALANCE_PATH}?userId=${encodeURIComponent(userId)}`;
    try {
      const res = await fetch(url, {
        headers: authHeaders(),
        signal: querySignal() ? AbortSignal.any([querySignal()!, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as LeaveBalance[];
    } catch (err) {
      throwIfQueryCancelled();
      // 降級：查不到額度不應阻斷對話，回空陣列（畫面則不顯示剩餘時數）
      logger.error({ err, url }, '[oa:http] getLeaveBalance failed; degrading to empty');
      return [];
    }
  },
};
