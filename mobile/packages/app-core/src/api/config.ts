/** 使用者輸入的伺服器位址：去空白與結尾斜線，沒寫通訊協定時補 http://（區網 IP 常見寫法）。 */
export function normalizeServerUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}
