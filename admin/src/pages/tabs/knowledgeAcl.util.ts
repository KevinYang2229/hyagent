/**
 * 知識庫可見性標籤／ACL 盤點用的純函式。與 server 端
 * `authz/scope-catalog.ts`（kbScopeId／assertValidLabelId）對應，
 * 前端這份只用來即時顯示與送出前檢查，最終仍以 server 驗證為準。
 */

/** 知識庫可見性標籤的 scope 前綴，需與 server 端 KB_SCOPE_PREFIX 同值 */
export const KB_SCOPE_PREFIX = 'kb:';

/** labelId → scope id（kb:<labelId>） */
export function kbScopeId(labelId: string): string {
  return `${KB_SCOPE_PREFIX}${labelId}`;
}

/** scope id → labelId；非 kb: 開頭者原樣回傳（防禦性處理，正常不會發生） */
export function stripKbPrefix(scope: string): string {
  return scope.startsWith(KB_SCOPE_PREFIX) ? scope.slice(KB_SCOPE_PREFIX.length) : scope;
}

/** labelId 格式：小寫英數與連字號，需與 server assertValidLabelId 的正規式同步 */
const LABEL_ID_RE = /^[a-z0-9-]+$/;
export function isValidLabelId(id: string): boolean {
  return LABEL_ID_RE.test(id);
}

/** 依 scope 找標籤顯示名稱；標籤已被刪除（孤兒 scope）時退回顯示 labelId 本身，不讓畫面空白 */
export function labelNameFor(labels: { id: string; label: string }[], scope: string): string {
  const labelId = stripKbPrefix(scope);
  return labels.find((l) => l.id === labelId)?.label ?? labelId;
}

/**
 * 某標籤目前套用在幾份檔案上。
 *
 * 刪除標籤前的確認對話框要顯示「N 份文件將回到未標記狀態」，但 DELETE API
 * 是刪除完成後才回報 affectedFiles——若等那時才知道數字，使用者已經按下確認、
 * 來不及反悔。前端已握有完整檔案清單（含 visibilityScopes），可以自己先算出來，
 * 讓確認對話框在動手前就給出準確數字。
 */
export function countFilesWithLabel(
  files: { visibilityScopes?: string[] }[],
  labelId: string,
): number {
  const scope = kbScopeId(labelId);
  return files.filter((f) => (f.visibilityScopes ?? []).includes(scope)).length;
}

/**
 * 檔案的標記狀態。
 * - unlabeled：visibilityScopes 從未設定（undefined）＝待辦，還沒人決定過。
 * - empty：已設定為空陣列＝明確決定「誰都不能看」，是已完成的決定。
 * - labeled：至少掛了一個標籤。
 *
 * unlabeled 與 empty 在檢索行為上效果相同（fail-closed 下都是無人可見），
 * 但語意不同——一個是待辦、一個是決定，UI 上不能混為一談。
 */
export type FileLabelState = 'unlabeled' | 'empty' | 'labeled';
export function fileLabelState(visibilityScopes: string[] | undefined): FileLabelState {
  if (visibilityScopes === undefined) return 'unlabeled';
  if (visibilityScopes.length === 0) return 'empty';
  return 'labeled';
}
