/**
 * 開場知識庫推薦 chip 的文字來源決策。
 *
 * 唯一來源是後端依租戶索引內容生成的問句：沒有生成句就不顯示 chip。
 * 先前這裡有一組 i18n 寫死的後備句（「公司有哪些產品或服務？」等），已移除——
 * 那種換成任何組織都成立的泛問，在未建索引時只會引導使用者問出答不出來的問題，
 * 比沒有 chip 更差；而且它連知識庫服務關閉時都還在（見 widget.controller 的權限判斷）。
 *
 * 抽成純函式而非寫在 App.tsx：這段的分支（停用／有生成句／未知語系）值得獨立測試，
 * 而 App 元件本身太肥、渲染成本高，不適合當測試入口。
 */

/** 後端依索引內容生成的推薦問句（server KnowledgeIndexMeta.suggestedPrompts 的鏡像） */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}

export function pickKnowledgePrompts(opts: {
  knowledgeEnabled: boolean;
  language: string;
  /** 後端依各來源索引生成的問句（預設網站、檔案各一筆，後接自訂提示詞） */
  suggested?: SuggestedPrompts[];
}): string[] {
  if (!opts.knowledgeEnabled || !opts.suggested) return [];
  // 查表 miss（未知語系）與手動留空的語系一併濾掉
  return opts.suggested
    .map((s) => s[opts.language as keyof SuggestedPrompts])
    .filter((text): text is string => !!text);
}

/** 一份「知識庫開場資料」：開關與句子恆為同一次判定的結果，不得各自來源 */
export interface KnowledgeFeed {
  knowledgeEnabled: boolean;
  suggested?: SuggestedPrompts[];
}

/**
 * 訪客那份與登入者那份的取捨：登入後一律以本人權限判定的結果為準。
 *
 * 免登入的 /widget/config 只能用訪客部門（'—'）判斷開關，管理者把知識庫指派給某個部門時，
 * 該部門成員問得到答案、chip 卻不出現。登入後改用 /api/knowledge/suggested-prompts 覆蓋。
 *
 * 刻意整份覆蓋而非只覆蓋 knowledgeEnabled：開關與句子必須是同一次判定的結果，
 * 混用兩邊會出現「開關說開、句子是另一份判定留下的」這種對不起來的狀態。
 * 覆蓋是雙向的——本人沒有權限時同樣要關掉訪客那份，否則反而成了越權顯示。
 * member 為 null（未登入／登出／尚未取得）時回訪客那份，不殘留上一位登入者的結果。
 */
export function resolveKnowledgeFeed(guest: KnowledgeFeed, member: KnowledgeFeed | null): KnowledgeFeed {
  return member ?? guest;
}
