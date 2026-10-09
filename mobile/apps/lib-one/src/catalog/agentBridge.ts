/**
 * 產品畫面與 HyAgent 之間的橋：AI 回覆提到哪些產品就在對話裡顯示產品卡，
 * 產品頁、比較頁的「問 HyAgent」要帶什麼問題也集中在這裡。
 */
import { PRODUCTS, SPEC_ROWS, getProduct, type Product, type SpecKey } from './catalog';

/** 比較最多幾項（平板一列三欄剛好） */
export const MAX_COMPARE = 3;

/** 沒有 AI 建議時，對話底部「你可能還想問」用的預設問題 */
export const DEFAULT_SUGGESTIONS = ['直立式與桌上型的差異？', '適合中小型圖書館的方案？', '需要哪些周邊設備？', '可以整合哪些系統？'];

/** 比較頁沒有選產品時的推薦組合：同類型、最常被拿來比較的產品 */
export const COMPARE_PRESETS: { title: string; hint: string; ids: string[] }[] = [
  { title: '直立式 vs 桌上型借還書機', hint: '依館舍空間挑選自助借還', ids: ['kiosk', 'desktop-kiosk'] },
  { title: '智慧閘門 vs 借閱通關系統', hint: '入館管理與借閱離館一次完成', ids: ['access-gate', 'checkout-gate'] },
  { title: '直立式 vs 桌上型座位預約機', hint: '閱覽區與櫃台的預約入口', ids: ['space-kiosk', 'desktop-space-kiosk'] },
  { title: '館員工作站 vs RFID 工作站', hint: '櫃台流通作業的兩種配置', ids: ['workstation', 'rfid-workstation'] },
];

/** 首頁與空白對話的熱門問題 */
export const HOT_QUESTIONS = ['有哪些自助借還書設備？', '中小型圖書館適合哪些設備？', '預約取書櫃怎麼運作？', '可以整合哪些圖書館系統？'];

function keywords(p: Product): string[] {
  return [p.name, p.nameEn, ...(p.aliases ?? [])];
}

/**
 * 回覆文字裡提到的產品，依第一次出現的位置排序、不重複。英文名稱不分大小寫。
 * 名稱有包含關係（Self-Service Kiosk ⊂ Desktop Self-Service Kiosk）：長的先比對，被它涵蓋的短比對不算。
 */
export function productsMentioned(text: string): Product[] {
  const lower = text.toLowerCase();
  const hits: { product: Product; start: number; end: number }[] = [];
  for (const product of PRODUCTS) {
    for (const k of keywords(product)) {
      const key = k.toLowerCase();
      for (let i = lower.indexOf(key); i >= 0; i = lower.indexOf(key, i + 1)) hits.push({ product, start: i, end: i + key.length });
    }
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start));
  const accepted: typeof hits = [];
  for (const h of hits) {
    if (!accepted.some((a) => a.start <= h.start && h.end <= a.end)) accepted.push(h);
  }
  const first = new Map<Product, number>();
  for (const a of accepted) first.set(a.product, Math.min(first.get(a.product) ?? Infinity, a.start));
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

export function askAboutProduct(p: Product): string {
  return `請介紹「${p.name}」的功能、規格與適用情境`;
}

export function askToCompare(products: Product[]): string {
  return `請比較${products.map((p) => `「${p.name}」`).join('、')}的差異，並建議各自適合哪種圖書館`;
}

/** 路由參數 ids=a,b,c → 有效、不重複、最多 MAX_COMPARE 項的產品 */
export function parseCompareIds(raw: string | string[] | undefined): Product[] {
  const ids = (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const result: Product[] = [];
  for (const id of ids) {
    const p = getProduct(id);
    if (p && !result.includes(p)) result.push(p);
    if (result.length === MAX_COMPARE) break;
  }
  return result;
}

export type CompareCell = { kind: 'yes' } | { kind: 'no' } | { kind: 'text'; text: string };

export function compareCell(value: string | boolean | undefined): CompareCell {
  if (value === true) return { kind: 'yes' };
  if (value === false || value === undefined || value === '') return { kind: 'no' };
  return { kind: 'text', text: value };
}

/** 比較表的列：至少一項產品有寫的欄位才列出 */
export function compareRows(products: Product[]): { key: SpecKey; label: string }[] {
  return SPEC_ROWS.filter((row) => products.some((p) => p.specs[row.key] !== undefined));
}
