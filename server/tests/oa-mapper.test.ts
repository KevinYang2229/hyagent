/**
 * oa.mapper 單元測試：`oa.schema.json` 契約的可執行版本。
 *
 * 這兩個純函式是「表單值 → 真 OA body」與「OA 回應 → 本系統結果」的唯一映射點，
 * http 與 stub 連接器共用。串接真 OA 時改的是各表單的 oa.schema.json，不是這裡；
 * 但這裡的行為（allowlist / undefined 不帶 / statusMap fallback）決定了 schema 怎麼寫，
 * 所以任何改動都要先在本檔補 case。詳見 docs/HANDOFF-OA-HTTP.md。
 */
import type { OARequestMapping, OAResponseMapping } from '@hyagent/shared';
import { buildOABody, parseOAResponse } from '@/lib/oa/oa.mapper';

describe('buildOABody（表單值 → OA request body）', () => {
  it('依 fieldMap 重新命名欄位', () => {
    const req: OARequestMapping = { fieldMap: { userId: 'EmployeeNo', leaveType: 'LeaveTypeCode' } };
    expect(buildOABody(req, { userId: 'kevin', leaveType: 'annual' })).toEqual({
      EmployeeNo: 'kevin',
      LeaveTypeCode: 'annual',
    });
  });

  it('fieldMap 同時是 allowlist：未列出的來源欄位不送出', () => {
    const req: OARequestMapping = { fieldMap: { userId: 'userId' } };
    const body = buildOABody(req, { userId: 'kevin', internalNote: '不該外流', salary: 99999 });
    expect(body).toEqual({ userId: 'kevin' });
    expect(body).not.toHaveProperty('internalNote');
    expect(body).not.toHaveProperty('salary');
  });

  it('值為 undefined 的欄位整個不帶（key 不存在，而非送 null）', () => {
    const req: OARequestMapping = { fieldMap: { userId: 'userId', deputy: 'Deputy' } };
    const body = buildOABody(req, { userId: 'kevin', deputy: undefined });
    expect(body).toEqual({ userId: 'kevin' });
    expect('Deputy' in body).toBe(false);
  });

  it('值為 null 則照送——只有 undefined 會被略過', () => {
    const req: OARequestMapping = { fieldMap: { deputy: 'Deputy' } };
    expect(buildOABody(req, { deputy: null })).toEqual({ Deputy: null });
  });

  it('false / 0 / 空字串照送（不可被當成「沒填」略過）', () => {
    const req: OARequestMapping = { fieldMap: { agree: 'Agree', fee: 'Fee', note: 'Note' } };
    expect(buildOABody(req, { agree: false, fee: 0, note: '' })).toEqual({
      Agree: false,
      Fee: 0,
      Note: '',
    });
  });

  it('constants 直接併入 body', () => {
    const req: OARequestMapping = { fieldMap: { userId: 'userId' }, constants: { FormType: 'LEAVE' } };
    expect(buildOABody(req, { userId: 'kevin' })).toEqual({ userId: 'kevin', FormType: 'LEAVE' });
  });

  it('constants 後套用：鍵相同時覆蓋 fieldMap 的結果', () => {
    const req: OARequestMapping = { fieldMap: { source: 'Channel' }, constants: { Channel: 'AGENT' } };
    expect(buildOABody(req, { source: '使用者填的值' })).toEqual({ Channel: 'AGENT' });
  });

  it('來源缺少 fieldMap 列出的欄位時不報錯，只是不帶該欄', () => {
    const req: OARequestMapping = { fieldMap: { userId: 'userId', hours: 'Hours' } };
    expect(buildOABody(req, { userId: 'kevin' })).toEqual({ userId: 'kevin' });
  });

  it('空 fieldMap 得到空 body（不會意外把整包 source 送出去）', () => {
    expect(buildOABody({ fieldMap: {} }, { userId: 'kevin', secret: 'x' })).toEqual({});
  });
});

describe('parseOAResponse（OA 回應 → OASubmitResult）', () => {
  const resp: OAResponseMapping = {
    idField: 'requestId',
    statusField: 'status',
    statusMap: { OK: 'accepted', WAIT: 'pending', NG: 'rejected' },
  };

  it('依 idField 取單號、依 statusMap 轉狀態', () => {
    expect(parseOAResponse(resp, { requestId: 'OA-000001', status: 'OK' })).toMatchObject({
      oaRequestId: 'OA-000001',
      status: 'accepted',
    });
  });

  it('idField 取不到時 fallback 到 raw.id', () => {
    expect(parseOAResponse(resp, { id: 'OA-fallback', status: 'OK' }).oaRequestId).toBe('OA-fallback');
  });

  it('單號為數字時轉成字串', () => {
    expect(parseOAResponse(resp, { requestId: 12345, status: 'OK' }).oaRequestId).toBe('12345');
  });

  it('完全取不到單號 → 丟錯（不可讓使用者拿到空單號的「成功」）', () => {
    expect(() => parseOAResponse(resp, { status: 'OK' })).toThrow(/missing request id/i);
    expect(() => parseOAResponse(resp, { requestId: null, status: 'OK' })).toThrow(/missing request id/i);
  });

  it('statusField 省略時預設讀 raw.status', () => {
    const r: OAResponseMapping = { idField: 'requestId', statusMap: { OK: 'accepted' } };
    expect(parseOAResponse(r, { requestId: 'X', status: 'OK' }).status).toBe('accepted');
  });

  it('statusMap 未命中一律 fallback pending —— OA 回了預期外的狀態不會報錯，只會安靜變成「待處理」', () => {
    expect(parseOAResponse(resp, { requestId: 'X', status: 'SOMETHING_NEW' }).status).toBe('pending');
  });

  it('沒有 statusMap 時一律 pending', () => {
    const r: OAResponseMapping = { idField: 'requestId' };
    expect(parseOAResponse(r, { requestId: 'X', status: 'accepted' }).status).toBe('pending');
  });

  it('狀態欄位缺漏也走 fallback，不丟錯', () => {
    expect(parseOAResponse(resp, { requestId: 'X' }).status).toBe('pending');
  });

  it('原始回應原樣掛在 raw（除錯用，不做裁切）', () => {
    const raw = { requestId: 'X', status: 'OK', extra: { nested: true } };
    expect(parseOAResponse(resp, raw).raw).toEqual(raw);
  });
});
