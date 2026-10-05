/** 商品名稱模糊比對：名稱或別名完全相同 1；包含關係 0.8；否則二字元組 Dice 係數。 */
import { products, type Product } from './data';

export const MATCH_THRESHOLD = 0.5;

function norm(s: string): string {
  return s.replace(/[\s\-－—_()（）]/g, '').replace(/團/g, '糰').toLowerCase();
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return a === b ? 1 : 0;
  const pool = [...y];
  let hit = 0;
  for (const g of x) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

function score(query: string, p: Product): number {
  const q = norm(query);
  let best = 0;
  for (const n of [p.name, ...p.aliases].map(norm)) {
    if (n === q) return 1;
    const s = n.includes(q) || q.includes(n) ? 0.8 : dice(q, n);
    if (s > best) best = s;
  }
  return best;
}

export function matchProduct(query: string): { product?: Product; score: number } {
  let best: Product | undefined;
  let bestScore = 0;
  for (const p of products) {
    const s = score(query, p);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? { product: best, score: Number(bestScore.toFixed(2)) } : { score: Number(bestScore.toFixed(2)) };
}
