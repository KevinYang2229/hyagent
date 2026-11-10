/**
 * 知識庫表格的疑似個資欄位偵測（只看表頭，不看資料內容）。
 *
 * 知識庫的權限只到檔案層：含個資的 Excel 一旦匯入，整張表對有權限的人全部可見，
 * 沒有 db-intelligence 那種欄位分級與遮罩。這裡只負責「提醒」：結果寫進檔案 meta，
 * 後台檔案清單據此標示，匯入流程不受影響。
 *
 * 判斷規則與 mcp/db-intelligence/src/catalog/sensitivity.ts 的方向一致（兩邊各自維護，
 * 那邊比對的是資料庫欄位名稱，這邊是人寫的表頭，形狀不同）。
 */

/** 中文表頭：子字串比對。不收單獨的「名稱」「帳號」——常是專案名稱、系統登入帳號 */
const ZH = /身分證|身份證|統一證號|居留證|護照|生日|出生|薪資|薪水|月薪|年薪|獎金|銀行帳|存摺|信用卡|密碼|地址|住址|戶籍|血型|病歷|姓名|電話|手機|信箱|電子郵件|性別|婚姻|緊急聯絡/;

/** 英文表頭：切成詞再比對，避免 Nameplate、Telemetry 這類子字串誤判 */
const EN_WORDS = new Set([
  'ssn', 'passport', 'birthday', 'birthdate', 'dob', 'salary', 'wage', 'bonus', 'iban',
  'password', 'address', 'email', 'mail', 'phone', 'mobile', 'tel', 'gender', 'marital',
]);
/** 需要兩個詞一起出現才算的組合（單獨的 name、id、card 太常見） */
const EN_PAIRS: [string, string][] = [
  ['id', 'no'], ['id', 'number'], ['id', 'card'], ['national', 'id'], ['credit', 'card'], ['bank', 'account'],
  ['full', 'name'], ['first', 'name'], ['last', 'name'], ['employee', 'name'], ['customer', 'name'], ['contact', 'name'],
];

const MAX_HEADERS = 10;

function isPiiHeader(header: string): boolean {
  if (ZH.test(header)) return true;
  // e-mail → email；EmployeeName → employee name
  const words = header
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/e-mail/g, 'email')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => EN_WORDS.has(w))) return true;
  const set = new Set(words);
  return EN_PAIRS.some(([a, b]) => set.has(a) && set.has(b));
}

/** 回傳命中的表頭（去重、保留出現順序、最多 MAX_HEADERS 個）；沒有命中回空陣列 */
export function detectPiiHeaders(tables: readonly { headers: readonly string[] }[]): string[] {
  const out: string[] = [];
  for (const t of tables) {
    for (const raw of t.headers) {
      const h = String(raw ?? '').trim();
      if (!h || out.includes(h) || !isPiiHeader(h)) continue;
      out.push(h);
      if (out.length >= MAX_HEADERS) return out;
    }
  }
  return out;
}
