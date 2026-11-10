/**
 * 知識庫表格的疑似個資欄位提示。
 *
 * 知識庫只有檔案層權限，沒有欄位層保護：含個資的 Excel 一旦匯入，整張表對有權限的人全部可見。
 * 這裡只做「提醒」——匯入照常完成，後台檔案清單標示，讓管理者決定要標嚴格的標籤，
 * 或改走 db-intelligence（有欄位分級與遮罩）。
 */
import { detectPiiHeaders } from '@/modules/knowledge/pii-headers';

describe('detectPiiHeaders', () => {
  it('中文標題以關鍵字比對', () => {
    expect(detectPiiHeaders([{ headers: ['員工編號', '姓名', '身分證字號', '手機', '部門'] }])).toEqual(['姓名', '身分證字號', '手機']);
  });

  it('英文標題以分詞比對，不會因為子字串誤判', () => {
    expect(detectPiiHeaders([{ headers: ['Employee Name', 'E-mail', 'Mobile Phone', 'Department', 'Nameplate'] }])).toEqual([
      'Employee Name',
      'E-mail',
      'Mobile Phone',
    ]);
  });

  it('沒有疑似欄位回空陣列；多張表合併去重並保留出現順序', () => {
    expect(detectPiiHeaders([{ headers: ['年資', '天數'] }])).toEqual([]);
    expect(detectPiiHeaders([{ headers: ['姓名', '薪資'] }, { headers: ['姓名', '地址'] }])).toEqual(['姓名', '薪資', '地址']);
  });

  it('單獨的「名稱」「帳號」不算（可能是專案名稱、系統登入帳號），銀行帳號才算', () => {
    expect(detectPiiHeaders([{ headers: ['專案名稱', '系統帳號', '銀行帳號'] }])).toEqual(['銀行帳號']);
  });

  it('數量有上限，避免超寬表把 meta 撐大', () => {
    const headers = Array.from({ length: 30 }, (_, i) => `電話${i}`);
    expect(detectPiiHeaders([{ headers }])).toHaveLength(10);
  });
});
