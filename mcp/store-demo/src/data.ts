/** 假資料載入與相對日期換算：任何一天 Demo 都有即期品與有效券。 */
import fs from 'node:fs';
import path from 'node:path';

export interface Product { id: string; name: string; category: string; aliases: string[]; stock: number; safetyStock: number; expiryInDays: number }
export interface Promotion { id: string; title: string; description: string; category: string; validFromDays: number; validToDays: number }
export interface Coupon {
  code: string; title: string; description: string; categories: string[]; productIds?: string[];
  validFromDays: number; validToDays: number; used: boolean; conditions: string;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
export const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')) as T;
}

export const products: Product[] = load<Product[]>('products.json');
export const promotions: Promotion[] = load<Promotion[]>('promotions.json');
export const coupons: Coupon[] = load<Coupon[]>('coupons.json');

const TZ = 'Asia/Taipei';

/** 以台北時區取「今天 + days」的 YYYY-MM-DD */
export function dateAfter(now: Date, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 掃描 assets 資料夾，回傳有圖片的商品 id 與副檔名 */
export function scanImages(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(ASSETS_DIR)) return out;
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    const m = /^(P\d+)\.(png|jpg|jpeg)$/i.exec(f);
    if (m) out.set(m[1], f);
  }
  return out;
}
