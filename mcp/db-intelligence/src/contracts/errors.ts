/** 錯誤碼與錯誤格式（規格書 5.2）。訊息給使用者看，不帶 SQL、資料表內部名稱以外的細節或 DB 錯誤原文。 */

export const ERROR_CODES = {
  AUTH_REQUIRED: { message: '需要使用者身分才能查詢資料', retryable: false },
  QUERY_PLAN_INVALID: { message: '查詢計畫格式不正確', retryable: true },
  QUERY_DATA_SOURCE_DENIED: { message: '無法存取此資料來源', retryable: false },
  CATALOG_NOT_PUBLISHED: { message: '此資料來源尚未發布可查詢的 Metadata', retryable: false },
  QUERY_DATASET_NOT_FOUND: { message: '找不到可查詢的資料集', retryable: true },
  QUERY_FIELD_NOT_ALLOWED: { message: '查詢使用了不存在或未開放的欄位', retryable: true },
  QUERY_METRIC_UNDEFINED: { message: '此計算欄位尚未由管理員定義', retryable: false },
  QUERY_JOIN_NOT_ALLOWED: { message: '資料集之間沒有已核准的關聯', retryable: true },
  QUERY_OPERATION_NOT_ALLOWED: { message: '查詢使用了不支援的運算方式', retryable: true },
  QUERY_POLICY_DENIED: { message: '此查詢超出可存取資料範圍', retryable: false },
  QUERY_TIMEOUT: { message: '查詢逾時，請縮小查詢範圍', retryable: true },
  QUERY_EXECUTION_FAILED: { message: '查詢執行失敗', retryable: true },
  QUERY_RESULT_NOT_FOUND: { message: '查詢結果不存在或已過期', retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class DbiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ErrorCode,
    /** 給使用者／模型看的補充說明（不含敏感細節） */
    readonly detail?: string,
  ) {
    super(detail ? `${ERROR_CODES[code].message}：${detail}` : ERROR_CODES[code].message);
    this.name = 'DbiError';
    this.retryable = ERROR_CODES[code].retryable;
  }
}

export interface ErrorBody {
  request_id: string;
  error: { code: ErrorCode; message: string; retryable: boolean };
}

export function errorBody(requestId: string, err: DbiError): ErrorBody {
  return { request_id: requestId, error: { code: err.code, message: err.message, retryable: err.retryable } };
}
