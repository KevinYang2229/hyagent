/**
 * 新欄位的敏感度預填：依欄位名稱與 DB 註解猜測，只是審核的起點。
 *
 * 用在兩處：掃描（sync 的新欄位，後台「Catalog 審核」畫面看到的預設值）與 CLI 審核檔草稿。
 * 已審過的欄位重掃時保留管理員的設定，不會再經過這裡。
 *
 * 判斷錯誤的方向刻意偏嚴：猜成 internal 會被政策的 columns: ['*'] 涵蓋，管理員大量開放欄位時
 * 容易整欄外流；猜得太嚴只是審核時多調一欄。
 *
 * 不依資料型別判斷：舊系統常把所有字串欄位都開成 text / varchar(255)，以型別猜會讓大多數欄位誤判。
 */
import type { Sensitivity } from '../contracts/catalog';

/** 以底線切開的詞比對（home_addr、job_mobile、apply_remarks 都能命中） */
const token = (words: string) => new RegExp(`(^|_)(${words})(_|$)`);

const RESTRICTED_NAME = token(
  [
    'stn_?id', 'id_?no', 'idno', 'identity', 'national_id', 'ssn', 'passport', 'sfz', 'sfzh', 'id_?card',
    'birthday', 'birth_?date', 'birth',
    'salary', 'wage', 'bonus',
    'bank', 'account_no', 'iban', 'credit_?card(_no)?', 'card_?no',
    'password', 'passwd', 'pwd', 'secret', 'token',
    'blood', 'addr', 'address',
  ].join('|'),
);

const CONFIDENTIAL_NAME = token(
  [
    'e?mail', 'mobile', 'phone', 'tel', 'fax', 'contact', 'sjh', 'lxdh',
    'sex', 'gender', 'married', 'marital', 'degree', 'religion', 'health',
    // 人名：只認帶「人」前綴的組合。單獨的 name 可能是職稱、專案、部門名稱，無法判斷
    '(cn|en|real|full|first|last|nick|emp|employee|user|cust|customer|person|member|staff|patient|owner|applicant)_?(name|nm)', 'xm', 'xingming',
    // 自由文字：使用者常把身分證、電話手打進備註
    'remarks?', 'memos?', 'notes?', 'comments?', 'bz', 'beizhu',
  ].join('|'),
);

/**
 * 註解只比對中文關鍵字。DB 註解是不可信資料（可能被寫入任意內容），英文詞容易因為註解裡提到
 * 別的表名或欄位名而誤判；且註解只能把敏感度調高，不能調低，最壞情況是多擋一欄。
 */
const RESTRICTED_COMMENT = /身分證|身份證|統一證號|居留證|護照|生日|出生|薪資|薪水|月薪|年薪|獎金|銀行|存摺|信用卡|密碼|地址|住址|戶籍|血型|病歷/;
const CONFIDENTIAL_COMMENT = /姓名|名字|電話|手機|信箱|電子郵件|性別|婚姻|學歷|宗教|健康|緊急聯絡|備註/;

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const stricter = (a: Sensitivity, b: Sensitivity): Sensitivity => (RANK[a] >= RANK[b] ? a : b);

function fromName(column: string): Sensitivity {
  const n = column.toLowerCase();
  if (RESTRICTED_NAME.test(n)) return 'restricted';
  if (CONFIDENTIAL_NAME.test(n)) return 'confidential';
  return 'internal';
}

function fromComment(comment: string | null | undefined): Sensitivity {
  if (!comment) return 'internal';
  if (RESTRICTED_COMMENT.test(comment)) return 'restricted';
  if (CONFIDENTIAL_COMMENT.test(comment)) return 'confidential';
  return 'internal';
}

export function guessSensitivity(column: string, comment?: string | null): Sensitivity {
  return stricter(fromName(column), fromComment(comment));
}
