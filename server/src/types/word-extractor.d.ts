/**
 * word-extractor / turndown-plugin-gfm 皆未附型別，於此補宣告。
 * 只宣告本專案實際用到的成員，避免維護整份 API 介面。
 */
declare module 'word-extractor' {
  class WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }
  class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
  export = WordExtractor;
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
