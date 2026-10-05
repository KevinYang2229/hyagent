/** 帶 HTTP 狀態與後端錯誤碼的 API 錯誤；status 0 代表沒連上（NETWORK／TIMEOUT／NO_SERVER）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '發生錯誤，請稍後再試';
}
