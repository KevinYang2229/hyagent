import { describe, expect, it } from 'vitest';
import { errorMessage } from './api';

describe('errorMessage：後端兩種錯誤形狀都要取得出訊息', () => {
  it('一般管理 API：{ error: { code, message } }', () => {
    expect(errorMessage({ error: { message: '租戶不存在' } }, 404)).toBe('租戶不存在');
  });

  it('Assertion 公鑰端點（規格 §7.5）：{ error: "CODE", message }——回歸：曾只顯示 HTTP 400', () => {
    expect(
      errorMessage({ error: 'INVALID_REQUEST', message: '這是私鑰，不是公鑰。' }, 400),
    ).toBe('這是私鑰，不是公鑰。');
  });

  it('沒有訊息可取時退回狀態碼', () => {
    expect(errorMessage({}, 502)).toBe('HTTP 502');
    expect(errorMessage({ error: 'KEY_LIMIT_EXCEEDED' }, 409)).toBe('HTTP 409');
  });
});
