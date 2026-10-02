import { describe, expect, it } from 'vitest';
import { emptyMcpForm, parseKeywords, statusLabel, toPayload, validateMcpForm } from './mcpForm.util';

describe('mcpForm.util', () => {
  it('parseKeywords：逗號、頓號、換行分隔，去空白與重複', () => {
    expect(parseKeywords('會議室, 預約、空檔\n會議室,, ')).toEqual(['會議室', '預約', '空檔']);
  });

  it('validateMcpForm：新增時檢查 serverId，URL 必須 http(s)，逾時 1–120 秒', () => {
    const ok = { ...emptyMcpForm(), id: 'rooms', name: '會議室', url: 'http://localhost:4100/mcp' };
    expect(validateMcpForm(ok, true)).toEqual([]);
    expect(validateMcpForm({ ...ok, id: 'Rooms_1' }, true)).toContain('serverId 只允許小寫英數與連字號（1–32 字）');
    expect(validateMcpForm({ ...ok, id: 'Rooms_1' }, false)).toEqual([]);
    expect(validateMcpForm({ ...ok, name: ' ' }, true)).toContain('請填寫名稱');
    expect(validateMcpForm({ ...ok, url: 'ftp://x' }, true)).toContain('URL 必須以 http:// 或 https:// 開頭');
    expect(validateMcpForm({ ...ok, timeoutSeconds: '0' }, true)).toContain('逾時須為 1–120 秒');
  });

  it('toPayload：空擁有租戶轉 null、秒轉毫秒、關鍵字轉陣列', () => {
    const p = toPayload({ ...emptyMcpForm(), id: 'rooms', name: '會議室', url: 'http://x/mcp', keywords: '會議室、預約', timeoutSeconds: '30' });
    expect(p).toEqual({
      name: '會議室', url: 'http://x/mcp', ownerTenantId: null, description: '', keywords: ['會議室', '預約'], timeoutMs: 30000, enabled: true,
    });
  });

  it('statusLabel', () => {
    expect(statusLabel('ok')).toBe('正常');
    expect(statusLabel('unreachable')).toBe('連不上');
    expect(statusLabel('auth_failed')).toBe('驗證失敗');
    expect(statusLabel('idle')).toBe('尚未連線');
  });
});
