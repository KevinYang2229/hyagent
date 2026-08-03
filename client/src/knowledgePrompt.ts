/**
 * 開場知識庫推薦 chip 的文字來源決策。
 *
 * 抽成純函式而非寫在 App.tsx：這段的分支（停用／有生成句／未知語系／回落）
 * 值得獨立測試，而 App 元件本身太肥、渲染成本高，不適合當測試入口。
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
  /** i18n 的寫死句；生成句不可用時的後備 */
  fallback: string[];
}): string[] {
  if (!opts.knowledgeEnabled) return [];
  // 查表 miss（未知語系）與生成失敗走同一條路：回落 fallback
  const generated = opts.suggested?.[opts.language as keyof SuggestedPrompts];
  return generated ? [generated] : opts.fallback;
}
