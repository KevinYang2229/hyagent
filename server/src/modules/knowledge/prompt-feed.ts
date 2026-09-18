/**
 * 開場推薦詞的「要送出哪些句子」單一實作。
 *
 * 兩個端點共用（免登入的 GET /api/widget/config 與登入後的
 * GET /api/knowledge/suggested-prompts）：兩邊的**開關**判準本來就不同——前者只能用
 * 訪客判準、後者用該使用者的權限——但「句子集合」必須同一份，否則就是第二次
 * 各自實作同一組外洩守門，遲早分岔。
 *
 * 句子集合恆為訪客可見語料生成的公開集合：
 * - status 必須是 ready 且 chunkCount > 0（索引已刪／爬取失敗時 meta 會殘留舊句，見
 *   knowledge.suggest.ts 的世代防護註解，讀取端必須自行擋）
 * - generated 句要比對 promptAclFingerprint（以訪客可見範圍計算）
 * - 自訂句再過一次「該來源有訪客看得到的內容」
 *
 * 亦即：登入者拿到的句子不會多於訪客。這是方案 A 的刻意取捨——句子本身就是存在性
 * 外洩（見 filterGuestVisibleChunks 註解），要讓部門專屬內容也有專屬推薦詞，必須按
 * 可見範圍分群生成，而不是在這裡放寬過濾。
 */
import { currentChunkScopes, guestVisibilityScopesOf } from './knowledge.visibility';
import { knowledgeStore } from './knowledge.store';
import { effectivePrompts, type SourceKey, type SuggestedPrompts } from './prompt-slots';
import { publicPromptSlots } from './prompt-visibility';

export function publicSuggestedPrompts(tenantId: string): SuggestedPrompts[] {
  const meta = knowledgeStore.getMeta(tenantId);
  if (meta.status !== 'ready' || meta.chunkCount <= 0) return [];
  // 各來源的 chunk 數：舊 meta 未帶此欄時不做逐格封鎖（全域的 status/chunkCount 守門仍在），
  // 下一次索引異動就會補上正確數字
  const counts: Record<SourceKey, number> = meta.chunkCountBySource ?? {
    website: meta.chunkCount,
    file: meta.chunkCount,
  };
  const guestScopes = new Set(guestVisibilityScopesOf(tenantId));
  const hasGuestContent: Record<SourceKey, boolean> = {
    website: currentChunkScopes(tenantId, {}).some((scope) => guestScopes.has(scope)),
    file: (meta.files ?? []).some((file) => (file.visibilityScopes ?? []).some((scope) => guestScopes.has(scope))),
  };
  const customPrompts = (meta.customSuggestedPrompts ?? [])
    .filter((prompt) => counts[prompt.source] > 0 && hasGuestContent[prompt.source])
    .map((prompt) => prompt.text);
  return [...effectivePrompts(publicPromptSlots(tenantId), counts), ...customPrompts];
}
