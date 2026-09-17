import type { KnowledgeSource } from './knowledge.store';

// 不屬於可建立的標籤 ID，僅由網站來源設定產生，不可指派給檔案或共用授權。
export const WEBSITE_ACCESS_SCOPE = 'kb:__website_access';
export function sourceVisibilityScopes(source: Pick<KnowledgeSource, 'audience' | 'visibilityScopes'>): string[] {
  if (!source.audience || source.audience.mode === 'labels') return source.visibilityScopes ?? [];
  return source.audience.mode === 'disabled' ? [] : [WEBSITE_ACCESS_SCOPE];
}
