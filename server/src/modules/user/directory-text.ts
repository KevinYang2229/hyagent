/**
 * 目錄文字欄位能否安全存進快照（config 是 jsonb）。
 * Postgres jsonb 只拒絕 NUL（U+0000）與單獨的代理字元；壞值留在記憶體裡會讓之後每一次
 * 寫入（含其他租戶、撤銷）都失敗，所以所有寫入目錄的路徑都要先過這關。
 * 刻意只擋這兩種：Tab、換行等其他控制字元一直是合法資料，不能讓既有項目重新驗證失敗。
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function isStorableText(value: string): boolean {
  return !value.includes('\u0000') && !LONE_SURROGATE.test(value);
}
