/**
 * 推薦問句格位的型別與純函式。
 *
 * 刻意不 import knowledge.store：store 需要這裡的正規化函式（runtime import），
 * 反向再 import 會形成循環。型別定義因此放這裡，由 store re-export 供既有呼叫端沿用。
 */
import type { IndexedChunk } from './knowledge-index.types';

/** widget 開場推薦問句；兩語系一組，空字串代表該語系不顯示 */
export interface SuggestedPrompts {
  'zh-Hant': string;
  en: string;
}

/** 單一來源的推薦問句格位；manual 有值即為鎖定，自動生成不覆蓋 */
export interface PromptSlot {
  generated?: SuggestedPrompts;
  manual?: SuggestedPrompts;
}

export type SourceKey = 'website' | 'file';

/** 管理者額外新增的開場提示詞，與兩個預設來源格位分開保存。 */
export interface CustomSuggestedPrompt {
  id: string;
  source: SourceKey;
  text: SuggestedPrompts;
}

/** 顯示與處理順序固定：網站在前、檔案在後 */
export const SOURCE_KEYS: readonly SourceKey[] = ['website', 'file'];

export type SuggestedPromptSlots = Partial<Record<SourceKey, PromptSlot>>;

/** 依 chunk 有無 fileId 切分來源（檔案來源的 chunk 帶 fileId，爬網的沒有） */
export function splitChunksBySource<T extends { fileId?: string }>(
  chunks: T[],
): Record<SourceKey, T[]> {
  const out: Record<SourceKey, T[]> = { website: [], file: [] };
  for (const c of chunks) out[c.fileId ? 'file' : 'website'].push(c);
  return out;
}

/** 舊格式（單一 SuggestedPrompts）判定：有 zh-Hant 字串屬性 */
function isLegacy(value: object): value is SuggestedPrompts {
  return typeof (value as Record<string, unknown>)['zh-Hant'] === 'string';
}

/**
 * 讀取時就地正規化舊資料，不需開機遷移。
 * 舊的單句歸給哪一格：租戶有設爬取起點就算網站來源，否則算檔案來源。
 */
export function normalizeSuggestedPrompts(
  value: unknown,
  opts: { hasStartUrl: boolean },
): SuggestedPromptSlots | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (isLegacy(value)) {
    return opts.hasStartUrl ? { website: { generated: value } } : { file: { generated: value } };
  }
  const slots = value as SuggestedPromptSlots;
  return SOURCE_KEYS.some((k) => slots[k]) ? slots : undefined;
}

/** 依來源計算 chunk 數，供 meta.chunkCountBySource 使用 */
export function countBySource(chunks: IndexedChunk[]): Record<SourceKey, number> {
  const split = splitChunksBySource(chunks);
  return { website: split.website.length, file: split.file.length };
}

/**
 * 挑出要給 widget 的句子（有效句 = manual ?? generated）。
 * counts 為各來源的 chunk 數：為 0 的來源一律不輸出，避免手動句指向已刪內容。
 */
export function effectivePrompts(
  slots: SuggestedPromptSlots | undefined,
  counts: Record<SourceKey, number>,
): SuggestedPrompts[] {
  if (!slots) return [];
  const out: SuggestedPrompts[] = [];
  for (const key of SOURCE_KEYS) {
    if (counts[key] <= 0) continue;
    const prompt = slots[key]?.manual ?? slots[key]?.generated;
    if (prompt) out.push(prompt);
  }
  return out;
}
