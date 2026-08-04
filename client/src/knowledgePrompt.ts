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
  suggested?: SuggestedPrompts;
}): string[] {
  if (!opts.knowledgeEnabled) return [];
  // 查表 miss（未知語系）與未生成走同一條路：不顯示
  const generated = opts.suggested?.[opts.language as keyof SuggestedPrompts];
  return generated ? [generated] : [];
}
