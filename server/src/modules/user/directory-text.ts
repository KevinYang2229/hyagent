/**
 * 目錄文字欄位能否安全存進快照（config 是 jsonb）。
 * NUL 與單獨的代理字元會讓 Postgres 拒絕寫入，而壞值留在記憶體裡會讓之後每一次
 * 寫入（含其他租戶、撤銷）都失敗，所以所有寫入目錄的路徑都要先過這關。
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// 高代理後面沒接低代理，或低代理前面沒有高代理
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function isStorableText(value: string): boolean {
  return !CONTROL.test(value) && !LONE_SURROGATE.test(value);
}
