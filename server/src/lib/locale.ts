/**
 * 對話語系工具：把前端傳來的語言碼正規化，並產生給 LLM 的「回覆語言」系統指示。
 * 目前支援英文與繁體中文；未帶或未知語言一律回退繁中（向後相容）。
 */
export type ReplyLocale = 'en' | 'zh-TW';

/** 前端語言碼（如 'en' / 'zh-Hant'）→ 內部回覆語系。 */
export function normalizeLocale(lang?: string): ReplyLocale {
  return lang && /^en/i.test(lang) ? 'en' : 'zh-TW';
}

/** 依 locale 產生 system prompt 用的「回覆語言」指示句。 */
export function languageDirective(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'Respond entirely in English.'
    : '全程使用繁體中文。';
}
