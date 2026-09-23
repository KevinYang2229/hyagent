/**
 * Identity Assertion 錯誤型別與錯誤碼。
 *
 * 對應規格：《HyAgentSDK規格.md》§9 錯誤碼、§7.5 錯誤回應格式。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-errors.mjs`。
 *
 * 與 AppError 的分工：AppError 是本系統通用的業務錯誤；HyAgentTokenError 帶的是
 * 規格定義的錯誤碼與 HTTP 狀態，由換發端點在最外層轉成 §7.5 的回應格式。
 *
 * 規格 §9 已定稿：正式環境**保留細分代碼**，不收斂為單一 INVALID_ASSERTION——
 * 本協定不驗證 sub 是否存在，沒有帳號枚舉風險，而細分代碼是整合期唯一的診斷依據。
 * 代價是必須嚴守洩漏邊界：回應只帶 error 代碼、固定說明文字與 requestId，
 * 不得帶 Assertion 原文、金鑰內容、claims 值或內部堆疊。
 */

/** 規格 §9 的驗證錯誤碼（換發端點會回給客戶端）。 */
export const ERROR_CODES = Object.freeze({
  MALFORMED_TOKEN: 'MALFORMED_TOKEN',
  INVALID_ALGORITHM: 'INVALID_ALGORITHM',
  UNKNOWN_KID: 'UNKNOWN_KID',
  KEY_REVOKED: 'KEY_REVOKED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_ISSUER: 'INVALID_ISSUER',
  INVALID_AUDIENCE: 'INVALID_AUDIENCE',
  INVALID_CLAIMS: 'INVALID_CLAIMS',
  TOKEN_NOT_ACTIVE: 'TOKEN_NOT_ACTIVE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REPLAYED: 'TOKEN_REPLAYED',
  ASSERTION_TOO_LARGE: 'ASSERTION_TOO_LARGE',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_DISABLED: 'TENANT_DISABLED',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  RATE_LIMITED: 'RATE_LIMITED',

  // 管理端操作（規格 §7.3、§7.4）。公鑰管理 UI 落地時使用，不會出現在換發流程。
  KEY_LIMIT_EXCEEDED: 'KEY_LIMIT_EXCEEDED',
  LAST_ACTIVE_KEY: 'LAST_ACTIVE_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
} as const);

export type AssertionErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * 錯誤碼對應的 HTTP 狀態（規格 §9）。
 *
 * 步驟 1–20 的驗證失敗一律 401——不得讓狀態碼洩漏「是簽章錯還是 claims 錯」。
 * 大小（413）、Tenant 狀態（404 / 403）、Origin（403）、速率（429）與管理端（400 / 409）例外。
 */
export const HTTP_STATUS: Readonly<Record<AssertionErrorCode, number>> = Object.freeze({
  [ERROR_CODES.MALFORMED_TOKEN]: 401,
  [ERROR_CODES.INVALID_ALGORITHM]: 401,
  [ERROR_CODES.UNKNOWN_KID]: 401,
  [ERROR_CODES.KEY_REVOKED]: 401,
  [ERROR_CODES.INVALID_SIGNATURE]: 401,
  [ERROR_CODES.INVALID_ISSUER]: 401,
  [ERROR_CODES.INVALID_AUDIENCE]: 401,
  [ERROR_CODES.INVALID_CLAIMS]: 401,
  [ERROR_CODES.TOKEN_NOT_ACTIVE]: 401,
  [ERROR_CODES.TOKEN_EXPIRED]: 401,
  [ERROR_CODES.TOKEN_REPLAYED]: 401,
  [ERROR_CODES.ASSERTION_TOO_LARGE]: 413,
  [ERROR_CODES.TENANT_NOT_FOUND]: 404,
  [ERROR_CODES.TENANT_DISABLED]: 403,
  [ERROR_CODES.ORIGIN_NOT_ALLOWED]: 403,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.KEY_LIMIT_EXCEEDED]: 409,
  [ERROR_CODES.LAST_ACTIVE_KEY]: 409,
  [ERROR_CODES.INVALID_REQUEST]: 400,
});

/** Assertion 格式或安全驗證失敗。 */
export class HyAgentTokenError extends Error {
  public readonly code: AssertionErrorCode;
  public readonly httpStatus: number;

  constructor(code: AssertionErrorCode, message: string) {
    super(message);
    this.name = 'HyAgentTokenError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] ?? 401;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** 丟出 HyAgentTokenError 的簡寫。回傳型別為 never，呼叫後 TS 視為流程中止。 */
export function fail(code: AssertionErrorCode, message: string): never {
  throw new HyAgentTokenError(code, message);
}

export interface AssertionErrorResponse {
  status: number;
  body: { error: string; message: string; requestId?: string };
}

/**
 * 轉成規格 §7.5 的錯誤回應格式。
 *
 * message 是該代碼的固定說明文字，只給整合者的人看，客戶端程式必須以 error 判斷。
 * 非預期的錯誤一律收斂為 500 / INTERNAL_ERROR，不讓內部堆疊外流。
 */
export function toErrorResponse(error: unknown, requestId?: string): AssertionErrorResponse {
  const known = error instanceof HyAgentTokenError;
  return {
    status: known ? error.httpStatus : 500,
    body: {
      error: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '內部錯誤',
      requestId,
    },
  };
}
